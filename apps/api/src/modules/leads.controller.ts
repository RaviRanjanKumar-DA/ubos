import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { istStamp } from '../common/ist';
import type { Response } from 'express';
import { z } from 'zod';
import { normalizeMobile, toCsv, validateCustomFields } from '@ubos/shared';
import { Prisma } from '@ubos/database';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { findCustomer, nextCustomerCode } from '../common/customers';
import { emitEvent } from '../common/events';
import { activity, applyStageChange, assignmentAvailability, defaultStatus, eligibleOwners, makeAssigner } from '../common/lead-ops';
import { contact, customFields as visibleFields, fieldAccess, lockedFields } from '../common/field-access';

const csvList = z.string().max(4000).optional().transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
/** Flexible filters — every one is optional and they combine with AND; lists inside one filter combine with OR. */
const ListQuery = z.object({
  pipelineId: z.string().uuid().optional(),
  stageIds: csvList, statuses: csvList, sources: csvList, owners: csvList, dispositions: csvList, lostReasons: csvList, labelIds: csvList,
  // single-value forms kept for simple links
  stageId: z.string().uuid().optional(), status: z.string().max(60).optional(), owner: z.string().max(60).optional(), source: z.string().max(60).optional(),
  createdFrom: day, createdTo: day, assignedFrom: day, assignedTo: day, activityFrom: day, activityTo: day, followUpFrom: day, followUpTo: day,
  followUp: z.enum(['today', 'overdue', 'none', 'planned']).optional(),
  contacted: z.enum(['yes', 'no']).optional(),
  stuck: z.enum(['yes']).optional(),
  scoreMin: z.coerce.number().int().optional(), scoreMax: z.coerce.number().int().optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(['created_desc', 'created_asc', 'activity_desc', 'followup_asc', 'score_desc', 'stage_age_desc']).default('created_desc'),
}).passthrough(); // cf_<fieldKey>=value filters on custom fields

const CreateLead = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: z.string().max(20).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  city: z.string().trim().max(80).optional(),
  source: z.string().max(40).default('manual'),
  pipelineId: z.string().uuid().optional(),
  customFields: z.record(z.unknown()).optional(),
  // Optional at creation: who owns it ("rules" = workspace assignment rules), status, first remark and follow-up.
  ownerId: z.union([z.string().uuid(), z.literal('rules')]).optional(),
  status: z.string().max(60).optional(),
  remark: z.string().trim().max(2000).optional(),
  followUpAt: z.coerce.date().optional(),
});
const MoveStage = z.object({ stageId: z.string().uuid(), lostReason: z.string().trim().max(120).optional() });
const UpdateFields = z.object({ customFields: z.record(z.unknown()) });

const EXPORT_LIMIT = 5000;
const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const from = (d?: string) => (d ? new Date(`${d}T00:00:00`) : undefined);
const to = (d?: string) => (d ? new Date(new Date(`${d}T00:00:00`).getTime() + 86_400_000) : undefined);
const range = (a?: string, b?: string) => (a || b ? { ...(a ? { gte: from(a) } : {}), ...(b ? { lt: to(b) } : {}) } : undefined);

const ORDER: Record<string, Prisma.LeadOrderByWithRelationInput[]> = {
  created_desc: [{ createdAt: 'desc' }], created_asc: [{ createdAt: 'asc' }],
  activity_desc: [{ lastActivityAt: { sort: 'desc', nulls: 'last' } }], followup_asc: [{ nextFollowUpAt: { sort: 'asc', nulls: 'last' } }],
  score_desc: [{ score: 'desc' }], stage_age_desc: [{ stageChangedAt: 'asc' }],
};

@Controller('api/v1/leads')
@RequireFeature('module.crm')
export class LeadsController {
  constructor(private db: DbService) {}

