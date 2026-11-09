import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CONDITION_OPS, type ConditionOp } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { emitEvent } from '../common/events';
import { activity, assignmentAvailability, defaultStatus, eligibleOwners, makeAssigner } from '../common/lead-ops';
import { queueRescore, rescoreLead, routedOwner, routingValues } from '../common/lead-rules';
import { notify } from '../common/notify';
import { scopeFilter } from '../common/scope';

const KEY = 'crm.routing.manage';
const Cond = (fields: string) => z.object({ field: z.string().regex(new RegExp(`^(${fields}|cf:[a-z][a-z0-9_]*)$`)), op: z.enum(Object.keys(CONDITION_OPS) as [ConditionOp, ...ConditionOp[]]), value: z.string().trim().max(500).optional() })
  .refine((c) => ['empty', 'not_empty'].includes(c.op) || !!c.value, 'Enter a value for each condition');
const Routing = z.object({ name: z.string().trim().min(2).max(80), conditions: z.array(Cond('source|city')).min(1, 'Add at least one condition').max(10), userIds: z.array(z.string().uuid()).min(1, 'Choose at least one person').max(100) });
const Scoring = z.object({ name: z.string().trim().min(2).max(80), conditions: z.array(Cond('source|status|stage|city|email|mobile')).min(1, 'Add at least one condition').max(10), points: z.number().int().min(-100).max(100).refine((n) => n !== 0, 'Points cannot be zero') });
const Flags = z.object({ isActive: z.boolean().optional(), isArchived: z.boolean().optional() });
const Transfer = z.object({ workspaceId: z.string().uuid(), reason: z.string().trim().min(3).max(500) });

