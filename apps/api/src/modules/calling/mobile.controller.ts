import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Ip, NotFoundException, Param, Post, Put, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DbService } from '../../common/db.service';
import { ctx } from '../../common/context';
import { parse } from '../../common/errors';
import { authFor, tenantFeatures } from '../../common/auth-for';
import { contact, fieldAccess } from '../../common/field-access';
import { live } from '../../common/live';
import { storage } from '../../common/storage';
import { randomToken, sha256 } from '../../auth/crypto';
import { rateLimit } from '../integration-runtime';
import { ingestCall } from './call-pipeline';

const Pair = z.object({ org: z.string().trim().min(2).max(60), code: z.string().regex(/^\d{6}$/), deviceName: z.string().trim().min(1).max(60), platform: z.enum(['android', 'ios']).default('android'), appVersion: z.string().max(20).optional() });
const CallIn = z.object({
  externalId: z.string().trim().min(6).max(120), leadId: z.string().uuid().nullable().optional(), number: z.string().trim().min(3).max(30),
  direction: z.enum(['outbound', 'inbound']), startedAt: z.coerce.date(), ringSec: z.number().min(0).max(36_000).default(0), talkSec: z.number().min(0).max(36_000).default(0),
  answered: z.boolean(), disposition: z.string().max(60).nullable().optional(), remark: z.string().max(2000).nullable().optional(),
  followUpAt: z.coerce.date().nullable().optional(), updatedAt: z.coerce.date().nullable().optional(),
});
const Batch = z.object({ calls: z.array(CallIn).min(1).max(100), pending: z.number().int().min(0).max(100_000).optional() });
const Reconcile = z.object({ since: z.coerce.date(), externalIds: z.array(z.string().max(120)).max(5000) });
const MAX_RECORDING = 50 * 1024 * 1024;

/**
 * API for the SIM-calling phone app: `Authorization: Device <token>` after pairing with a 6-digit code from the web.
 * Calls are idempotent by externalId; reconciliation returns what the server is missing; recordings upload in
 * resumable chunks (`Content-Range: bytes <start>-<end>/<total>`).
 */
@Controller('mobile/v1')
export class MobileController {
  constructor(private db: DbService) {}

  @Post('pair')
  @HttpCode(200)
  async pair(@Body() body: unknown, @Ip() ip: string) {
    const input = parse(Pair, body);
    rateLimit(`pair:${ip}`, 10);
    const t = await this.db.app.tenant.findUnique({ where: { slug: input.org.toLowerCase() } });
    if (!t || !['active', 'trial'].includes(t.status)) throw new UnauthorizedException({ code: 'PAIRING_FAILED', message: 'Organization code or pairing code is wrong' });
    ctx().tenant = { id: t.id, slug: t.slug, name: t.name, status: t.status };
    return this.db.tenant(async (tx) => {
      if (!(await tenantFeatures(tx)).features.has('module.sim_calling')) throw new ForbiddenException({ code: 'PLAN_UPGRADE_REQUIRED', message: 'Your plan does not include SIM calling' });
      const pc = await tx.pairingCode.findFirst({ where: { codeHash: sha256(`${t.id}:${input.code}`), usedAt: null, expiresAt: { gt: new Date() } } });
      if (!pc || pc.attempts >= 5) throw new UnauthorizedException({ code: 'PAIRING_FAILED', message: 'Organization code or pairing code is wrong' });
      const user = await tx.user.findFirst({ where: { id: pc.userId, isActive: true } });
      if (!user) throw new UnauthorizedException({ code: 'PAIRING_FAILED', message: 'Organization code or pairing code is wrong' });
      await tx.pairingCode.update({ where: { id: pc.id }, data: { usedAt: new Date() } });
      // One active phone per person: pairing a new phone retires the old one.
      await tx.device.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      const token = `dev_${randomToken(32).replace(/[^A-Za-z0-9]/g, '')}`;
      const d = await tx.device.create({ data: { tenantId: t.id, userId: user.id, name: input.deviceName, platform: input.platform, appVersion: input.appVersion ?? null, tokenHash: sha256(token), lastSeenAt: new Date() } });
      await this.db.audit(tx, { actorType: 'tenant_user', actorId: user.id, entity: 'device', entityId: d.id, action: 'device.paired', newValue: { name: d.name, platform: d.platform } });
      return { deviceId: d.id, token, user: { id: user.id, name: user.name }, organization: t.name };
    });
  }

