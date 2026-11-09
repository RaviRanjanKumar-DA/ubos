import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { contact, fieldAccess } from '../../common/field-access';
import { activity, addLeadFollowUp, syncNextFollowUp } from '../../common/lead-ops';
import { istStamp } from '../../common/ist';
import { toCsv } from '@ubos/shared';
import { createManualCall } from './call-pipeline';

const MAX_LEADS = 5000;
const CLAIM_MS = 30 * 60_000;
const list = (n: number) => z.array(z.string().max(60)).max(n).default([]);
const Filter = z.object({ stageIds: list(50), statuses: list(50), sources: list(50), owners: list(200), dispositions: list(50), contacted: z.enum(['any', 'no', 'yes']).default('any') });
const Settings = { agentIds: z.array(z.string().uuid()).min(1).max(50), maxAttempts: z.number().int().min(1).max(10), retryAfterMin: z.number().int().min(5).max(10_080) };
const Create = z.object({ name: z.string().trim().min(2).max(80), filter: Filter, maxAttempts: Settings.maxAttempts.default(3), retryAfterMin: Settings.retryAfterMin.default(60), agentIds: Settings.agentIds });
const Update = z.object({ name: z.string().trim().min(2).max(80).optional(), agentIds: Settings.agentIds.optional(), maxAttempts: Settings.maxAttempts.optional(), retryAfterMin: Settings.retryAfterMin.optional(), status: z.enum(['active', 'paused']).optional(), archived: z.literal(true).optional() });
const Outcome = z.object({ disposition: z.string().min(1).max(60), remark: z.string().trim().max(2000).optional(), durationSec: z.number().int().min(0).max(36_000).optional(), followUpAt: z.coerce.date().optional(), followUpNote: z.string().trim().max(300).optional() });

