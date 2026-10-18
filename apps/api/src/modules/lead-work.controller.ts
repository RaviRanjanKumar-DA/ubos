import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { emitEvent } from '../common/events';
import { live } from '../common/live';
import { activity, applyStageChange, eligibleOwners, syncNextFollowUp } from '../common/lead-ops';
import { contact, contacts, customFields as visibleFields, fieldAccess } from '../common/field-access';
import { notify, validMentions } from '../common/notify';

const LogActivity = z.object({
  type: z.enum(['call', 'remark']),
  disposition: z.string().max(60).optional(),
  durationSec: z.number().int().min(0).max(36_000).optional(),
  remark: z.string().trim().max(2000).optional(),
  followUpAt: z.coerce.date().optional(),
  followUpNote: z.string().trim().max(300).optional(),
  mentionIds: z.array(z.string().uuid()).max(20).optional(),
});
const Labels = z.object({ labelIds: z.array(z.string().uuid()).max(30) });
const PatchLead = z.object({ status: z.string().max(60).nullable().optional(), ownerId: z.string().uuid().optional() });
const NewFollowUp = z.object({ dueAt: z.coerce.date(), note: z.string().trim().max(300).optional() });
const DoneFollowUp = z.object({ done: z.literal(true), outcome: z.string().trim().max(300).optional() });
const FollowUpQuery = z.object({ when: z.enum(['today', 'overdue', 'upcoming']).default('today') });
const Bulk = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(1000),
  action: z.enum(['assign', 'stage', 'status', 'remark', 'follow_up', 'labels']),
  addLabelIds: z.array(z.string().uuid()).max(30).optional(),
  removeLabelIds: z.array(z.string().uuid()).max(30).optional(),
  ownerIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  stageId: z.string().uuid().optional(),
  lostReason: z.string().max(120).optional(),
  status: z.string().max(60).optional(),
  remark: z.string().trim().max(2000).optional(),
  followUpAt: z.coerce.date().optional(),
});