  @Get()
  @RequirePermission('crm.lead.view')
  list(@Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const q = parse(ListQuery, query);
    return this.db.tenant(async (tx) => {
      const where = await this.filters(tx, q, 'crm.lead.view');
      const leads = await tx.lead.findMany({
        where,
        include: { customer: true, workspace: { select: { name: true } }, pipeline: { select: { name: true } } },
        orderBy: ORDER[q.sort],
        take: 500,
      });
      const total = await tx.lead.count({ where });
      const stageIds = [...new Set(leads.map((l) => l.stageId))];
      const ownerIds = [...new Set(leads.map((l) => l.ownerId).filter(Boolean) as string[])];
      const [stages, owners] = await Promise.all([
        tx.leadStage.findMany({ where: { id: { in: stageIds } } }),
        tx.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }),
      ]);
      const stage = new Map(stages.map((s) => [s.id, s]));
      const ownerName = new Map(owners.map((o) => [o.id, o.name]));
      const fa = await fieldAccess(tx);
      const rows = leads.map((l) => {
        const s = stage.get(l.stageId);
        const inStageDays = Math.max(0, Math.floor((Date.now() - l.stageChangedAt.getTime()) / 86_400_000));
        return {
          id: l.id, name: l.customer.name, mobile: contact(fa, 'mobile', l.customer.mobile), email: contact(fa, 'email', l.customer.email), city: l.customer.city,
          customerId: l.customerId, customerCode: l.customer.code, source: l.source,
          workspaceId: l.workspaceId, workspace: l.workspace.name, pipelineId: l.pipelineId, pipeline: l.pipeline.name,
          stageId: l.stageId, stage: s?.name, stageColor: s?.color ?? null, lostReason: l.lostReason, status: l.status,
          inStageDays, slaBreached: !!s?.slaDays && !s.isWon && !s.isLost && inStageDays >= s.slaDays,
          customFields: visibleFields(fa, l.customFields as Record<string, unknown>), score: l.score, labelIds: l.labelIds,
          ownerId: l.ownerId, owner: l.ownerId ? ownerName.get(l.ownerId) : null,
          nextFollowUpAt: l.nextFollowUpAt, lastActivityAt: l.lastActivityAt, lastDisposition: l.lastDisposition, createdAt: l.createdAt,
        };
      });
      res.setHeader('X-Total-Count', String(total)); // up to 500 rows are returned; the header tells how many match
      return rows;
    });
  }

  /** Creates a lead in the selected workspace; the customer is matched across the organization by the Lead ID. */
  @Post()
  @RequirePermission('crm.lead.create')
  create(@Body() body: unknown) {
    const input = parse(CreateLead, body);
    const a = auth();
    if (!a.workspaceId) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Select a workspace (business line) first' });

    return this.db.tenant(async (tx) => {
      const settings = await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() }, select: { leadIdentifier: true } });
      const byEmail = settings?.leadIdentifier === 'email';
      const mobile = input.mobile ? normalizeMobile(input.mobile) : null;
      if (input.mobile && !mobile) throw new BadRequestException({ code: 'INVALID_MOBILE', message: 'Enter a valid mobile number' });
      if (!byEmail && !mobile) throw new BadRequestException({ code: 'MOBILE_REQUIRED', message: 'Mobile number is required (it is your Lead ID)' });
      if (byEmail && !input.email) throw new BadRequestException({ code: 'EMAIL_REQUIRED', message: 'Email is required (it is your Lead ID)' });

      const pipeline = await tx.pipeline.findFirst({
        where: { workspaceId: a.workspaceId!, ...(input.pipelineId ? { id: input.pipelineId } : {}) },
        orderBy: { position: 'asc' },
        include: { stages: { orderBy: { position: 'asc' }, take: 1 } },
      });
      if (!pipeline) throw new NotFoundException({ code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found in this workspace' });
      await this.assertSource(tx, a.workspaceId!, input.source);
      const customFields = await this.checkFields(tx, a.workspaceId!, input.customFields);

      // One customer per person across all business lines: link to an existing record by the Lead ID first.
      const match = await findCustomer(tx, { mobile, email: input.email || null, preferEmail: byEmail });
      let customer = match?.customer ?? null;
      const isExistingCustomer = !!customer;
      if (!customer) {
        customer = await tx.customer.create({
          data: { tenantId: tenantId(), name: input.name, mobile, email: input.email || null, city: input.city || null, code: await nextCustomerCode(tx) },
        });
      } else if (match?.matchedBy === 'email' && mobile && mobile !== customer.mobile && !customer.alternateMobiles.includes(mobile)) {
        // Same person (by email) enquiring from another number: remember it as an alternate mobile.
        customer = await tx.customer.update({ where: { id: customer.id }, data: customer.mobile ? { alternateMobiles: { push: mobile } } : { mobile } });
      }
      if (input.city && !customer.city) customer = await tx.customer.update({ where: { id: customer.id }, data: { city: input.city } });
      // Owner: me by default; someone else or the assignment rules only with the assign permission.
      let ownerId = a.userId;
      if (input.ownerId && input.ownerId !== a.userId) {
        if (!a.permissions['crm.lead.assign']) throw new BadRequestException({ code: 'PERMISSION_DENIED', message: 'You can only add leads for yourself' });
        const ws = await tx.workspace.findUniqueOrThrow({ where: { id: a.workspaceId! } });
        const eligible = (await eligibleOwners(tx, ws.id)).map((u) => u.id);
        if (input.ownerId === 'rules') {
          const assigner = makeAssigner(ws, eligible, a.userId, await assignmentAvailability(tx));
          ownerId = assigner.pick(customer.primaryRmId);
          await tx.workspace.update({ where: { id: ws.id }, data: { assignmentCursor: assigner.state.cursor } });
        } else {
          if (!eligible.includes(input.ownerId)) throw new BadRequestException({ code: 'INVALID_OWNER', message: 'That person does not work in this business line' });
          ownerId = input.ownerId;
        }
      }
      let status = await defaultStatus(tx, a.workspaceId!);
      if (input.status) {
        const ok = await tx.workspaceOption.findFirst({ where: { workspaceId: a.workspaceId!, kind: 'lead_status', value: input.status, isArchived: false } });
        if (!ok) throw new BadRequestException({ code: 'INVALID_STATUS', message: 'Choose a status of this business line' });
        status = input.status;
      }
      const lead = await tx.lead.create({
        data: {
          tenantId: tenantId(), workspaceId: a.workspaceId!, pipelineId: pipeline.id, stageId: pipeline.stages[0].id,
          customerId: customer.id, source: input.source, ownerId, assignedAt: new Date(), customFields, status,
          nextFollowUpAt: input.followUpAt ?? null, lastActivityAt: input.remark ? new Date() : null,
        },
      });
      if (input.remark) await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'remark', remark: input.remark }) });
      if (input.followUpAt) {
        await tx.followUp.create({ data: { tenantId: tenantId(), leadId: lead.id, dueAt: input.followUpAt, userId: ownerId, createdById: a.userId } });
        await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'follow_up', data: { dueAt: input.followUpAt.toISOString() } }) });
      }
      if (ownerId !== a.userId) await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'assignment', data: { from: null, to: ownerId } }) });
      // First owner of a customer becomes the sticky Primary RM.
      await tx.customer.updateMany({ where: { id: customer.id, primaryRmId: null }, data: { primaryRmId: ownerId } });
      await this.db.audit(tx, {
        entity: 'lead', entityId: lead.id, action: 'lead.created',
        newValue: { name: input.name, source: input.source, customerCode: customer.code, existingCustomer: isExistingCustomer },
      });
      await emitEvent(tx, tenantId(), a.workspaceId!, 'lead.created', { leadId: lead.id, customerId: customer.id, customerCode: customer.code, name: customer.name, mobile: customer.mobile, email: customer.email, source: input.source, via: 'manual', ownerId, stageId: lead.stageId, customFields });
      return { id: lead.id, customerId: customer.id, customerCode: customer.code, existingCustomer: isExistingCustomer, matchedBy: match?.matchedBy ?? null, ownerId };
    });
  }

  @Patch(':id/stage')
  @RequirePermission('crm.lead.update')
  moveStage(@Param('id') id: string, @Body() body: unknown) {
    const { stageId, lostReason } = parse(MoveStage, body);
    return this.db.tenant(async (tx) => {
      const scope = await scopeFilter(tx, 'crm.lead.update');
      const lead = await tx.lead.findFirst({ where: { AND: [scope, { id }] } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const stage = await tx.leadStage.findFirst({ where: { id: stageId, pipelineId: lead.pipelineId } });
      if (!stage) throw new BadRequestException({ code: 'INVALID_STAGE', message: 'Stage does not belong to this pipeline' });
      if (stage.isLost && !lostReason && (await tx.workspaceOption.count({ where: { workspaceId: lead.workspaceId, kind: 'lost_reason', isArchived: false } }))) {
        throw new BadRequestException({ code: 'LOST_REASON_REQUIRED', message: 'Choose why this lead was lost' });
      }
      const old = await tx.leadStage.findUnique({ where: { id: lead.stageId } });
      const refused = await applyStageChange(tx, lead, stage, auth().userId, lostReason);
      if (refused) {
        throw new BadRequestException({ code: stage.isLost ? 'INVALID_LOST_REASON' : 'STAGE_RULE', message: refused });
      }
      await this.db.audit(tx, {
        workspaceId: lead.workspaceId, entity: 'lead', entityId: id, action: 'lead.stage_changed',
        oldValue: { stage: old?.name, lostReason: lead.lostReason }, newValue: { stage: stage.name, lostReason: stage.isLost ? lostReason ?? null : null },
      });
      const after = await tx.lead.findUniqueOrThrow({ where: { id }, select: { lostReason: true, status: true } });
      return { id, stage: stage.name, lostReason: after.lostReason, status: after.status };
    });
  }

  /** Updates some custom fields of a lead (only the keys sent are checked and changed). */
  @Patch(':id/fields')
  @RequirePermission('crm.lead.update')
  updateFields(@Param('id') id: string, @Body() body: unknown) {
    const { customFields } = parse(UpdateFields, body);
    return this.db.tenant(async (tx) => {
      const scope = await scopeFilter(tx, 'crm.lead.update');
      const lead = await tx.lead.findFirst({ where: { AND: [scope, { id }] } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const locked = lockedFields(await fieldAccess(tx), Object.keys(customFields).map((k) => `cf:${k}`));
      if (locked.length) throw new ForbiddenException({ code: 'FIELD_LOCKED', message: 'Your role cannot change some of these fields', details: locked });
      const changes = await this.checkFields(tx, lead.workspaceId, customFields, true);
      const before = (lead.customFields ?? {}) as Record<string, unknown>;
      const merged = { ...before, ...changes } as Prisma.InputJsonObject;
      await tx.lead.update({ where: { id }, data: { customFields: merged } });
      await this.db.audit(tx, {
        workspaceId: lead.workspaceId, entity: 'lead', entityId: id, action: 'lead.fields_changed',
        oldValue: Object.fromEntries(Object.keys(changes).map((k) => [k, before[k] ?? null])), newValue: changes,
      });
      return { id, customFields: merged };
    });
  }

  /** CSV export of exactly what the filters show: only records within the user's scope, capped, always audited. */
  @Get('export')
  @RequirePermission('crm.lead.export')
  async export(@Query() query: unknown, @Res() res: Response) {
    const q = parse(ListQuery, query);
    const rows = await this.db.tenant(async (tx) => {
      const where = await this.filters(tx, q, 'crm.lead.export');
      const leads = await tx.lead.findMany({ where, include: { customer: true, workspace: true, pipeline: true }, take: EXPORT_LIMIT, orderBy: ORDER[q.sort] });
      const stages = new Map((await tx.leadStage.findMany({ where: { id: { in: [...new Set(leads.map((l) => l.stageId))] } } })).map((s) => [s.id, s.name]));
      const owners = new Map((await tx.user.findMany({ where: { id: { in: leads.map((l) => l.ownerId).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const ws = auth().workspaceId;
      const fa = await fieldAccess(tx);
      const fields = (ws ? await tx.leadField.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { position: 'asc' } }) : []).filter((f) => fa.of(`cf:${f.key}`) !== 'hidden');
      await this.db.audit(tx, { entity: 'lead', entityId: 'export', action: 'lead.exported', newValue: { rows: leads.length, filters: Object.keys(query as object) } });
      return [
        ['Customer ID', 'Name', 'Mobile', 'Email', 'Business line', 'Pipeline', 'Stage', 'Status', 'Lost reason', 'Source', 'Owner', 'Score', 'Last call', 'Next follow-up', 'Created', ...fields.map((f) => f.label)],
        ...leads.map((l) => {
          const cf = visibleFields(fa, l.customFields as Record<string, unknown>);
          return [
            l.customer.code, l.customer.name, contact(fa, 'mobile', l.customer.mobile) ?? '', contact(fa, 'email', l.customer.email) ?? '', l.workspace.name, l.pipeline.name,
            stages.get(l.stageId) ?? '', l.status ?? '', l.lostReason ?? '', l.source, l.ownerId ? owners.get(l.ownerId) ?? '' : '', l.score,
            l.lastDisposition ?? '', l.nextFollowUpAt ? istStamp(l.nextFollowUpAt) : '', istStamp(l.createdAt),
            ...fields.map((f) => (Array.isArray(cf[f.key]) ? (cf[f.key] as string[]).join('; ') : String(cf[f.key] ?? ''))),
          ];
        }),
      ];
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send('﻿' + toCsv(rows));
  }

  // ── helpers ──

  /** Builds the lead filter from the query on top of the user's data scope. */
  private async filters(tx: Tx, q: z.infer<typeof ListQuery>, perm: 'crm.lead.view' | 'crm.lead.export'): Promise<Prisma.LeadWhereInput> {
    const and: Prisma.LeadWhereInput[] = [await scopeFilter(tx, perm)];
    const stageIds = [...q.stageIds, ...(q.stageId ? [q.stageId] : [])];
    const statuses = [...q.statuses, ...(q.status ? [q.status] : [])];
    const sources = [...q.sources, ...(q.source ? [q.source] : [])];
    const owners = [...q.owners, ...(q.owner ? [q.owner] : [])];
    if (q.pipelineId) and.push({ pipelineId: q.pipelineId });
    if (stageIds.length) and.push({ stageId: { in: stageIds } });
    if (statuses.length) and.push({ OR: [{ status: { in: statuses.filter((s) => s !== '__none__') } }, ...(statuses.includes('__none__') ? [{ status: null }] : [])] });
    if (sources.length) and.push({ source: { in: sources } });
    if (owners.length) {
      and.push({ OR: [
        ...(owners.includes('me') ? [{ ownerId: auth().userId }] : []),
        ...(owners.includes('unassigned') ? [{ ownerId: null }] : []),
        { ownerId: { in: owners.filter((o) => o !== 'me' && o !== 'unassigned') } },
      ] });
    }
    if (q.dispositions.length) and.push({ lastDisposition: { in: q.dispositions } });
    if (q.lostReasons.length) and.push({ lostReason: { in: q.lostReasons } });
    if (q.labelIds.length) and.push({ labelIds: { hasSome: q.labelIds } });
    const created = range(q.createdFrom, q.createdTo); if (created) and.push({ createdAt: created });
    const assigned = range(q.assignedFrom, q.assignedTo); if (assigned) and.push({ assignedAt: assigned });
    const act = range(q.activityFrom, q.activityTo); if (act) and.push({ lastActivityAt: act });
    const fu = range(q.followUpFrom, q.followUpTo); if (fu) and.push({ nextFollowUpAt: fu });
    if (q.followUp === 'today') and.push({ nextFollowUpAt: { gte: dayStart(), lt: new Date(dayStart().getTime() + 86_400_000) } });
    if (q.followUp === 'overdue') and.push({ nextFollowUpAt: { lt: new Date() } });
    if (q.followUp === 'none') and.push({ nextFollowUpAt: null });
    if (q.followUp === 'planned') and.push({ nextFollowUpAt: { not: null } });
    if (q.contacted === 'no') and.push({ lastActivityAt: null });
    if (q.contacted === 'yes') and.push({ lastActivityAt: { not: null } });
    if (q.scoreMin !== undefined) and.push({ score: { gte: q.scoreMin } });
    if (q.scoreMax !== undefined) and.push({ score: { lte: q.scoreMax } });
    if (q.stuck === 'yes') {
      // Leads that stayed in an open stage longer than that stage's SLA.
      const slaStages = await tx.leadStage.findMany({ where: { slaDays: { not: null }, isWon: false, isLost: false }, select: { id: true, slaDays: true } });
      and.push({ OR: slaStages.length ? slaStages.map((s) => ({ stageId: s.id, stageChangedAt: { lt: new Date(Date.now() - s.slaDays! * 86_400_000) } })) : [{ id: '__none__' }] });
    }
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      and.push({ customer: { OR: [
        { name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }, { code: { equals: q.q.toUpperCase() } },
        ...(digits.length >= 4 ? [{ mobile: { contains: digits } }] : []),
      ] } });
    }
    // Custom-field filters: cf_<key>=value. Lists (multi-select) match if they contain the value; text matches exactly.
    for (const [k, v] of Object.entries(q)) {
      if (!k.startsWith('cf_') || typeof v !== 'string' || !v) continue;
      const key = k.slice(3);
      if (!/^[a-z][a-z0-9_]{0,59}$/.test(key)) continue;
      and.push({ OR: [{ customFields: { path: [key], equals: v } }, { customFields: { path: [key], array_contains: [v] } }] });
    }
    return { AND: and };
  }

  /** Validates custom-field values against the workspace's field definitions; 400 with per-field messages. */
  private async checkFields(tx: Tx, workspaceId: string, input: Record<string, unknown> | undefined, partial = false) {
    const defs = await tx.leadField.findMany({ where: { workspaceId } });
    const { values, errors } = validateCustomFields(defs, input, { partial });
    if (Object.keys(errors).length) {
      throw new BadRequestException({ code: 'INVALID_FIELDS', message: Object.values(errors)[0], details: errors });
    }
    return values;
  }

  /** When a workspace has a source list, new leads must use one of its sources. */
  private async assertSource(tx: Tx, workspaceId: string, source: string) {
    const sources = await tx.workspaceOption.findMany({ where: { workspaceId, kind: 'lead_source', isArchived: false }, select: { value: true } });
    if (sources.length && !sources.some((s) => s.value === source)) {
      throw new BadRequestException({ code: 'INVALID_SOURCE', message: 'Choose one of the lead sources of this workspace' });
    }
  }
}
