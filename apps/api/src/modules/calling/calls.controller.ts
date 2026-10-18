import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Res, Sse, type MessageEvent } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { z } from 'zod';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, ctx, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { contact, fieldAccess } from '../../common/field-access';
import { live } from '../../common/live';
import { randomCode, sha256 } from '../../auth/crypto';
import { readConfig } from '../integration-runtime';
import { attachToLead } from './call-pipeline';
import { CallingService } from './calling.service';

const ListQuery = z.object({
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), userId: z.string().uuid().optional(), leadId: z.string().uuid().optional(),
  channel: z.enum(['sim', 'cloud', 'manual']).optional(), direction: z.enum(['outbound', 'inbound']).optional(), answered: z.enum(['true', 'false']).optional(),
  view: z.enum(['all', 'unmatched']).default('all'), limit: z.coerce.number().int().min(1).max(500).default(200),
});
const Dial = z.object({ via: z.enum(['phone', 'cloud']).optional() });

/** Calls of every channel: log with filters, recordings (permission + audit), unmatched calls, dialing, paired phones, live stream. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class CallsController {
  constructor(private db: DbService, private calling: CallingService) {}

  @Get('calls')
  @RequirePermission('crm.lead.view')
  list(@Query() query: unknown) {
    const q = parse(ListQuery, query);
    return this.db.tenant(async (tx) => {
      const a = auth();
      const where: Prisma.CallWhereInput = {
        ...(q.from || q.to ? { startedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
        ...(q.userId ? { userId: q.userId } : {}), ...(q.channel ? { channel: q.channel } : {}), ...(q.direction ? { direction: q.direction } : {}),
        ...(q.answered ? { answered: q.answered === 'true' } : {}), ...(q.leadId ? { leadId: q.leadId } : {}),
      };
      let rows;
      if (q.view === 'unmatched') {
        // Unmatched calls: the caller's own, or everyone's for people who can assign leads.
        rows = await tx.call.findMany({ where: { ...where, leadId: null, ...(a.permissions['crm.lead.assign'] ? {} : { userId: a.userId }) }, orderBy: { startedAt: 'desc' }, take: q.limit });
      } else {
        const leads = await tx.lead.findMany({ where: { AND: [await scopeFilter(tx, 'crm.lead.view'), ...(q.leadId ? [{ id: q.leadId }] : [])] }, select: { id: true }, take: 50_000 });
        rows = await tx.call.findMany({ where: { ...where, OR: [{ leadId: { in: leads.map((l) => l.id) } }, { leadId: null, userId: a.userId }] }, orderBy: { startedAt: 'desc' }, take: q.limit });
      }
      const fa = await fieldAccess(tx);
      const [users, leadRows, opts] = await Promise.all([
        tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId).filter(Boolean) as string[])] } }, select: { id: true, name: true } }),
        tx.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId).filter(Boolean) as string[] } }, select: { id: true, workspaceId: true, customer: { select: { name: true } } } }),
        tx.workspaceOption.findMany({ where: { kind: 'call_disposition' }, select: { workspaceId: true, value: true, label: true } }),
      ]);
      const canListen = !!a.permissions['crm.call.recording'];
      return rows.map((r) => ({
        id: r.id, channel: r.channel, provider: r.provider, direction: r.direction, phone: contact(fa, 'mobile', r.phone), startedAt: r.startedAt, ringSec: r.ringSec, talkSec: r.talkSec,
        answered: r.answered, disposition: r.disposition, dispositionLabel: opts.find((o) => o.workspaceId === r.workspaceId && o.value === r.disposition)?.label ?? r.disposition,
        remark: r.remark, leadId: r.leadId, customerName: leadRows.find((l) => l.id === r.leadId)?.customer.name ?? null, userId: r.userId,
        userName: users.find((u) => u.id === r.userId)?.name ?? null, recording: r.recordingStatus, canListen: canListen && ['ready', 'link'].includes(r.recordingStatus),
      }));
    });
  }

  /** Plays a recording (decrypted on the fly) or opens the provider's link. Needs the listening permission; audited. */
  @Get('calls/:id/recording')
  @RequirePermission('crm.call.recording')
  async recording(@Param('id') id: string, @Res() res: Response, @Query('as') as?: string) {
    const call = await this.db.tenant(async (tx) => {
      const c = await this.visibleCall(tx, id, 'crm.call.recording');
      await this.db.audit(tx, { workspaceId: c.workspaceId, entity: 'call', entityId: id, action: 'call.recording_played', newValue: { leadId: c.leadId } });
      return c;
    });
    const r = await this.calling.recording(call);
    if (!r) throw new NotFoundException({ code: 'NO_RECORDING', message: 'This call has no recording' });
    // Browsers cannot follow a cross-site redirect with fetch: ?as=json returns the provider link instead.
    if ('link' in r) return as === 'json' ? res.json({ url: r.link }) : res.redirect(302, r.link!);
    res.setHeader('Content-Type', r.mime);
    res.setHeader('Content-Length', String(r.data.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    return res.end(r.data);
  }

  /** Puts an unmatched call on a lead. */
  @Post('calls/:id/link')
  @RequirePermission('crm.lead.update')
  link(@Param('id') id: string, @Body() body: unknown) {
    const { leadId } = parse(z.object({ leadId: z.string().uuid() }), body);
    return this.db.tenant(async (tx) => {
      const call = await tx.call.findUnique({ where: { id } });
      if (!call || (call.userId !== auth().userId && !auth().permissions['crm.lead.assign'])) throw new NotFoundException({ code: 'CALL_NOT_FOUND', message: 'Call not found' });
      if (call.leadId) throw new BadRequestException({ code: 'ALREADY_LINKED', message: 'This call is already on a lead' });
      const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.lead.update'), { id: leadId }] } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      await attachToLead(tx, call.id, lead, call.userId ?? auth().userId);
      await this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'call', entityId: id, action: 'call.linked', newValue: { leadId } });
      live.publish(tenantId(), { type: 'call.logged', leadId, userId: call.userId, callId: id });
      return { ok: true };
    });
  }

  /** "Call" on a lead: the person's paired phone dials it (SIM), or the cloud provider connects them. */
  @Post('leads/:id/dial')
  @RequirePermission('crm.lead.update')
  async dial(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Dial, body ?? {});
    const a = auth();
    const { lead, device, cloud, me } = await this.db.tenant(async (tx) => {
      const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.lead.update'), { id }] }, include: { customer: true } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      if (!lead.customer.mobile) throw new BadRequestException({ code: 'NO_NUMBER', message: 'This lead has no mobile number' });
      const device = a.features.has('module.sim_calling') ? await tx.device.findFirst({ where: { userId: a.userId, revokedAt: null } }) : null;
      const conn = a.features.has('module.telephony') ? await tx.integrationConnection.findFirst({ where: { key: 'callerdesk', workspaceId: null, status: 'active' } }) : null;
      const me = await tx.user.findUniqueOrThrow({ where: { id: a.userId } });
      return { lead, device, cloud: conn ? readConfig(conn.configEncrypted) : null, me };
    });
    const via = input.via ?? (device ? 'phone' : cloud ? 'cloud' : null);
    if (via === 'phone') {
      if (!device) throw new BadRequestException({ code: 'NO_PHONE', message: 'Pair your phone first (My Security → My phone)' });
      const r = await this.db.tenant(async (tx) => {
        await tx.dialRequest.updateMany({ where: { userId: a.userId, status: 'pending' }, data: { status: 'expired' } });
        return tx.dialRequest.create({ data: { tenantId: tenantId(), userId: a.userId, leadId: lead.id, phone: lead.customer.mobile! } });
      });
      live.publish(tenantId(), { type: 'dial.requested', leadId: lead.id, userId: a.userId });
      return { via: 'phone', requestId: r.id, message: `Your phone (${device.name}) will dial ${lead.customer.name}` };
    }
    if (via === 'cloud') {
      if (!cloud) throw new BadRequestException({ code: 'NO_CLOUD', message: 'Cloud calling (CallerDesk) is not set up' });
      if (!me.mobile) throw new BadRequestException({ code: 'NO_AGENT_NUMBER', message: 'Add your mobile number to your user profile — CallerDesk rings it first' });
      await this.calling.clickToCall(cloud, me.mobile, lead.customer.mobile!);
      await this.db.tenant((tx) => this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'lead', entityId: lead.id, action: 'call.click_to_call', newValue: { provider: 'callerdesk' } }));
      return { via: 'cloud', message: `CallerDesk is ringing your phone; ${lead.customer.name} is connected when you answer` };
    }
    throw new BadRequestException({ code: 'NO_CALLING', message: 'Pair your phone or set up cloud calling to call from UBOS' });
  }

  // ── Phones ──

  /** A 6-digit code (10 minutes) to pair the phone app with this person. */
  @Post('devices/pair-code')
  @RequireFeature('module.sim_calling')
  async pairCode() {
    const code = randomCode();
    return this.db.tenant(async (tx) => {
      await tx.pairingCode.updateMany({ where: { userId: auth().userId, usedAt: null }, data: { usedAt: new Date() } });
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      await tx.pairingCode.create({ data: { tenantId: tenantId(), userId: auth().userId, codeHash: sha256(`${tenantId()}:${code}`), expiresAt } });
      return { code, expiresAt, org: ctx().tenant!.slug };
    });
  }

  @Get('devices')
  devices(@Query('all') all?: string) {
    return this.db.tenant(async (tx) => {
      const everyone = all === 'true' && !!auth().permissions['org.user.manage'];
      const rows = await tx.device.findMany({ where: everyone ? {} : { userId: auth().userId }, orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }], take: 500 });
      const users = await tx.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true } });
      return rows.map(({ tokenHash: _t, ...d }) => ({ ...d, userName: users.find((u) => u.id === d.userId)?.name ?? '' }));
    });
  }

  @Post('devices/:id/revoke')
  revoke(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const d = await tx.device.findUnique({ where: { id } });
      if (!d) throw new NotFoundException({ code: 'DEVICE_NOT_FOUND', message: 'Phone not found' });
      if (d.userId !== auth().userId && !auth().permissions['org.user.manage']) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You can unpair only your own phone' });
      if (!d.revokedAt) await tx.device.update({ where: { id }, data: { revokedAt: new Date(), revokedById: auth().userId } });
      await this.db.audit(tx, { entity: 'device', entityId: id, action: 'device.revoked', oldValue: { name: d.name, userId: d.userId } });
      return { ok: true };
    });
  }

  // ── Live updates ──

  /** Server-sent events for open browsers: ids only — the page re-reads through the normal API. */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const t = tenantId();
    return new Observable<MessageEvent>((sub) => {
      const off = live.subscribe(t, (e) => sub.next({ type: e.type, data: e }));
      const ping = setInterval(() => sub.next({ type: 'ping', data: {} }), 25_000);
      return () => { off(); clearInterval(ping); };
    });
  }

  private async visibleCall(tx: Tx, id: string, perm: 'crm.lead.view' | 'crm.call.recording') {
    const c = await tx.call.findUnique({ where: { id } });
    if (!c) throw new NotFoundException({ code: 'CALL_NOT_FOUND', message: 'Call not found' });
    if (c.leadId) {
      const ok = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, perm), { id: c.leadId }] }, select: { id: true } });
      if (!ok) throw new NotFoundException({ code: 'CALL_NOT_FOUND', message: 'Call not found' });
    } else if (c.userId !== auth().userId && !auth().permissions['crm.lead.assign']) throw new NotFoundException({ code: 'CALL_NOT_FOUND', message: 'Call not found' });
    return c;
  }
}
