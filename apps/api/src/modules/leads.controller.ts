import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { normalizeMobile } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';

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
});
const MoveStage = z.object({ stageId: z.string().uuid() });

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
        customerCode: l.customer.code,
        source: l.source,
        workspace: l.workspace.name,
        pipeline: l.pipeline.name,
        stageId: l.stageId,
        stage: stageName.get(l.stageId),
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

      let customer = await tx.customer.findFirst({ where: { mobile } });
      const isExistingCustomer = !!customer;
      if (!customer) {
        const count = await tx.customer.count();
        customer = await tx.customer.create({
          data: { tenantId: tenantId(), name: input.name, mobile, email: input.email || null, code: `C${String(count + 1).padStart(5, '0')}` },
        });
      }
      const lead = await tx.lead.create({
        data: {
          tenantId: tenantId(), workspaceId: a.workspaceId!, pipelineId: pipeline.id, stageId: pipeline.stages[0].id,
          customerId: customer.id, source: input.source, ownerId: a.userId,
        },
      });
      await this.db.audit(tx, {
        entity: 'lead', entityId: lead.id, action: 'lead.created',
        newValue: { name: input.name, source: input.source, customerCode: customer.code, existingCustomer: isExistingCustomer },
      });
      return { id: lead.id, customerCode: customer.code, existingCustomer: isExistingCustomer };
    });
  }

  @Patch(':id/stage')
  @RequirePermission('crm.lead.update')
  moveStage(@Param('id') id: string, @Body() body: unknown) {
    const { stageId } = parse(MoveStage, body);
    return this.db.tenant(async (tx) => {
      const scope = await scopeFilter(tx, 'crm.lead.update');
      const lead = await tx.lead.findFirst({ where: { AND: [scope, { id }] } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const stage = await tx.leadStage.findFirst({ where: { id: stageId, pipelineId: lead.pipelineId } });
      if (!stage) throw new BadRequestException({ code: 'INVALID_STAGE', message: 'Stage does not belong to this pipeline' });
      const old = await tx.leadStage.findUnique({ where: { id: lead.stageId } });
      await tx.lead.update({ where: { id }, data: { stageId } });
      await this.db.audit(tx, {
        workspaceId: lead.workspaceId, entity: 'lead', entityId: id, action: 'lead.stage_changed',
        oldValue: { stage: old?.name }, newValue: { stage: stage.name },
      });
      return { id, stage: stage.name };
    });
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