  /** My leads (open), today's follow-ups and tasks, call outcomes and scripts, and phone calls requested from the web. */
  @Get('sync')
  sync(@Headers('authorization') authz: string, @Query('since') since?: string) {
    return this.withDevice(authz, async (d) => this.db.tenant(async (tx) => {
      const now = new Date();
      const covering = (await tx.userCover.findMany({ where: { coverUserId: d.userId, cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now } } })).map((c) => c.userId);
      const openStages = (await tx.leadStage.findMany({ where: { isWon: false, isLost: false }, select: { id: true } })).map((s) => s.id);
      const changedSince = since ? new Date(since) : null;
      const leads = await tx.lead.findMany({
        where: {
          stageId: { in: openStages }, OR: [{ ownerId: { in: [d.userId, ...covering] } }, { teamMembers: { some: { userId: d.userId, removedAt: null } } }],
          ...(changedSince && !Number.isNaN(changedSince.getTime()) ? { updatedAt: { gt: changedSince } } : {}),
        },
        include: { customer: true }, orderBy: [{ nextFollowUpAt: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }], take: 1000,
      });
      const fa = await fieldAccess(tx);
      const wsIds = [...new Set(leads.map((l) => l.workspaceId))];
      const [dispositions, scripts, followUps, tasks, dials, settings, stages] = await Promise.all([
        tx.workspaceOption.findMany({ where: { kind: 'call_disposition', isArchived: false, workspaceId: { in: wsIds } }, orderBy: { position: 'asc' } }),
        tx.callScript.findMany({ where: { isArchived: false, workspaceId: { in: wsIds } } }),
        tx.followUp.findMany({ where: { userId: d.userId, doneAt: null, dueAt: { lt: new Date(now.getTime() + 86_400_000) } }, orderBy: { dueAt: 'asc' }, take: 300 }),
        tx.task.findMany({ where: { assigneeId: d.userId, doneAt: null, dueAt: { lt: new Date(now.getTime() + 86_400_000) } }, orderBy: { dueAt: 'asc' }, take: 300 }),
        tx.dialRequest.findMany({ where: { userId: d.userId, status: 'pending', createdAt: { gt: new Date(now.getTime() - 10 * 60_000) } }, orderBy: { createdAt: 'asc' } }),
        tx.organizationSetting.findFirst(),
        tx.leadStage.findMany({ where: { id: { in: [...new Set(leads.map((l) => l.stageId))] } }, select: { id: true, name: true } }),
      ]);
      await tx.dialRequest.updateMany({ where: { id: { in: dials.map((x) => x.id) } }, data: { status: 'picked', pickedAt: now } });
      await tx.device.update({ where: { id: d.id }, data: { lastSyncAt: now, lastSeenAt: now } });
      return {
        serverTime: now, dispositionRequired: !!settings?.dispositionRequired,
        // Personal calls stay on the phone unless the organization has chosen to capture unknown callers.
        captureUnknown: !!settings?.unknownCallerWorkspaceId,
        leads: leads.map((l) => ({
          id: l.id, workspaceId: l.workspaceId, name: l.customer.name, customerCode: l.customer.code,
          // The number the phone dials; the app shows only phoneDisplay (masked when the person's role hides numbers).
          dialNumber: l.customer.mobile, phoneDisplay: contact(fa, 'mobile', l.customer.mobile), stage: stages.find((s) => s.id === l.stageId)?.name ?? null,
          status: l.status, nextFollowUpAt: l.nextFollowUpAt, lastDisposition: l.lastDisposition, updatedAt: l.updatedAt,
        })),
        followUps: followUps.map((f) => ({ id: f.id, leadId: f.leadId, dueAt: f.dueAt, note: f.note })),
        tasks: tasks.map((t) => ({ id: t.id, leadId: t.leadId, type: t.type, title: t.title, dueAt: t.dueAt })),
        dispositions: dispositions.map((o) => ({ workspaceId: o.workspaceId, value: o.value, label: o.label, connected: o.connected, isDefault: o.isDefault })),
        scripts: scripts.map((s) => ({ workspaceId: s.workspaceId, stageId: s.stageId, title: s.title, body: s.body })),
        dial: dials.map((x) => ({ id: x.id, leadId: x.leadId, number: x.phone, requestedAt: x.createdAt })),
      };
    }));
  }

  @Post('calls')
  @HttpCode(200)
  calls(@Headers('authorization') authz: string, @Body() body: unknown) {
    const input = parse(Batch, body);
    return this.withDevice(authz, async (d) => {
      const settings = await this.db.tenant((tx) => tx.organizationSetting.findFirst());
      const results = [];
      for (const c of input.calls) {
        if (c.startedAt.getTime() > Date.now() + 10 * 60_000) { results.push({ externalId: c.externalId, status: 'rejected', error: 'Call time is in the future — check the phone clock' }); continue; }
        try {
          const r = await this.db.tenant((tx) => ingestCall(tx, { tenantId: d.tenantId, userId: d.userId, channel: 'sim', deviceId: d.id, unknownWorkspaceId: settings?.unknownCallerWorkspaceId ?? null }, {
            externalId: c.externalId, direction: c.direction, phone: c.number, startedAt: c.startedAt, ringSec: c.ringSec, talkSec: c.talkSec, answered: c.answered,
            leadId: c.leadId, disposition: c.disposition, remark: c.remark, followUpAt: c.followUpAt, clientUpdatedAt: c.updatedAt ?? null,
          }));
          r.live.forEach((e) => live.publish(d.tenantId, e));
          results.push({ externalId: r.externalId, status: r.status, callId: r.callId, leadId: r.leadId });
        } catch (e) {
          // Two copies of the same call racing each other: the unique index keeps one; report it as a duplicate.
          if ((e as { code?: string }).code === 'P2002') results.push({ externalId: c.externalId, status: 'duplicate' });
          else results.push({ externalId: c.externalId, status: 'rejected', error: e instanceof Error ? e.message.slice(0, 200) : 'Failed' });
        }
      }
      await this.db.tenant((tx) => tx.device.update({ where: { id: d.id }, data: { lastSeenAt: new Date(), ...(input.pending !== undefined ? { pendingCalls: input.pending } : {}) } }));
      return { results };
    });
  }

  /** The phone sends the keys of its recent calls; the answer lists the ones UBOS does not have yet. */
  @Post('calls/reconcile')
  @HttpCode(200)
  reconcile(@Headers('authorization') authz: string, @Body() body: unknown) {
    const input = parse(Reconcile, body);
    return this.withDevice(authz, (d) => this.db.tenant(async (tx) => {
      const have = new Set((await tx.call.findMany({ where: { externalId: { in: input.externalIds } }, select: { externalId: true } })).map((c) => c.externalId));
      await tx.device.update({ where: { id: d.id }, data: { lastSeenAt: new Date() } });
      return { missing: input.externalIds.filter((x) => !have.has(x)) };
    }));
  }

  /** How much of a recording the server already has (to resume an interrupted upload). */
  @Get('calls/:externalId/recording')
  recordingStatus(@Headers('authorization') authz: string, @Param('externalId') externalId: string) {
    return this.withDevice(authz, (d) => this.db.tenant(async (tx) => {
      const call = await this.myCall(tx, d, externalId);
      return { status: call.recordingStatus, received: call.recordingStatus === 'ready' ? call.recordingBytes : await storage.partSize(this.key(d.tenantId, call.id)) };
    }));
  }

  @Put('calls/:externalId/recording')
  upload(@Headers('authorization') authz: string, @Param('externalId') externalId: string, @Headers('content-range') range: string | undefined, @Headers('content-type') type: string | undefined, @Req() req: Request) {
    return this.withDevice(authz, async (d) => {
      const m = (range ?? '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!m) throw new BadRequestException({ code: 'RANGE_REQUIRED', message: 'Send Content-Range: bytes <start>-<end>/<total>' });
      const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (total > MAX_RECORDING || end < start || end >= total) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'Recording too large or range invalid (max 50 MB)' });
      if (!/^audio\/[a-z0-9.+-]+$/i.test(type ?? '')) throw new BadRequestException({ code: 'AUDIO_REQUIRED', message: 'Content-Type must be an audio type' });
      const call = await this.db.tenant((tx) => this.myCall(tx, d, externalId));
      if (call.recordingStatus === 'ready') return { status: 'ready', received: call.recordingBytes };
      const chunk = await readBody(req, end - start + 1);
      if (chunk.length !== end - start + 1) throw new BadRequestException({ code: 'SIZE_MISMATCH', message: 'The chunk size does not match Content-Range' });
      const k = this.key(d.tenantId, call.id);
      const received = await storage.appendPart(k, start, chunk);
      if (received < total) {
        await this.db.tenant((tx) => tx.call.update({ where: { id: call.id }, data: { recordingStatus: 'uploading', recordingTotal: total, recordingMime: type!.toLowerCase() } }));
        return { status: 'uploading', received };
      }
      const size = await storage.finishPart(k);
      await this.db.tenant((tx) => tx.call.update({ where: { id: call.id }, data: { recordingStatus: 'ready', recordingKey: k, recordingBytes: size, recordingTotal: total, recordingMime: type!.toLowerCase() } }));
      live.publish(d.tenantId, { type: 'call.updated', leadId: call.leadId, userId: call.userId, callId: call.id });
      return { status: 'ready', received: size };
    });
  }

  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(@Headers('authorization') authz: string, @Body() body: unknown) {
    const input = parse(z.object({ appVersion: z.string().max(20).optional(), pending: z.number().int().min(0).max(100_000).optional() }), body ?? {});
    return this.withDevice(authz, (d) => this.db.tenant(async (tx) => {
      await tx.device.update({ where: { id: d.id }, data: { lastSeenAt: new Date(), ...(input.appVersion ? { appVersion: input.appVersion } : {}), ...(input.pending !== undefined ? { pendingCalls: input.pending } : {}) } });
      return { ok: true, serverTime: new Date() };
    }));
  }

  // ── helpers ──

  private key(tenantId: string, callId: string) { return `${tenantId}/recordings/${callId}.rec`; }

  private async myCall(tx: Parameters<Parameters<DbService['tenant']>[0]>[0], d: { userId: string }, externalId: string) {
    const call = await tx.call.findFirst({ where: { externalId, userId: d.userId } });
    if (!call) throw new NotFoundException({ code: 'CALL_NOT_FOUND', message: 'Send the call before its recording' });
    return call;
  }

  /** Finds the phone by its token (across organizations), checks it is not revoked and the plan has SIM calling. */
  private async withDevice<T>(authz: string | undefined, fn: (d: { id: string; tenantId: string; userId: string }) => Promise<T>): Promise<T> {
    const raw = authz?.match(/^Device\s+(dev_[A-Za-z0-9]{20,})$/)?.[1];
    if (!raw) throw new UnauthorizedException({ code: 'DEVICE_TOKEN_REQUIRED', message: 'Send Authorization: Device <token>' });
    const d = await this.db.platform.device.findUnique({ where: { tokenHash: sha256(raw) } });
    if (!d || d.revokedAt) throw new UnauthorizedException({ code: 'DEVICE_REVOKED', message: 'This phone is no longer paired — pair it again' });
    const t = await this.db.platform.tenant.findUnique({ where: { id: d.tenantId } });
    const u = await this.db.platform.user.findUnique({ where: { id: d.userId } });
    if (!t || !['active', 'trial'].includes(t.status) || !u?.isActive) throw new UnauthorizedException({ code: 'DEVICE_REVOKED', message: 'This phone is no longer paired — pair it again' });
    const info = { id: t.id, slug: t.slug, name: t.name, status: t.status };
    ctx().tenant = info;
    rateLimit(`device:${d.id}`, 240);
    const a = await authFor(this.db, info, d.userId, `device:${d.id}`);
    if (!a.features.has('module.sim_calling')) throw new ForbiddenException({ code: 'PLAN_UPGRADE_REQUIRED', message: 'Your plan does not include SIM calling' });
    ctx().auth = a;
    return fn({ id: d.id, tenantId: d.tenantId, userId: d.userId });
  }
}

/** Reads a raw (non-JSON) request body, refusing anything larger than expected. */
function readBody(req: Request, expected: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > expected) { reject(new BadRequestException({ code: 'SIZE_MISMATCH', message: 'The chunk is larger than Content-Range says' })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