/** Routing rules, scoring rules and moving a lead to another business line. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class LeadRulesController {
  constructor(private db: DbService) {}

  private ws() {
    const w = auth().workspaceId;
    if (!w) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return w;
  }
  private async audit(tx: Tx, entity: string, id: string, action: string, name: string) {
    await this.db.audit(tx, { workspaceId: auth().workspaceId, entity, entityId: id, action, newValue: { name } });
  }

  @Get('lead-rules/options')
  @RequirePermission(KEY)
  options() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const [pipelines, opts, fields, people] = await Promise.all([
        tx.pipeline.findMany({ where: { workspaceId: ws }, include: { stages: { orderBy: { position: 'asc' } } } }),
        tx.workspaceOption.findMany({ where: { workspaceId: ws, isArchived: false } }),
        tx.leadField.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { position: 'asc' } }),
        eligibleOwners(tx, ws),
      ]);
      const pick = (kind: string) => opts.filter((o) => o.kind === kind).map((o) => ({ value: o.value, label: o.label }));
      const custom = fields.map((f) => ({ value: `cf:${f.key}`, label: f.label }));
      return {
        ops: Object.entries(CONDITION_OPS).map(([value, label]) => ({ value, label })),
        routingFields: [{ value: 'city', label: 'City' }, { value: 'source', label: 'Source' }, ...custom],
        scoringFields: [{ value: 'source', label: 'Source' }, { value: 'status', label: 'Status' }, { value: 'stage', label: 'Stage' }, { value: 'city', label: 'City' }, { value: 'email', label: 'Email' }, { value: 'mobile', label: 'Mobile' }, ...custom],
        stages: pipelines.flatMap((p) => p.stages.map((s) => ({ value: s.id, label: pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name }))),
        statuses: pick('lead_status'), sources: pick('lead_source'),
        users: people.map((u) => ({ value: u.id, label: u.name })),
      };
    });
  }

  @Get('routing-rules')
  @RequirePermission(KEY)
  routing() {
    const ws = this.ws();
    return this.db.tenant((tx) => tx.routingRule.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }));
  }

  private async assertPeople(tx: Tx, ws: string, ids: string[]) {
    const ok = new Set((await eligibleOwners(tx, ws)).map((u) => u.id));
    if (!ids.every((i) => ok.has(i))) throw new BadRequestException({ code: 'INVALID_USER', message: 'Everyone chosen must work leads in this business line' });
  }

  @Post('routing-rules')
  @RequirePermission(KEY)
  addRouting(@Body() body: unknown) {
    const input = parse(Routing, body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      await this.assertPeople(tx, ws, input.userIds);
      const position = await tx.routingRule.count({ where: { workspaceId: ws, isArchived: false } });
      const r = await tx.routingRule.create({ data: { ...input, tenantId: tenantId(), workspaceId: ws, position, createdById: auth().userId } });
      await this.audit(tx, 'routing_rule', r.id, 'routing_rule.created', r.name);
      return r;
    });
  }

  @Post('routing-rules/order')
  @RequirePermission(KEY)
  order(@Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(200) }), body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const mine = await tx.routingRule.findMany({ where: { workspaceId: ws, isArchived: false }, select: { id: true } });
      if (mine.length !== ids.length || !mine.every((r) => ids.includes(r.id))) throw new BadRequestException({ code: 'INVALID_ORDER', message: 'The list of rules has changed. Reload and try again.' });
      for (const [position, id] of ids.entries()) await tx.routingRule.update({ where: { id }, data: { position } });
      return { ok: true };
    });
  }

  @Patch('routing-rules/:id')
  @RequirePermission(KEY)
  editRouting(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Routing.partial().merge(Flags), body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      if (!(await tx.routingRule.findFirst({ where: { id, workspaceId: ws, isArchived: false } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
      if (input.userIds) await this.assertPeople(tx, ws, input.userIds);
      const r = await tx.routingRule.update({ where: { id }, data: input });
      await this.audit(tx, 'routing_rule', id, input.isArchived ? 'routing_rule.archived' : 'routing_rule.updated', r.name);
      return r;
    });
  }

  @Get('score-rules')
  @RequirePermission(KEY)
  scoring() {
    const ws = this.ws();
    return this.db.tenant((tx) => tx.scoreRule.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { createdAt: 'asc' } }));
  }

  @Post('score-rules')
  @RequirePermission(KEY)
  addScoring(@Body() body: unknown) {
    const input = parse(Scoring, body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const r = await tx.scoreRule.create({ data: { ...input, tenantId: tenantId(), workspaceId: ws, createdById: auth().userId } });
      await this.audit(tx, 'score_rule', r.id, 'score_rule.created', r.name);
      return r;
    });
  }

  @Patch('score-rules/:id')
  @RequirePermission(KEY)
  editScoring(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Scoring.partial().merge(Flags), body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      if (!(await tx.scoreRule.findFirst({ where: { id, workspaceId: ws, isArchived: false } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
      const r = await tx.scoreRule.update({ where: { id }, data: input });
      await this.audit(tx, 'score_rule', id, input.isArchived ? 'score_rule.archived' : 'score_rule.updated', r.name);
      return r;
    });
  }

  /** Applies the current rules to every lead of the business line, in small batches so other work is not held up. */
  @Post('score-rules/recalculate')
  @RequirePermission(KEY)
  async recalculate() {
    const ws = this.ws();
    let cursor: string | undefined, leads = 0, changed = 0;
    for (;;) {
      const batch: { id: string }[] = await this.db.tenant((tx) => tx.lead.findMany({ where: { workspaceId: ws }, select: { id: true }, orderBy: { id: 'asc' }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }));
      if (!batch.length) break;
      changed += await this.db.tenant(async (tx) => { let n = 0; for (const l of batch) if (await rescoreLead(tx, l.id)) n++; return n; }, { timeoutMs: 60_000 });
      leads += batch.length;
      cursor = batch[batch.length - 1].id;
      if (leads >= 50_000) break;
    }
    return { leads, changed };
  }

  @Get('leads/:id/score')
  @RequirePermission('crm.lead.view')
  score(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const lead = await tx.lead.findFirst({ where: { AND: [{ id }, await scopeFilter(tx, 'crm.lead.view')] }, select: { score: true } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const hits = await tx.leadScoreHit.findMany({ where: { leadId: id } });
      const names = new Map((await tx.scoreRule.findMany({ where: { id: { in: hits.map((h) => h.ruleId) } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
      const rules = hits.map((h) => ({ name: names.get(h.ruleId) ?? 'Rule', points: h.points }));
      return { score: lead.score, rules, other: lead.score - rules.reduce((s, r) => s + r.points, 0) };
    });
  }

  @Get('leads/:id/transfer-options')
  @RequirePermission('crm.lead.transfer')
  transferOptions(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const lead = await this.transferable(tx, id);
      return (await tx.workspace.findMany({ where: { isArchived: false, id: { not: lead.workspaceId } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }));
    });
  }

  private async transferable(tx: Tx, id: string) {
    const lead = await tx.lead.findFirst({ where: { AND: [{ id }, await scopeFilter(tx, 'crm.lead.transfer')] }, include: { customer: true } });
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return lead;
  }

  /**
   * Moves a lead to another business line. Its journey and calls stay with it. The stage, status and owner become the new
   * business line's; fields that do not exist there are written on the timeline so nothing is lost.
   */
  @Post('leads/:id/transfer')
  @RequirePermission('crm.lead.transfer')
  transfer(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Transfer, body);
    return this.db.tenant(async (tx) => {
      const lead = await this.transferable(tx, id);
      if (lead.workspaceId === input.workspaceId) throw new BadRequestException({ code: 'SAME_WORKSPACE', message: 'The lead is already in this business line' });
      const from = await tx.workspace.findUniqueOrThrow({ where: { id: lead.workspaceId } });
      const to = await tx.workspace.findFirst({ where: { id: input.workspaceId, isArchived: false } });
      if (!to) throw new BadRequestException({ code: 'WORKSPACE_NOT_FOUND', message: 'Choose an active business line' });
      // Quotes, processes and payments are priced and tracked per business line.
      const [quotes, runs, payments, queued, stageNow] = await Promise.all([
        tx.quote.count({ where: { leadId: id } }), tx.processRun.count({ where: { leadId: id } }), tx.payment.count({ where: { leadId: id } }),
        tx.callCampaignItem.count({ where: { leadId: id, status: { in: ['pending', 'active'] } } }),
        tx.leadStage.findUniqueOrThrow({ where: { id: lead.stageId } }),
      ]);
      if (stageNow.isWon || stageNow.isLost) throw new BadRequestException({ code: 'LEAD_CLOSED', message: 'Won or lost leads cannot be moved' });
      if (quotes || runs || payments) throw new ConflictException({ code: 'HAS_DEALS', message: 'This lead has quotes, payments or a process. Start a new lead in the other business line instead.' });
      if (queued) throw new ConflictException({ code: 'IN_CAMPAIGN', message: 'This lead is waiting in a calling campaign. Remove it first.' });
      const others = await tx.lead.findMany({ where: { customerId: lead.customerId, workspaceId: to.id }, select: { id: true, stageId: true } });
      if (others.length) {
        const closed = new Set((await tx.leadStage.findMany({ where: { id: { in: others.map((o) => o.stageId) }, OR: [{ isWon: true }, { isLost: true }] }, select: { id: true } })).map((s) => s.id));
        if (others.some((o) => !closed.has(o.stageId))) throw new ConflictException({ code: 'ALREADY_OPEN', message: `${lead.customer.name} already has an open lead in ${to.name}` });
      }
      const pipeline = await tx.pipeline.findFirst({ where: { workspaceId: to.id }, orderBy: { position: 'asc' }, include: { stages: { orderBy: { position: 'asc' }, where: { isWon: false, isLost: false }, take: 1 } } });
      if (!pipeline?.stages[0]) throw new BadRequestException({ code: 'NO_PIPELINE', message: `${to.name} has no pipeline yet` });

      const defs = await tx.leadField.findMany({ where: { workspaceId: to.id, isArchived: false }, select: { key: true } });
      const keep = new Set(defs.map((d) => d.key));
      const current = (lead.customFields ?? {}) as Record<string, unknown>;
      const kept = Object.fromEntries(Object.entries(current).filter(([k]) => keep.has(k)));
      const dropped = Object.entries(current).filter(([k, v]) => !keep.has(k) && v !== null && v !== '');
      const eligible = (await eligibleOwners(tx, to.id)).map((u) => u.id);
      const avail = await assignmentAvailability(tx);
      const routed = await routedOwner(tx, to, routingValues({ source: lead.source, city: lead.customer.city, customFields: kept }), lead.customer.primaryRmId, eligible, avail);
      const assigner = makeAssigner(to.assignmentMode === 'creator' ? { ...to, assignmentMode: 'round_robin' } : to, eligible, eligible[0] ?? '', avail);
      const ownerId = routed ?? (eligible.length ? assigner.pick(lead.customer.primaryRmId) || null : null);
      if (!routed) await tx.workspace.update({ where: { id: to.id }, data: { assignmentCursor: assigner.state.cursor } });
      const labels = lead.labelIds.length ? (await tx.label.findMany({ where: { id: { in: lead.labelIds }, OR: [{ workspaceId: null }, { workspaceId: to.id }] }, select: { id: true } })).map((l) => l.id) : [];

      // Scores come from each business line's own rules.
      const hits = await tx.leadScoreHit.findMany({ where: { leadId: id } });
      await tx.leadScoreHit.deleteMany({ where: { leadId: id } });
      const updated = await tx.lead.update({
        where: { id },
        data: { workspaceId: to.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, stageChangedAt: new Date(), status: await defaultStatus(tx, to.id), customFields: kept as object, labelIds: labels, ownerId, assignedAt: ownerId ? new Date() : null, score: { decrement: hits.reduce((s, h) => s + h.points, 0) } },
      });
      await tx.task.updateMany({ where: { leadId: id, doneAt: null }, data: { workspaceId: to.id, ...(ownerId ? { assigneeId: ownerId } : {}) } });
      await tx.conversation.updateMany({ where: { leadId: id }, data: { workspaceId: to.id, assigneeId: ownerId } });
      const note = [`Moved from ${from.name} to ${to.name}: ${input.reason}`, ...dropped.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)].join('\n');
      await tx.leadActivity.create({ data: activity(updated, auth().userId, { type: 'remark', remark: note.slice(0, 4000), data: { transfer: true, from: from.id, to: to.id } }) });
      if (ownerId) await tx.leadActivity.create({ data: activity(updated, auth().userId, { type: 'assignment', data: { from: lead.ownerId, to: ownerId, auto: true } }) });
      await notify(tx, [...new Set([ownerId, lead.ownerId].filter(Boolean) as string[])], { type: 'assignment', title: `${lead.customer.name} moved to ${to.name}`, body: input.reason, link: `/app/leads/${id}` });
      await this.db.audit(tx, { workspaceId: to.id, entity: 'lead', entityId: id, action: 'lead.transferred', oldValue: { workspaceId: from.id, ownerId: lead.ownerId }, newValue: { workspaceId: to.id, ownerId, reason: input.reason } });
      await emitEvent(tx, tenantId(), to.id, 'lead.updated', { leadId: id, customerId: lead.customerId, transfer: true, from: from.id, to: to.id });
      await queueRescore(tx, updated);
      return { ok: true, workspaceId: to.id, ownerId };
    });
  }
}