/** Day work on leads: detail view, calls with disposition, remarks, follow-ups, status/owner and bulk actions. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class LeadWorkController {
  constructor(private db: DbService) {}

  /** Follow-ups due today / overdue / upcoming for leads in the user's scope (own, team, workspace…). */
  @Get('follow-ups')
  @RequirePermission('crm.lead.view')
  followUps(@Query() query: unknown) {
    const { when } = parse(FollowUpQuery, query);
    return this.db.tenant(async (tx) => {
      const scope = await scopeFilter(tx, 'crm.lead.view');
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 86_400_000);
      const due = when === 'today' ? { gte: start, lt: end } : when === 'overdue' ? { lt: new Date() } : { gte: end };
      const rows = await tx.followUp.findMany({
        where: { doneAt: null, dueAt: due, lead: scope },
        orderBy: { dueAt: 'asc' },
        take: 300,
        include: { lead: { include: { customer: { select: { name: true, mobile: true } }, workspace: { select: { name: true } } } } },
      });
      const users = await this.names(tx, rows.map((r) => r.userId));
      return rows.map((f) => ({
        id: f.id, dueAt: f.dueAt, note: f.note, leadId: f.leadId, name: f.lead.customer.name, mobile: f.lead.customer.mobile,
        workspace: f.lead.workspace.name, owner: users.get(f.userId) ?? null, overdue: f.dueAt < new Date(),
      }));
    });
  }

  @Get('leads/:id')
  @RequirePermission('crm.lead.view')
  detail(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const lead = await this.visibleLead(tx, id, 'crm.lead.view');
      const [full, activities, followUps] = await Promise.all([
        tx.lead.findUniqueOrThrow({
          where: { id },
          include: {
            customer: true, workspace: { select: { id: true, name: true } },
            pipeline: { include: { stages: { orderBy: { position: 'asc' } } } },
          },
        }),
        tx.leadActivity.findMany({ where: { leadId: id }, orderBy: { createdAt: 'desc' }, take: 200 }),
        tx.followUp.findMany({ where: { leadId: id }, orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueAt: 'asc' }], take: 50 }),
      ]);
      const mentioned = activities.flatMap((x) => ((x.data as { mentions?: string[] } | null)?.mentions ?? []));
      const users = await this.names(tx, [lead.ownerId, ...activities.map((a) => a.userId), ...followUps.map((f) => f.userId), ...mentioned]);
      const a = auth();
      const fa = await fieldAccess(tx);
      const fields = await tx.leadField.findMany({ where: { workspaceId: full.workspaceId }, select: { key: true } });
      // Calls on the journey that have a recording this person may play (the player asks again, and it is audited).
      const playable = new Set(a.permissions['crm.call.recording'] ? (await tx.call.findMany({ where: { leadId: full.id, recordingStatus: { in: ['ready', 'link'] } }, select: { activityId: true } })).map((c) => c.activityId) : []);
      return {
        id: full.id, customerId: full.customerId, customerCode: full.customer.code, name: full.customer.name,
        mobile: contact(fa, 'mobile', full.customer.mobile), alternateMobiles: contacts(fa, 'mobile', full.customer.alternateMobiles),
        email: contact(fa, 'email', full.customer.email), alternateEmails: contacts(fa, 'email', full.customer.alternateEmails), city: full.customer.city,
        workspace: full.workspace, pipeline: { id: full.pipeline.id, name: full.pipeline.name, stages: full.pipeline.stages.map((s) => ({ id: s.id, name: s.name, isWon: s.isWon, isLost: s.isLost })) },
        stageId: full.stageId, status: full.status, lostReason: full.lostReason, source: full.source, rating: full.rating,
        customFields: visibleFields(fa, full.customFields as Record<string, unknown>), labelIds: full.labelIds,
        fieldAccess: Object.fromEntries([...['mobile', 'email'], ...fields.map((f) => `cf:${f.key}`)].map((k) => [k, fa.of(k)])),
        owner: full.ownerId ? { id: full.ownerId, name: users.get(full.ownerId) ?? '?' } : null,
        createdAt: full.createdAt, assignedAt: full.assignedAt, firstResponseAt: full.firstResponseAt,
        lastActivityAt: full.lastActivityAt, lastDisposition: full.lastDisposition, nextFollowUpAt: full.nextFollowUpAt,
        score: full.score, stageChangedAt: full.stageChangedAt,
        canUpdate: !!a.permissions['crm.lead.update'], canAssign: !!a.permissions['crm.lead.assign'],
        activities: activities.map((x) => ({
          id: x.id, type: x.type, disposition: x.disposition, connected: x.connected, durationSec: x.durationSec, remark: x.remark,
          data: x.data, user: x.userId ? users.get(x.userId) ?? null : null, at: x.createdAt, recording: playable.has(x.id),
          mentions: ((x.data as { mentions?: string[] } | null)?.mentions ?? []).map((id) => users.get(id) ?? 'Someone'),
        })),
        followUps: followUps.map((f) => ({ id: f.id, dueAt: f.dueAt, note: f.note, doneAt: f.doneAt, outcome: f.outcome, user: users.get(f.userId) ?? null })),
      };
    });
  }

  /** Log a call (with disposition) or a remark; optionally schedule the next follow-up in the same step. */
  @Post('leads/:id/activities')
  @RequirePermission('crm.lead.update')
  log(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(LogActivity, body);
    if (input.type === 'remark' && !input.remark) throw new BadRequestException({ code: 'REMARK_REQUIRED', message: 'Write a remark' });
    return this.db.tenant(async (tx) => {
      const lead = await this.visibleLead(tx, id, 'crm.lead.update');
      let connected: boolean | null = null;
      if (input.type === 'call') {
        const opt = await tx.workspaceOption.findFirst({ where: { workspaceId: lead.workspaceId, kind: 'call_disposition', value: input.disposition ?? '', isArchived: false } });
        if (!opt) throw new BadRequestException({ code: 'INVALID_DISPOSITION', message: 'Choose a call disposition' });
        connected = opt.connected;
      }
      const now = new Date();
      const mentions = await validMentions(tx, input.mentionIds);
      const act = await tx.leadActivity.create({
        data: activity(lead, auth().userId, {
          type: input.type, disposition: input.disposition ?? null, connected, durationSec: input.durationSec ?? null, remark: input.remark ?? null,
          ...(mentions.length ? { data: { mentions } } : {}),
        }),
      });
      if (mentions.length) {
        const c = await tx.customer.findUnique({ where: { id: lead.customerId }, select: { name: true } });
        await notify(tx, mentions, { type: 'mention', title: `${auth().name} mentioned you on ${c?.name ?? 'a lead'}`, body: input.remark ?? null, link: `/app/leads/${id}` });
      }
      // Calls logged by hand also go into the call log (all channels in one place).
      if (input.type === 'call') {
        const cust = await tx.customer.findUnique({ where: { id: lead.customerId }, select: { mobile: true } });
        const call = await tx.call.create({
          data: {
            tenantId: lead.tenantId, externalId: `manual:${act.id}`, channel: 'manual', direction: 'outbound', phone: cust?.mobile ?? '', userId: auth().userId,
            workspaceId: lead.workspaceId, leadId: lead.id, customerId: lead.customerId, activityId: act.id, startedAt: now, talkSec: input.durationSec ?? 0,
            answered: !!connected, disposition: input.disposition ?? null, remark: input.remark ?? null,
          },
        });
        await tx.leadActivity.update({ where: { id: act.id }, data: { data: { ...(mentions.length ? { mentions } : {}), callId: call.id, channel: 'manual' } } });
        await emitEvent(tx, lead.tenantId, lead.workspaceId, 'call.logged', { callId: call.id, leadId: lead.id, customerId: lead.customerId, userId: auth().userId, channel: 'manual', direction: 'outbound', startedAt: now, talkSec: call.talkSec, answered: call.answered, disposition: call.disposition });
        live.publish(lead.tenantId, { type: 'call.logged', leadId: lead.id, userId: auth().userId, callId: call.id });
      }
      // A logged call completes the follow-ups that were due for this lead.
      if (input.type === 'call') {
        await tx.followUp.updateMany({ where: { leadId: id, doneAt: null, dueAt: { lte: new Date(now.getTime() + 3_600_000) } }, data: { doneAt: now, outcome: input.disposition } });
      }
      if (input.followUpAt) await this.addFollowUp(tx, lead, input.followUpAt, input.followUpNote);
      await tx.lead.update({
        where: { id },
        data: {
          lastActivityAt: now,
          ...(input.type === 'call' ? { lastDisposition: input.disposition } : {}),
          ...(!lead.firstResponseAt ? { firstResponseAt: now } : {}),
        },
      });
      await syncNextFollowUp(tx, id);
      return { ok: true };
    });
  }

  @Patch('leads/:id')
  @RequirePermission('crm.lead.view')
  async patch(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(PatchLead, body);
    return this.db.tenant(async (tx) => {
      if (input.ownerId !== undefined) await this.applyAssign(tx, [id], [input.ownerId]);
      if (input.status !== undefined) await this.applyStatus(tx, [id], input.status);
      return { ok: true };
    });
  }

  /** Replaces the labels of one lead. */
  @Put('leads/:id/labels')
  @RequirePermission('crm.lead.update')
  setLabels(@Param('id') id: string, @Body() body: unknown) {
    const { labelIds } = parse(Labels, body);
    return this.db.tenant(async (tx) => {
      const lead = await this.visibleLead(tx, id, 'crm.lead.update');
      const ok = await this.checkLabels(tx, labelIds, lead.workspaceId);
      await tx.lead.update({ where: { id }, data: { labelIds: ok } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'labels', data: { from: lead.labelIds, to: ok } }) });
      return { labelIds: ok };
    });
  }

  @Post('leads/:id/follow-ups')
  @RequirePermission('crm.lead.update')
  createFollowUp(@Param('id') id: string, @Body() body: unknown) {
    const { dueAt, note } = parse(NewFollowUp, body);
    return this.db.tenant(async (tx) => {
      const lead = await this.visibleLead(tx, id, 'crm.lead.update');
      const f = await this.addFollowUp(tx, lead, dueAt, note);
      await syncNextFollowUp(tx, id);
      return { id: f.id };
    });
  }

  @Patch('follow-ups/:id')
  @RequirePermission('crm.lead.update')
  completeFollowUp(@Param('id') id: string, @Body() body: unknown) {
    const { outcome } = parse(DoneFollowUp, body);
    return this.db.tenant(async (tx) => {
      const f = await tx.followUp.findUnique({ where: { id } });
      if (!f) throw new NotFoundException({ code: 'FOLLOW_UP_NOT_FOUND', message: 'Follow-up not found' });
      await this.visibleLead(tx, f.leadId, 'crm.lead.update');
      await tx.followUp.update({ where: { id }, data: { doneAt: new Date(), outcome: outcome ?? 'Done' } });
      await syncNextFollowUp(tx, f.leadId);
      return { ok: true };
    });
  }

  /**
   * Bulk actions on selected leads. Every lead is checked against the user's scope; leads outside it are
   * skipped (reported back), never changed.
   */
  @Post('leads/bulk')
  @HttpCode(200)
  @RequirePermission('crm.lead.view')
  bulk(@Body() body: unknown) {
    const b = parse(Bulk, body);
    const ids = [...new Set(b.leadIds)];
    return this.db.tenant(async (tx) => {
      let result: { updated: string[]; skipped: { id: string; reason: string }[] };
      switch (b.action) {
        case 'assign':
          if (!b.ownerIds?.length) throw new BadRequestException({ code: 'OWNER_REQUIRED', message: 'Choose at least one person' });
          result = await this.applyAssign(tx, ids, b.ownerIds);
          break;
        case 'stage':
          if (!b.stageId) throw new BadRequestException({ code: 'STAGE_REQUIRED', message: 'Choose a stage' });
          result = await this.applyStage(tx, ids, b.stageId, b.lostReason);
          break;
        case 'status':
          result = await this.applyStatus(tx, ids, b.status ?? null);
          break;
        case 'remark':
          if (!b.remark) throw new BadRequestException({ code: 'REMARK_REQUIRED', message: 'Write a remark' });
          result = await this.applyEach(tx, ids, 'crm.lead.update', async (lead) => {
            await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'remark', remark: b.remark }) });
            await tx.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date() } });
          });
          break;
        case 'labels':
          if (!b.addLabelIds?.length && !b.removeLabelIds?.length) throw new BadRequestException({ code: 'LABELS_REQUIRED', message: 'Choose labels to add or remove' });
          result = await this.applyEach(tx, ids, 'crm.lead.update', async (lead) => {
            const add = await this.checkLabels(tx, b.addLabelIds ?? [], lead.workspaceId);
            const next = [...new Set([...lead.labelIds.filter((x) => !(b.removeLabelIds ?? []).includes(x)), ...add])];
            await tx.lead.update({ where: { id: lead.id }, data: { labelIds: next } });
          });
          break;
        case 'follow_up':
          if (!b.followUpAt) throw new BadRequestException({ code: 'DATE_REQUIRED', message: 'Choose the follow-up date' });
          result = await this.applyEach(tx, ids, 'crm.lead.update', async (lead) => {
            await this.addFollowUp(tx, lead, b.followUpAt!, b.remark);
            await syncNextFollowUp(tx, lead.id);
          });
          break;
      }
      await this.db.audit(tx, {
        entity: 'lead', entityId: 'bulk', action: `lead.bulk_${b.action}`,
        newValue: { requested: ids.length, updated: result.updated.length, skipped: result.skipped.length, ownerIds: b.ownerIds, stageId: b.stageId, status: b.status },
      });
      return { updated: result.updated.length, skipped: result.skipped };
    }, { timeoutMs: 60_000 });
  }

  /** Labels must exist, be active and belong to the lead's business line or the whole organization. */
  private async checkLabels(tx: Tx, ids: string[], workspaceId: string) {
    if (!ids.length) return [];
    const labels = await tx.label.findMany({ where: { id: { in: ids }, isArchived: false, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true } });
    if (labels.length !== new Set(ids).size) throw new BadRequestException({ code: 'INVALID_LABEL', message: 'Some labels do not exist in this business line' });
    return labels.map((l) => l.id);
  }

  // ── shared actions (single lead and bulk use the same rules) ──

  /** Assigns leads round-robin over `ownerIds` (one id = everyone to that person). */
  private async applyAssign(tx: Tx, ids: string[], ownerIds: string[]) {
    const eligibleBy = new Map<string, Set<string>>();
    let i = 0;
    const result = await this.applyEach(tx, ids, 'crm.lead.assign', async (lead) => {
      if (!eligibleBy.has(lead.workspaceId)) eligibleBy.set(lead.workspaceId, new Set((await eligibleOwners(tx, lead.workspaceId)).map((u) => u.id)));
      const eligible = eligibleBy.get(lead.workspaceId)!;
      const candidates = ownerIds.filter((o) => eligible.has(o));
      if (!candidates.length) return 'Chosen person has no access to this business line';
      const owner = candidates[i++ % candidates.length];
      // The first person a customer is assigned to becomes their sticky Primary RM.
      await tx.customer.updateMany({ where: { id: lead.customerId, primaryRmId: null }, data: { primaryRmId: owner } });
      if (owner === lead.ownerId) return null;
      await tx.lead.update({ where: { id: lead.id }, data: { ownerId: owner, assignedAt: new Date() } });
      await tx.followUp.updateMany({ where: { leadId: lead.id, doneAt: null, userId: lead.ownerId ?? undefined }, data: { userId: owner } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'assignment', data: { from: lead.ownerId, to: owner } }) });
      return null;
    });
    return result;
  }

  private async applyStage(tx: Tx, ids: string[], stageId: string, lostReason?: string) {
    const stage = await tx.leadStage.findUnique({ where: { id: stageId } });
    if (!stage) throw new NotFoundException({ code: 'STAGE_NOT_FOUND', message: 'Stage not found' });
    return this.applyEach(tx, ids, 'crm.lead.update', (lead) => applyStageChange(tx, lead, stage, auth().userId, lostReason));
  }

  private async applyStatus(tx: Tx, ids: string[], status: string | null) {
    const allowed = new Map<string, Set<string>>();
    return this.applyEach(tx, ids, 'crm.lead.update', async (lead) => {
      if (status) {
        if (!allowed.has(lead.workspaceId)) {
          const opts = await tx.workspaceOption.findMany({ where: { workspaceId: lead.workspaceId, kind: 'lead_status', isArchived: false }, select: { value: true } });
          allowed.set(lead.workspaceId, new Set(opts.map((o) => o.value)));
        }
        if (!allowed.get(lead.workspaceId)!.has(status)) return 'Status not available in this business line';
      }
      if (lead.status === status) return null;
      await tx.lead.update({ where: { id: lead.id }, data: { status } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'status', data: { from: lead.status, to: status } }) });
      return null;
    });
  }

  /** Runs `fn` for every lead the user may act on with `perm`; collects skipped leads with a reason. */
  private async applyEach(
    tx: Tx, ids: string[], perm: 'crm.lead.update' | 'crm.lead.assign',
    fn: (lead: Awaited<ReturnType<Tx['lead']['findFirstOrThrow']>>) => Promise<string | null | void>,
  ) {
    if (!auth().permissions[perm]) {
      if (ids.length === 1) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You do not have permission for this action' });
      return { updated: [] as string[], skipped: ids.map((id) => ({ id, reason: 'You do not have permission for this action' })) };
    }
    const scope = await scopeFilter(tx, perm);
    const leads = await tx.lead.findMany({ where: { AND: [scope, { id: { in: ids } }] } });
    const found = new Set(leads.map((l) => l.id));
    const updated: string[] = [];
    const skipped = ids.filter((id) => !found.has(id)).map((id) => ({ id, reason: 'Not in your access' }));
    for (const lead of leads) {
      const why = await fn(lead);
      if (why) skipped.push({ id: lead.id, reason: why });
      else updated.push(lead.id);
    }
    if (ids.length === 1 && skipped.length === 1) {
      throw new BadRequestException({ code: 'ACTION_NOT_ALLOWED', message: skipped[0].reason });
    }
    return { updated, skipped };
  }

  private async addFollowUp(tx: Tx, lead: { id: string; tenantId: string; workspaceId: string; ownerId: string | null }, dueAt: Date, note?: string | null) {
    const f = await tx.followUp.create({
      data: { tenantId: lead.tenantId, leadId: lead.id, dueAt, note: note ?? null, userId: lead.ownerId ?? auth().userId, createdById: auth().userId },
    });
    await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'follow_up', remark: note ?? null, data: { dueAt: dueAt.toISOString() } }) });
    return f;
  }

  private async visibleLead(tx: Tx, id: string, perm: 'crm.lead.view' | 'crm.lead.update') {
    const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, perm), { id }] } });
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return lead;
  }

  private async names(tx: Tx, ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter(Boolean) as string[])];
    return new Map((await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  }
}
