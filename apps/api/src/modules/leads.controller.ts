import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { normalizeMobile, validateCustomFields } from '@ubos/shared';
import { Prisma } from '@ubos/database';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { findCustomer, nextCustomerCode } from '../common/customers';

const ListQuery = z.object({
  pipelineId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
});
const CreateLead = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: z.string().min(6).max(20),
  email: z.string().email().optional().or(z.literal('')),
  source: z.string().max(40).default('manual'),
  pipelineId: z.string().uuid().optional(),
  customFields: z.record(z.unknown()).optional(),
});
const MoveStage = z.object({ stageId: z.string().uuid(), lostReason: z.string().trim().max(120).optional() });
const UpdateFields = z.object({ customFields: z.record(z.unknown()) });

const EXPORT_LIMIT = 5000;

@Controller('api/v1/leads')
@RequireFeature('module.crm')
export class LeadsController {
  constructor(private db: DbService) {}

  @Get()
  @RequirePermission('crm.lead.view')
  list(@Query() query: unknown) {
    const q = parse(ListQuery, query);
    return this.db.tenant(async (tx) => {
      const scope = await scopeFilter(tx, 'crm.lead.view');
      const leads = await tx.lead.findMany({
        where: {
          AND: [
            scope,
            q.pipelineId ? { pipelineId: q.pipelineId } : {},
            q.stageId ? { stageId: q.stageId } : {},
            q.q ? { customer: { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { mobile: { contains: q.q } }] } } : {},
          ],
        },
        include: { customer: true, workspace: { select: { name: true } }, pipeline: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const stageIds = [...new Set(leads.map((l) => l.stageId))];
      const ownerIds = [...new Set(leads.map((l) => l.ownerId).filter(Boolean) as string[])];
      const [stages, owners] = await Promise.all([
        tx.leadStage.findMany({ where: { id: { in: stageIds } } }),
        tx.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }),
      ]);
      const stageName = new Map(stages.map((s) => [s.id, s.name]));
      const ownerName = new Map(owners.map((o) => [o.id, o.name]));
      return leads.map((l) => ({
        id: l.id,
        name: l.customer.name,
        mobile: l.customer.mobile,
        customerId: l.customerId,
        customerCode: l.customer.code,
        source: l.source,
        workspace: l.workspace.name,
        pipeline: l.pipeline.name,
        stageId: l.stageId,
        stage: stageName.get(l.stageId),
        lostReason: l.lostReason,
        customFields: l.customFields ?? {},
        owner: l.ownerId ? ownerName.get(l.ownerId) : null,
        createdAt: l.createdAt,
      }));
    });
  }

  /** Creates a lead in the selected workspace; the customer is matched by mobile across the whole organization. */
  @Post()
  @RequirePermission('crm.lead.create')
  create(@Body() body: unknown) {
    const input = parse(CreateLead, body);
    const a = auth();
    if (!a.workspaceId) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Select a workspace (business line) first' });
    const mobile = normalizeMobile(input.mobile);
    if (!mobile) throw new BadRequestException({ code: 'INVALID_MOBILE', message: 'Enter a valid mobile number' });

    return this.db.tenant(async (tx) => {
      const pipeline = await tx.pipeline.findFirst({
        where: { workspaceId: a.workspaceId!, ...(input.pipelineId ? { id: input.pipelineId } : {}) },
        include: { stages: { orderBy: { position: 'asc' }, take: 1 } },
      });
      if (!pipeline) throw new NotFoundException({ code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found in this workspace' });
      await this.assertSource(tx, a.workspaceId!, input.source);
      const customFields = await this.checkFields(tx, a.workspaceId!, input.customFields);

      // One customer per person across all business lines: link to an existing record by mobile / email.
      const match = await findCustomer(tx, { mobile, email: input.email || null });
      let customer = match?.customer ?? null;
      const isExistingCustomer = !!customer;
      if (!customer) {
        customer = await tx.customer.create({
          data: { tenantId: tenantId(), name: input.name, mobile, email: input.email || null, code: await nextCustomerCode(tx) },
        });
      } else if (match?.matchedBy === 'email' && mobile !== customer.mobile && !customer.alternateMobiles.includes(mobile)) {
        // Same person (by email) enquiring from another number: remember it as an alternate mobile.
        customer = await tx.customer.update({ where: { id: customer.id }, data: { alternateMobiles: { push: mobile } } });
      }
      const lead = await tx.lead.create({
        data: {
          tenantId: tenantId(), workspaceId: a.workspaceId!, pipelineId: pipeline.id, stageId: pipeline.stages[0].id,
          customerId: customer.id, source: input.source, ownerId: a.userId, customFields,
        },
      });
      await this.db.audit(tx, {
        entity: 'lead', entityId: lead.id, action: 'lead.created',
        newValue: { name: input.name, source: input.source, customerCode: customer.code, existingCustomer: isExistingCustomer },
      });
      return { id: lead.id, customerId: customer.id, customerCode: customer.code, existingCustomer: isExistingCustomer, matchedBy: match?.matchedBy ?? null };
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
      const old = await tx.leadStage.findUnique({ where: { id: lead.stageId } });
      let reason: string | null = null;
      if (stage.isLost) {
        const reasons = await tx.workspaceOption.findMany({ where: { workspaceId: lead.workspaceId, kind: 'lost_reason', isArchived: false } });
        if (reasons.length && !lostReason) {
          throw new BadRequestException({ code: 'LOST_REASON_REQUIRED', message: 'Choose why this lead was lost' });
        }
        if (reasons.length && !reasons.some((r) => r.value === lostReason)) {
          throw new BadRequestException({ code: 'INVALID_LOST_REASON', message: 'Choose one of the lost reasons of this workspace' });
        }
        reason = lostReason ?? null;
      }
      await tx.lead.update({ where: { id }, data: { stageId, lostReason: reason } });
      await this.db.audit(tx, {
        workspaceId: lead.workspaceId, entity: 'lead', entityId: id, action: 'lead.stage_changed',
        oldValue: { stage: old?.name, lostReason: lead.lostReason }, newValue: { stage: stage.name, lostReason: reason },
      });
      return { id, stage: stage.name, lostReason: reason };
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

  /** CSV export: only records within the user's scope, capped, and always audited. */
  @Get('export')
  @RequirePermission('crm.lead.export')
  async export(@Res() res: Response) {
    const rows = await this.db.tenant(async (tx) => {
      const scope = await scopeFilter(tx, 'crm.lead.export');
      const leads = await tx.lead.findMany({
        where: scope, include: { customer: true, workspace: true, pipeline: true }, take: EXPORT_LIMIT, orderBy: { createdAt: 'desc' },
      });
      const stages = new Map((await tx.leadStage.findMany()).map((s) => [s.id, s.name]));
      await this.db.audit(tx, { entity: 'lead', entityId: 'export', action: 'lead.exported', newValue: { rows: leads.length } });
      return leads.map((l) => [l.customer.code, l.customer.name, l.customer.mobile ?? '', l.workspace.name, l.pipeline.name, stages.get(l.stageId) ?? '', l.source, l.createdAt.toISOString()]);
    });
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [['Customer ID', 'Name', 'Mobile', 'Workspace', 'Pipeline', 'Stage', 'Source', 'Created'], ...rows]
      .map((r) => r.map(esc).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send('﻿' + csv);
  }
}