/** Calling campaigns: a list of leads worked one at a time, with a required outcome after every call, retries and reports. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class CampaignsController {
  constructor(private db: DbService) {}

  @Get('call-campaigns/options')
  @RequirePermission('crm.lead.view')
  options() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const [pipelines, opts, users] = await Promise.all([
        tx.pipeline.findMany({ where: { workspaceId: ws }, include: { stages: { orderBy: { position: 'asc' } } } }),
        tx.workspaceOption.findMany({ where: { workspaceId: ws, isArchived: false } }),
        this.workspaceUsers(tx, ws),
      ]);
      const of = (kind: string) => opts.filter((o) => o.kind === kind).map((o) => ({ value: o.value, label: o.label }));
      return {
        canManage: this.canManage(ws), users: users.map((u) => ({ value: u.id, label: u.name })), statuses: of('lead_status'), sources: of('lead_source'), dispositions: of('call_disposition'),
        stages: pipelines.flatMap((p) => p.stages.filter((s) => !s.isWon && !s.isLost).map((s) => ({ value: s.id, label: pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name }))),
      };
    });
  }

  /** Managers see every campaign of the business line; callers see the ones they are on. */
  @Get('call-campaigns')
  @RequirePermission('crm.lead.view')
  list() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const me = auth().userId;
      const rows = await tx.callCampaign.findMany({ where: { workspaceId: ws, isArchived: false, ...(this.canManage(ws) ? {} : { agentIds: { has: me } }) }, orderBy: { createdAt: 'desc' }, take: 200 });
      const counts = await tx.callCampaignItem.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: rows.map((r) => r.id) } }, _count: true });
      const open = await tx.callCampaignItem.findFirst({ where: { agentId: me, status: 'active' }, select: { campaignId: true } });
      const people = await tx.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.agentIds))] } }, select: { id: true, name: true } });
      return rows.map((r) => {
        const n = (s: string) => counts.find((c) => c.campaignId === r.id && c.status === s)?._count ?? 0;
        return {
          id: r.id, name: r.name, status: r.status, maxAttempts: r.maxAttempts, retryAfterMin: r.retryAfterMin, agentIds: r.agentIds, agents: people.filter((p) => r.agentIds.includes(p.id)).map((p) => p.name), createdAt: r.createdAt,
          pending: n('pending'), active: n('active'), done: n('done'), closed: n('closed'), isAgent: r.agentIds.includes(me), hasMyOpenCall: open?.campaignId === r.id, canManage: this.canManage(r.workspaceId),
        };
      });
    });
  }

  /** How many leads a filter would put in a campaign. */
  @Post('call-campaigns/preview')
  @RequirePermission('crm.campaign.manage')
  preview(@Body() body: unknown) {
    const filter = parse(Filter, body);
    const ws = this.ws();
    this.assertManage(ws);
    return this.db.tenant(async (tx) => ({ leads: await tx.lead.count({ where: await this.leadWhere(tx, ws, filter) }), max: MAX_LEADS }));
  }

  @Post('call-campaigns')
  @RequirePermission('crm.campaign.manage')
  create(@Body() body: unknown) {
    const input = parse(Create, body);
    const ws = this.ws();
    this.assertManage(ws);
    return this.db.tenant(async (tx) => {
      await this.assertAgents(tx, ws, input.agentIds);
      const leads = await tx.lead.findMany({ where: await this.leadWhere(tx, ws, input.filter), select: { id: true }, orderBy: { createdAt: 'desc' }, take: MAX_LEADS + 1 });
      if (!leads.length) throw new BadRequestException({ code: 'NO_LEADS', message: 'No leads with a mobile number match this list' });
      if (leads.length > MAX_LEADS) throw new BadRequestException({ code: 'TOO_MANY_LEADS', message: `A campaign can hold up to ${MAX_LEADS} leads. Narrow the list.` });
      const c = await tx.callCampaign.create({ data: { tenantId: tenantId(), workspaceId: ws, name: input.name, agentIds: [...new Set(input.agentIds)], maxAttempts: input.maxAttempts, retryAfterMin: input.retryAfterMin, filter: input.filter, createdById: auth().userId } });
      await tx.callCampaignItem.createMany({ data: leads.map((l, i) => ({ tenantId: tenantId(), campaignId: c.id, leadId: l.id, position: i })) });
      await this.db.audit(tx, { workspaceId: ws, entity: 'call_campaign', entityId: c.id, action: 'campaign.created', newValue: { name: c.name, leads: leads.length, agents: c.agentIds.length } });
      return { id: c.id, leads: leads.length };
    });
  }

  @Patch('call-campaigns/:id')
  @RequirePermission('crm.campaign.manage')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Update, body);
    return this.db.tenant(async (tx) => {
      const c = await this.campaign(tx, id);
      this.assertManage(c.workspaceId);
      if (input.agentIds) await this.assertAgents(tx, c.workspaceId, input.agentIds);
      if (input.status && c.status === 'completed') throw new BadRequestException({ code: 'CAMPAIGN_COMPLETED', message: 'This campaign is already complete' });
      if (input.archived && await tx.callCampaignItem.count({ where: { campaignId: id, status: 'active' } })) throw new BadRequestException({ code: 'CALLS_OPEN', message: 'Someone still has an open call in this campaign. Release it first.' });
      const { archived, agentIds, ...rest } = input;
      await tx.callCampaign.update({ where: { id }, data: { ...rest, ...(agentIds ? { agentIds: [...new Set(agentIds)] } : {}), ...(archived ? { isArchived: true } : {}) } });
      await this.db.audit(tx, { workspaceId: c.workspaceId, entity: 'call_campaign', entityId: id, action: archived ? 'campaign.archived' : 'campaign.updated', oldValue: { status: c.status, maxAttempts: c.maxAttempts, retryAfterMin: c.retryAfterMin }, newValue: input });
      return { ok: true };
    });
  }

  // ── The dialer ──

  /** The caller's next lead. An open call comes back first: nobody moves on before saving the outcome of a dialed call. */
  @Post('call-campaigns/:id/next')
  @RequirePermission('crm.lead.update')
  async next(@Param('id') id: string) {
    const run = () => this.db.tenant((tx) => this.claimNext(tx, id));
    // Two clicks at once: the database lets one claim win, and the other simply returns that same open call.
    try { return await run(); } catch (e) { if ((e as { code?: string }).code === 'P2002') return run(); throw e; }
  }

  private async claimNext(tx: Tx, id: string) {
    const c = await this.campaign(tx, id);
    const me = auth().userId;
    if (!c.agentIds.includes(me)) throw new ForbiddenException({ code: 'NOT_ON_CAMPAIGN', message: 'You are not a caller on this campaign' });
    const now = new Date();
    const open = await tx.callCampaignItem.findFirst({ where: { agentId: me, status: 'active' }, include: { campaign: { select: { name: true } } } });
    if (open?.campaignId === id) return this.view(tx, c, open.id);
    if (open?.dialedAt) throw new ConflictException({ code: 'OUTCOME_REQUIRED', message: `Save the outcome of your open call in “${open.campaign.name}” first`, campaignId: open.campaignId });
    if (open) await this.release(tx, open.id);
    if (c.status !== 'active') return { item: null, reason: c.status, ...(await this.progress(tx, id)) };

    // Leads claimed but never dialed go back in the queue; won or lost leads leave it.
    await tx.callCampaignItem.updateMany({ where: { campaignId: id, status: 'active', dialedAt: null, lockedUntil: { lt: now } }, data: { status: 'pending', agentId: null, lockedUntil: null, claimedAt: null } });
    const closedStages = await tx.leadStage.findMany({ where: { OR: [{ isWon: true }, { isLost: true }] }, select: { id: true } });
    await tx.callCampaignItem.updateMany({ where: { campaignId: id, status: 'pending', lead: { stageId: { in: closedStages.map((s) => s.id) } } }, data: { status: 'closed' } });

    // A campaign never widens access: each caller receives only leads they can already work on.
    const scope = await scopeFilter(tx, 'crm.lead.update');
    const candidates = await tx.callCampaignItem.findMany({ where: { campaignId: id, status: 'pending', nextAt: { lte: now }, lead: scope }, orderBy: { position: 'asc' }, take: 10, select: { id: true } });
    for (const x of candidates) {
      const got = await tx.callCampaignItem.updateMany({ where: { id: x.id, status: 'pending' }, data: { status: 'active', agentId: me, claimedAt: now, lockedUntil: new Date(now.getTime() + CLAIM_MS), dialedAt: null } });
      if (got.count) return this.view(tx, c, x.id);
    }
    await this.completeIfEmpty(tx, id);
    const later = await tx.callCampaignItem.findFirst({ where: { campaignId: id, status: 'pending', nextAt: { gt: now }, lead: scope }, orderBy: { nextAt: 'asc' }, select: { nextAt: true } });
    const others = await tx.callCampaignItem.count({ where: { campaignId: id, status: 'pending', nextAt: { lte: now } } });
    return { item: null, reason: later ? 'retry_later' : others ? 'not_your_leads' : 'finished', retryAt: later?.nextAt ?? null, ...(await this.progress(tx, id)) };
  }

  /** Called when the person presses Call: from here on the outcome is required. */
  @Post('call-campaigns/items/:id/dialed')
  @RequirePermission('crm.lead.update')
  dialed(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const item = await this.myItem(tx, id);
      if (!item.dialedAt) await tx.callCampaignItem.update({ where: { id }, data: { dialedAt: new Date(), lockedUntil: null } });
      return { ok: true };
    });
  }

  /** Puts a lead that was not dialed back for later, without counting an attempt. */
  @Post('call-campaigns/items/:id/skip')
  @RequirePermission('crm.lead.update')
  skip(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const item = await this.myItem(tx, id);
      if (item.dialedAt) throw new ConflictException({ code: 'OUTCOME_REQUIRED', message: 'You called this lead. Save the outcome first.' });
      const c = await this.campaign(tx, item.campaignId);
      await tx.callCampaignItem.update({ where: { id }, data: { status: 'pending', agentId: null, claimedAt: null, lockedUntil: null, nextAt: new Date(Date.now() + c.retryAfterMin * 60_000) } });
      return { ok: true };
    });
  }

  /** The required outcome. Not connected calls come back after the retry gap until the attempts run out. */
  @Post('call-campaigns/items/:id/outcome')
  @RequirePermission('crm.lead.update')
  outcome(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Outcome, body);
    return this.db.tenant(async (tx) => {
      const me = auth().userId;
      const item = await this.myItem(tx, id);
      const c = await this.campaign(tx, item.campaignId);
      // Not re-checked against scope: if the lead was reassigned during the call, its outcome must still be saved.
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: item.leadId } });
      const opt = await tx.workspaceOption.findFirst({ where: { workspaceId: lead.workspaceId, kind: 'call_disposition', value: input.disposition, isArchived: false } });
      if (!opt) throw new BadRequestException({ code: 'INVALID_DISPOSITION', message: 'Choose a call disposition' });
      const now = new Date();
      // The phone app or provider may already have reported this call; otherwise it is logged now and matched when it arrives.
      const real = await tx.call.findFirst({ where: { leadId: lead.id, userId: me, channel: { not: 'manual' }, direction: 'outbound', startedAt: { gte: new Date((item.claimedAt ?? now).getTime() - 60_000) } }, orderBy: { startedAt: 'desc' } });
      let callId: string;
      if (real) {
        await tx.call.update({ where: { id: real.id }, data: { disposition: opt.value, remark: input.remark ?? real.remark, campaignId: c.id } });
        if (real.activityId) await tx.leadActivity.update({ where: { id: real.activityId }, data: { disposition: opt.value, connected: opt.connected, remark: input.remark ?? real.remark } });
        callId = real.id;
      } else {
        const act = await tx.leadActivity.create({ data: activity(lead, me, { type: 'call', disposition: opt.value, connected: opt.connected, durationSec: input.durationSec ?? null, remark: input.remark ?? null }) });
        callId = (await createManualCall(tx, lead, act.id, me, { disposition: opt.value, connected: opt.connected, durationSec: input.durationSec ?? 0, remark: input.remark ?? null, campaignId: c.id })).id;
      }
      await tx.followUp.updateMany({ where: { leadId: lead.id, doneAt: null, dueAt: { lte: new Date(now.getTime() + 3_600_000) } }, data: { doneAt: now, outcome: opt.value } });
      if (input.followUpAt) await addLeadFollowUp(tx, lead, me, input.followUpAt, input.followUpNote);
      await tx.lead.update({ where: { id: lead.id }, data: { lastActivityAt: now, lastDisposition: opt.value, ...(!lead.firstResponseAt ? { firstResponseAt: now } : {}) } });
      await syncNextFollowUp(tx, lead.id);

      const attempts = item.attempts + 1;
      const retry = !opt.connected && attempts < c.maxAttempts && !input.followUpAt;
      await tx.callCampaignItem.update({ where: { id }, data: { status: retry ? 'pending' : 'done', attempts, nextAt: retry ? new Date(now.getTime() + c.retryAfterMin * 60_000) : item.nextAt, callId, lastDisposition: opt.value, connected: opt.connected, lastAt: now, lockedUntil: null, dialedAt: null } });
      if (!retry) await this.completeIfEmpty(tx, c.id);
      return { ok: true, willRetry: retry };
    });
  }

  /** A manager frees a call someone left open (for example, they went home). */
  @Post('call-campaigns/items/:id/release')
  @RequirePermission('crm.campaign.manage')
  releaseItem(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const item = await tx.callCampaignItem.findUnique({ where: { id } });
      if (!item) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Lead not found in this campaign' });
      const c = await this.campaign(tx, item.campaignId);
      this.assertManage(c.workspaceId);
      if (item.status !== 'active') throw new BadRequestException({ code: 'NOT_OPEN', message: 'This call is not open' });
      await this.release(tx, id);
      await this.db.audit(tx, { workspaceId: c.workspaceId, entity: 'call_campaign', entityId: c.id, action: 'campaign.call_released', oldValue: { leadId: item.leadId, agentId: item.agentId } });
      return { ok: true };
    });
  }

  // ── Reports ──

  @Get('call-campaigns/:id/report')
  @RequirePermission('crm.campaign.manage')
  report(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.campaign(tx, id);
      this.assertManage(c.workspaceId);
      const [counts, calls, open, opts] = await Promise.all([
        tx.callCampaignItem.groupBy({ by: ['status'], where: { campaignId: id }, _count: true }),
        tx.call.findMany({ where: { campaignId: id }, select: { userId: true, answered: true, talkSec: true, disposition: true }, take: 50_000 }),
        tx.callCampaignItem.findMany({ where: { campaignId: id, status: 'active' }, include: { lead: { select: { customer: { select: { name: true } } } } }, orderBy: { claimedAt: 'asc' } }),
        tx.workspaceOption.findMany({ where: { workspaceId: c.workspaceId, kind: 'call_disposition' }, select: { value: true, label: true } }),
      ]);
      const ids = [...new Set([...calls.map((x) => x.userId), ...open.map((x) => x.agentId)].filter(Boolean) as string[])];
      const people = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      const nameOf = (u: string | null) => people.find((p) => p.id === u)?.name ?? '—';
      const n = (s: string) => counts.find((x) => x.status === s)?._count ?? 0;
      const byAgent = new Map<string, { userId: string | null; name: string; calls: number; connected: number; talkSec: number }>();
      const byOutcome = new Map<string, number>();
      for (const x of calls) {
        const k = x.userId ?? '-';
        const row = byAgent.get(k) ?? { userId: x.userId, name: nameOf(x.userId), calls: 0, connected: 0, talkSec: 0 };
        row.calls++; row.connected += x.answered ? 1 : 0; row.talkSec += x.talkSec;
        byAgent.set(k, row);
        if (x.disposition) byOutcome.set(x.disposition, (byOutcome.get(x.disposition) ?? 0) + 1);
      }
      const connected = calls.filter((x) => x.answered).length;
      return {
        id: c.id, name: c.name, status: c.status, maxAttempts: c.maxAttempts, retryAfterMin: c.retryAfterMin,
        totals: { leads: counts.reduce((s, x) => s + x._count, 0), pending: n('pending'), active: n('active'), done: n('done'), closed: n('closed'), calls: calls.length, connected, talkSec: calls.reduce((s, x) => s + x.talkSec, 0), connectRate: calls.length ? Math.round((connected / calls.length) * 100) : 0 },
        byAgent: [...byAgent.values()].sort((a, b) => b.calls - a.calls),
        byOutcome: [...byOutcome.entries()].map(([value, count]) => ({ value, label: opts.find((o) => o.value === value)?.label ?? value, count })).sort((a, b) => b.count - a.count),
        open: open.map((x) => ({ id: x.id, customerName: x.lead.customer.name, agentName: nameOf(x.agentId), claimedAt: x.claimedAt, dialedAt: x.dialedAt })),
      };
    });
  }

  @Get('call-campaigns/:id/export')
  @RequirePermission('crm.lead.export')
  async export(@Param('id') id: string, @Res() res: Response) {
    const rows = await this.db.tenant(async (tx) => {
      const c = await this.campaign(tx, id);
      this.assertManage(c.workspaceId);
      const items = await tx.callCampaignItem.findMany({ where: { campaignId: id }, include: { lead: { select: { customer: { select: { code: true, name: true, mobile: true } } } } }, orderBy: { position: 'asc' }, take: MAX_LEADS });
      const [fa, people, opts] = await Promise.all([
        fieldAccess(tx),
        tx.user.findMany({ where: { id: { in: items.map((i) => i.agentId).filter(Boolean) as string[] } }, select: { id: true, name: true } }),
        tx.workspaceOption.findMany({ where: { workspaceId: c.workspaceId, kind: 'call_disposition' }, select: { value: true, label: true } }),
      ]);
      await this.db.audit(tx, { workspaceId: c.workspaceId, entity: 'call_campaign', entityId: id, action: 'campaign.exported', newValue: { rows: items.length } });
      return [
        ['Customer ID', 'Name', 'Mobile', 'Queue status', 'Attempts', 'Last outcome', 'Connected', 'Last called (IST)', 'Caller'],
        ...items.map((i) => [i.lead.customer.code, i.lead.customer.name, contact(fa, 'mobile', i.lead.customer.mobile) ?? '', i.status, i.attempts, opts.find((o) => o.value === i.lastDisposition)?.label ?? i.lastDisposition ?? '', i.connected === null ? '' : i.connected ? 'Yes' : 'No', i.lastAt ? istStamp(i.lastAt) : '', people.find((p) => p.id === i.agentId)?.name ?? '']),
      ];
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="campaign.csv"');
    res.send('﻿' + toCsv(rows));
  }

  // ── Helpers ──

  private async view(tx: Tx, c: { id: string; maxAttempts: number; workspaceId: string; name: string }, itemId: string) {
    const item = await tx.callCampaignItem.findUniqueOrThrow({ where: { id: itemId }, include: { lead: { include: { customer: true } } } });
    const [fa, stage, opts, script, progress] = await Promise.all([
      fieldAccess(tx),
      tx.leadStage.findUnique({ where: { id: item.lead.stageId }, select: { name: true } }),
      tx.workspaceOption.findMany({ where: { workspaceId: c.workspaceId, kind: { in: ['call_disposition', 'lead_status', 'lead_source'] } } }),
      tx.callScript.findFirst({ where: { workspaceId: c.workspaceId, isArchived: false, OR: [{ stageId: item.lead.stageId }, { stageId: null }] }, orderBy: { stageId: { sort: 'desc', nulls: 'last' } } }),
      this.progress(tx, c.id),
    ]);
    const label = (kind: string, v: string | null) => opts.find((o) => o.kind === kind && o.value === v)?.label ?? v;
    return {
      item: {
        id: item.id, leadId: item.leadId, name: item.lead.customer.name, mobile: contact(fa, 'mobile', item.lead.customer.mobile), city: item.lead.customer.city ?? null, stage: stage?.name ?? '', status: label('lead_status', item.lead.status), source: label('lead_source', item.lead.source),
        lastOutcome: label('call_disposition', item.lastDisposition ?? item.lead.lastDisposition), lastActivityAt: item.lead.lastActivityAt, attempt: item.attempts + 1, maxAttempts: c.maxAttempts, dialed: !!item.dialedAt, script: script ? { title: script.title, body: script.body } : null,
      },
      dispositions: opts.filter((o) => o.kind === 'call_disposition' && !o.isArchived).map((o) => ({ value: o.value, label: o.label, connected: o.connected })),
      ...progress,
    };
  }

  private async progress(tx: Tx, id: string) {
    const counts = await tx.callCampaignItem.groupBy({ by: ['status'], where: { campaignId: id }, _count: true });
    const total = counts.reduce((s, x) => s + x._count, 0);
    const finished = counts.filter((x) => x.status === 'done' || x.status === 'closed').reduce((s, x) => s + x._count, 0);
    return { total, finished };
  }

  private async completeIfEmpty(tx: Tx, id: string) {
    const left = await tx.callCampaignItem.count({ where: { campaignId: id, status: { in: ['pending', 'active'] } } });
    if (!left) await tx.callCampaign.updateMany({ where: { id, status: { not: 'completed' } }, data: { status: 'completed' } });
  }

  private release(tx: Tx, id: string) {
    return tx.callCampaignItem.update({ where: { id }, data: { status: 'pending', agentId: null, claimedAt: null, lockedUntil: null, dialedAt: null, nextAt: new Date() } });
  }

  private async myItem(tx: Tx, id: string) {
    const item = await tx.callCampaignItem.findUnique({ where: { id } });
    if (!item || item.agentId !== auth().userId || item.status !== 'active') throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'This call is no longer open for you' });
    return item;
  }

  private async campaign(tx: Tx, id: string) {
    const c = await tx.callCampaign.findUnique({ where: { id } });
    if (!c || c.isArchived || !auth().accessibleWorkspaceIds.includes(c.workspaceId)) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found' });
    return c;
  }

  private async leadWhere(tx: Tx, ws: string, f: z.infer<typeof Filter>): Promise<Prisma.LeadWhereInput> {
    const closed = await tx.leadStage.findMany({ where: { OR: [{ isWon: true }, { isLost: true }] }, select: { id: true } });
    const named = f.owners.filter((o) => o !== 'unassigned');
    return {
      AND: [
        await scopeFilter(tx, 'crm.campaign.manage'),
        { workspaceId: ws, stageId: { notIn: closed.map((s) => s.id) }, customer: { mobile: { not: null } } },
        ...(f.stageIds.length ? [{ stageId: { in: f.stageIds } }] : []),
        ...(f.statuses.length ? [{ status: { in: f.statuses } }] : []),
        ...(f.sources.length ? [{ source: { in: f.sources } }] : []),
        ...(f.dispositions.length ? [{ lastDisposition: { in: f.dispositions } }] : []),
        ...(f.owners.length ? [{ OR: [...(f.owners.includes('unassigned') ? [{ ownerId: null }] : []), { ownerId: { in: named } }] }] : []),
        ...(f.contacted === 'no' ? [{ lastActivityAt: null }] : f.contacted === 'yes' ? [{ lastActivityAt: { not: null } }] : []),
      ],
    };
  }

  private workspaceUsers(tx: Tx, ws: string) {
    // Only people who can work on leads can be callers (an auditor, say, cannot).
    return tx.user.findMany({ where: { isActive: true, roles: { some: { OR: [{ workspaceId: ws }, { workspaceId: null }], role: { permissions: { some: { isDeny: false, permission: { key: 'crm.lead.update' } } } } } } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }

  private async assertAgents(tx: Tx, ws: string, ids: string[]) {
    const ok = new Set((await this.workspaceUsers(tx, ws)).map((u) => u.id));
    if (ids.some((id) => !ok.has(id))) throw new BadRequestException({ code: 'INVALID_AGENT', message: 'Every caller must be an active person in this business line' });
  }

  private ws() {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return ws;
  }
  private canManage(ws: string) {
    const s = auth().permissions['crm.campaign.manage'];
    return s === 'ORGANIZATION' || (!!s && auth().workspaceId === ws);
  }
  private assertManage(ws: string) {
    if (!this.canManage(ws)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can manage campaigns' });
  }
}
