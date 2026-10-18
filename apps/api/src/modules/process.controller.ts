import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_ROLE } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { activity } from '../common/lead-ops';
import { notify } from '../common/notify';
import { activateStep, finishStep, gateProblem, startRun, stepAccess, type StepField } from '../common/process-engine';

const FieldDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, digits and _'), label: z.string().trim().min(1).max(60),
  type: z.enum(['text', 'textarea', 'number', 'date', 'dropdown', 'checkbox', 'url']), options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  required: z.boolean().default(false),
});
const StepDef = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(2).max(80), instructions: z.string().trim().max(2000).nullable().optional(),
  assignTo: z.enum(['lead_owner', 'user', 'role']).default('lead_owner'), assigneeUserId: z.string().uuid().nullable().optional(), ownerRoleId: z.string().uuid().nullable().optional(),
  dueDays: z.number().int().min(0).max(365).nullable().optional(), fields: z.array(FieldDef).max(40).default([]),
  minPaymentPct: z.number().int().min(1).max(100).nullable().optional(), requiresApproval: z.boolean().default(false),
  access: z.record(z.string().uuid(), z.enum(['edit', 'view', 'none'])).default({}),
});
const TemplateBody = z.object({
  name: z.string().trim().min(2).max(80), description: z.string().trim().max(1000).nullable().optional(), trigger: z.enum(['won', 'manual']).default('won'),
  packageIds: z.array(z.string().uuid()).max(100).default([]), steps: z.array(StepDef).min(1).max(30),
});
const StepData = z.object({ data: z.record(z.string(), z.unknown()).default({}) });
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });
const SendBack = z.object({ toStepRunId: z.string().uuid(), reason: z.string().trim().min(3).max(500) });
const Rating = z.object({ rating: z.number().int().min(1).max(5), note: z.string().trim().max(1000).nullable().optional() });
const Decide = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).nullable().optional() });
const Start = z.object({ templateId: z.string().uuid() });
const RunsQuery = z.object({ status: z.enum(['active', 'completed', 'cancelled', 'all']).default('active'), templateId: z.string().uuid().optional(), mine: z.enum(['true', 'false']).default('false') });
const ApprovalsQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending') });

const csv = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** After-sale processes: templates (steps, owners, forms, gates, access), runs on won leads, lock / unlock, send back, approvals. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class ProcessController {
  constructor(private db: DbService) {}

  // ── Templates ──

  @Get('process-templates')
  @RequirePermission('crm.lead.view')
  templates(@Query('archived') archived?: string) {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const rows = await tx.processTemplate.findMany({
        where: { workspaceId: ws, isArchived: archived === 'true' },
        include: { steps: { where: { isArchived: false }, orderBy: { position: 'asc' } } }, orderBy: { name: 'asc' },
      });
      const counts = await tx.processRun.groupBy({ by: ['templateId', 'status'], where: { workspaceId: ws }, _count: true });
      return rows.map((t) => ({
        ...t, canManage: this.canManage(ws),
        activeRuns: counts.filter((c) => c.templateId === t.id && c.status === 'active').reduce((s, c) => s + c._count, 0),
        completedRuns: counts.filter((c) => c.templateId === t.id && c.status === 'completed').reduce((s, c) => s + c._count, 0),
      }));
    });
  }

  @Post('process-templates')
  @RequirePermission('process.manage')
  createTemplate(@Body() body: unknown) {
    const input = parse(TemplateBody, body);
    const ws = this.ws();
    this.assertManage(ws);
    return this.db.tenant(async (tx) => {
      await this.checkTemplate(tx, ws, input);
      const t = await tx.processTemplate.create({
        data: {
          tenantId: tenantId(), workspaceId: ws, name: input.name, description: input.description ?? null, trigger: input.trigger, packageIds: input.packageIds, createdById: auth().userId,
          steps: { create: input.steps.map((s, i) => this.stepData(s, i)) },
        },
        include: { steps: { orderBy: { position: 'asc' } } },
      });
      await this.db.audit(tx, { workspaceId: ws, entity: 'process_template', entityId: t.id, action: 'process_template.created', newValue: input });
      return t;
    });
  }

  /** Saves the whole template; steps left out are archived (running processes keep them). */
  @Put('process-templates/:id')
  @RequirePermission('process.manage')
  updateTemplate(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(TemplateBody, body);
    return this.db.tenant(async (tx) => {
      const t = await tx.processTemplate.findUnique({ where: { id }, include: { steps: true } });
      if (!t) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Process template not found' });
      this.assertManage(t.workspaceId);
      await this.checkTemplate(tx, t.workspaceId, input);
      const keep = new Set(input.steps.map((s) => s.id).filter(Boolean));
      if ([...keep].some((sid) => !t.steps.some((s) => s.id === sid))) throw new BadRequestException({ code: 'INVALID_STEP', message: 'A step does not belong to this template' });
      await tx.processTemplate.update({ where: { id }, data: { name: input.name, description: input.description ?? null, trigger: input.trigger, packageIds: input.packageIds } });
      await tx.processStep.updateMany({ where: { templateId: id, id: { notIn: [...keep] as string[] } }, data: { isArchived: true } });
      for (const [i, s] of input.steps.entries()) {
        const { tenantId: _t, ...data } = this.stepData(s, i);
        if (s.id) await tx.processStep.update({ where: { id: s.id }, data: { ...data, isArchived: false } });
        else await tx.processStep.create({ data: { ...this.stepData(s, i), templateId: id } });
      }
      await this.db.audit(tx, {
        workspaceId: t.workspaceId, entity: 'process_template', entityId: id, action: 'process_template.updated',
        oldValue: { name: t.name, steps: t.steps.filter((s) => !s.isArchived).map((s) => s.name) }, newValue: { name: input.name, steps: input.steps.map((s) => s.name) },
      });
      return tx.processTemplate.findUnique({ where: { id }, include: { steps: { where: { isArchived: false }, orderBy: { position: 'asc' } } } });
    });
  }

  @Post('process-templates/:id/archive')
  @RequirePermission('process.manage')
  archiveTemplate(@Param('id') id: string) { return this.setArchived(id, true); }

  @Post('process-templates/:id/restore')
  @RequirePermission('process.manage')
  restoreTemplate(@Param('id') id: string) { return this.setArchived(id, false); }

  // ── Runs on a lead ──

  @Get('leads/:id/processes')
  @RequirePermission('crm.lead.view')
  leadProcesses(@Param('id') leadId: string) {
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, leadId, 'crm.lead.view');
      const runs = await tx.processRun.findMany({ where: { leadId }, include: { steps: { orderBy: { position: 'asc' } } }, orderBy: { startedAt: 'desc' } });
      const templates = await tx.processTemplate.findMany({ where: { workspaceId: lead.workspaceId }, include: { steps: true } });
      const canEditLead = !!(await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'process.work'), { id: leadId }] }, select: { id: true } }));
      const ctxAccess = await this.accessCtx(tx, lead.workspaceId);
      const userIds = [...new Set(runs.flatMap((r) => r.steps.flatMap((s) => [s.assigneeId, s.completedById])).filter(Boolean) as string[])];
      const users = new Map((await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const payments = await tx.payment.findMany({ where: { OR: [{ leadId }, { runId: { in: runs.map((r) => r.id) } }] }, orderBy: { receivedAt: 'desc' } });
      const approvals = await tx.approvalRequest.findMany({ where: { kind: 'process_step', entityId: { in: runs.flatMap((r) => r.steps.map((s) => s.id)) } }, orderBy: { createdAt: 'desc' } });
      return {
        canStart: canEditLead,
        startable: templates.filter((t) => !t.isArchived).map((t) => ({ id: t.id, name: t.name, trigger: t.trigger })),
        canUnlock: !!auth().permissions['process.unlock'],
        canPay: !!auth().permissions['process.payment'],
        runs: runs.map((r) => {
          const t = templates.find((x) => x.id === r.templateId)!;
          const received = payments.filter((p) => p.runId === r.id && !p.isVoided).reduce((s, p) => s + p.amountPaise, 0);
          return {
            id: r.id, status: r.status, templateId: r.templateId, templateName: t?.name, dealValuePaise: r.dealValuePaise, receivedPaise: received,
            balancePaise: Math.max(0, r.dealValuePaise - received), paidPct: r.dealValuePaise ? Math.min(100, Math.floor((received * 100) / r.dealValuePaise)) : 0,
            startedAt: r.startedAt, completedAt: r.completedAt, cancelledReason: r.cancelledReason, rating: r.rating, ratingNote: r.ratingNote, quoteId: r.quoteId,
            steps: r.steps.map((s) => {
              const def = t?.steps.find((x) => x.id === s.stepId);
              const access = canEditLead ? stepAccess(def?.access, ctxAccess.roleIds, ctxAccess.isAdmin, true) : (stepAccess(def?.access, ctxAccess.roleIds, ctxAccess.isAdmin, false) === 'none' ? 'none' : 'view');
              const ap = approvals.find((a) => a.entityId === s.id);
              return {
                id: s.id, stepId: s.stepId, position: s.position, name: def?.name ?? 'Step', instructions: def?.instructions ?? null, status: s.status, locked: s.locked,
                assigneeId: s.assigneeId, assigneeName: s.assigneeId ? users.get(s.assigneeId) ?? null : null, dueAt: s.dueAt, startedAt: s.startedAt,
                completedAt: s.completedAt, completedByName: s.completedById ? users.get(s.completedById) ?? null : null, sentBackCount: s.sentBackCount,
                minPaymentPct: def?.minPaymentPct ?? null, requiresApproval: !!def?.requiresApproval, access,
                fields: access === 'none' ? [] : ((def?.fields ?? []) as unknown as StepField[]),
                data: access === 'none' ? {} : s.data,
                approval: ap ? { id: ap.id, status: ap.status, decisionNote: ap.decisionNote } : null,
              };
            }),
          };
        }),
        payments: payments.map((p) => ({ ...p })),
      };
    });
  }

  @Post('leads/:id/processes')
  @RequirePermission('process.work')
  start(@Param('id') leadId: string, @Body() body: unknown) {
    const input = parse(Start, body);
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, leadId, 'process.work');
      const t = await tx.processTemplate.findFirst({ where: { id: input.templateId, workspaceId: lead.workspaceId, isArchived: false } });
      if (!t) throw new BadRequestException({ code: 'INVALID_TEMPLATE', message: 'Choose an active process of this business line' });
      if (await tx.processRun.findFirst({ where: { leadId, templateId: t.id, status: 'active' } })) throw new BadRequestException({ code: 'ALREADY_RUNNING', message: 'This process is already running for the lead' });
      const quote = await tx.quote.findFirst({ where: { leadId, status: 'accepted' }, orderBy: { decidedAt: 'desc' } });
      const run = await startRun(tx, t.id, lead, auth().userId, quote?.id);
      await this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'process_run', entityId: run.id, action: 'process.started', newValue: { leadId, templateId: t.id } });
      return run;
    });
  }

  @Get('process-runs')
  @RequirePermission('crm.lead.view')
  runs(@Query() query: unknown) {
    const q = parse(RunsQuery, query);
    return this.db.tenant(async (tx) => {
      const leads = await tx.lead.findMany({ where: await scopeFilter(tx, 'crm.lead.view'), select: { id: true } , take: 50_000 });
      const runs = await tx.processRun.findMany({
        where: {
          leadId: { in: leads.map((l) => l.id) }, ...(q.status === 'all' ? {} : { status: q.status }), ...(q.templateId ? { templateId: q.templateId } : {}),
          ...(q.mine === 'true' ? { steps: { some: { assigneeId: auth().userId, status: { in: ['active', 'awaiting_approval'] } } } } : {}),
        },
        include: { steps: { orderBy: { position: 'asc' } } }, orderBy: { startedAt: 'desc' }, take: 500,
      });
      return this.describeRuns(tx, runs);
    });
  }

  /** Process report: one row per run with every step's status and the payments. */
  @Get('process-runs/report.csv')
  @RequirePermission('crm.lead.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  report(@Query() query: unknown) {
    const q = parse(RunsQuery, query);
    return this.db.tenant(async (tx) => {
      const leads = await tx.lead.findMany({ where: await scopeFilter(tx, 'crm.lead.export'), select: { id: true }, take: 50_000 });
      const runs = await tx.processRun.findMany({
        where: { leadId: { in: leads.map((l) => l.id) }, ...(q.status === 'all' ? {} : { status: q.status }), ...(q.templateId ? { templateId: q.templateId } : {}) },
        include: { steps: { orderBy: { position: 'asc' } } }, orderBy: { startedAt: 'asc' }, take: 20_000,
      });
      const rows = await this.describeRuns(tx, runs);
      const header = ['Process', 'Customer', 'Customer ID', 'Business line', 'Status', 'Current step', 'Steps done', 'Deal value', 'Received', 'Balance', 'Started', 'Completed', 'Rating', 'Steps'];
      const lines = rows.map((r) => [
        r.templateName, r.customerName, r.customerCode, r.workspaceName, r.status, r.currentStep ?? '', `${r.doneSteps}/${r.totalSteps}`,
        (r.dealValuePaise / 100).toFixed(2), (r.receivedPaise / 100).toFixed(2), (r.balancePaise / 100).toFixed(2),
        r.startedAt.toISOString(), r.completedAt?.toISOString() ?? '', r.rating ?? '', r.steps.map((s) => `${s.name}: ${s.status}`).join(' | '),
      ].map(csv).join(','));
      await this.db.audit(tx, { entity: 'process_run', entityId: 'report', action: 'process.report_exported', newValue: { rows: rows.length, status: q.status } });
      return [header.join(','), ...lines].join('\n');
    });
  }

  // ── Steps ──

  @Put('process-steps/:id')
  @RequirePermission('process.work')
  saveStep(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(StepData, body);
    return this.db.tenant(async (tx) => {
      const { sr, def } = await this.editableStep(tx, id);
      const data = this.cleanData(def.fields as unknown as StepField[], { ...(sr.data as object), ...input.data });
      await tx.stepRun.update({ where: { id }, data: { data: data as object } });
      return { ok: true, data };
    });
  }

  /** Completes a step when its gates pass; steps that need sign-off wait for an approver. */
  @Post('process-steps/:id/complete')
  @RequirePermission('process.work')
  complete(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(StepData, body ?? {});
    return this.db.tenant(async (tx) => {
      const { sr, def, run, lead } = await this.editableStep(tx, id);
      const data = this.cleanData(def.fields as unknown as StepField[], { ...(sr.data as object), ...input.data });
      const updated = await tx.stepRun.update({ where: { id }, data: { data: data as object } });
      const problem = await gateProblem(tx, updated, def);
      if (problem) throw new BadRequestException({ code: 'STEP_GATE', message: problem });
      if (def.requiresApproval) {
        const ap = await tx.approvalRequest.create({
          data: { tenantId: tenantId(), workspaceId: run.workspaceId, leadId: lead.id, kind: 'process_step', entityId: id, requestedById: auth().userId, title: `Sign-off: ${def.name}`, details: { runId: run.id } },
        });
        await tx.stepRun.update({ where: { id }, data: { status: 'awaiting_approval', approvalId: ap.id } });
        await notify(tx, await this.approvers(tx, run.workspaceId), { type: 'approval', title: `Approval needed: ${def.name}`, link: '/app/approvals' });
        await this.db.audit(tx, { workspaceId: run.workspaceId, entity: 'step_run', entityId: id, action: 'process.step_submitted', newValue: { approvalId: ap.id } });
        return { status: 'awaiting_approval', approvalId: ap.id };
      }
      const r = await finishStep(tx, id, auth().userId);
      await this.db.audit(tx, { workspaceId: run.workspaceId, entity: 'step_run', entityId: id, action: 'process.step_completed', newValue: { step: def.name, data } });
      return { status: 'done', runCompleted: r.completed };
    });
  }

  /** Re-opens a completed (locked) step for changes. Needs process.unlock and a reason; audited. */
  @Post('process-steps/:id/unlock')
  @RequirePermission('process.unlock')
  unlock(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Reason, body);
    return this.db.tenant(async (tx) => {
      const { sr, def, run, lead } = await this.stepInScope(tx, id, 'process.unlock');
      if (!sr.locked) throw new BadRequestException({ code: 'NOT_LOCKED', message: 'This step is not locked' });
      if (run.status === 'cancelled') throw new BadRequestException({ code: 'RUN_CLOSED', message: 'This process was cancelled' });
      await tx.stepRun.update({ where: { id }, data: { locked: false, status: 'active', completedAt: null } });
      if (run.status === 'completed') await tx.processRun.update({ where: { id: run.id }, data: { status: 'active', completedAt: null } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'process', remark: `Step unlocked: ${def.name} — ${input.reason}`, data: { runId: run.id, stepRunId: id } }) });
      await this.db.audit(tx, { workspaceId: run.workspaceId, entity: 'step_run', entityId: id, action: 'process.step_unlocked', oldValue: { locked: true }, newValue: { reason: input.reason } });
      if (sr.assigneeId) await notify(tx, [sr.assigneeId], { type: 'process', title: `Step unlocked for changes: ${def.name}`, body: input.reason, link: `/app/leads/${lead.id}?tab=process` });
      return { ok: true };
    });
  }

  /** Sends the process back to an earlier step with a reason; later steps wait again (their data is kept). */
  @Post('process-runs/:id/send-back')
  @RequirePermission('process.work')
  sendBack(@Param('id') runId: string, @Body() body: unknown) {
    const input = parse(SendBack, body);
    return this.db.tenant(async (tx) => {
      const run = await tx.processRun.findUnique({ where: { id: runId }, include: { steps: { orderBy: { position: 'asc' } } } });
      if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Process not found' });
      const lead = await this.lead(tx, run.leadId, 'process.work');
      if (run.status !== 'active') throw new BadRequestException({ code: 'RUN_CLOSED', message: 'Only a running process can be sent back' });
      const target = run.steps.find((s) => s.id === input.toStepRunId);
      const current = run.steps.find((s) => s.status === 'active' || s.status === 'awaiting_approval');
      if (!target || !current || target.position >= current.position) throw new BadRequestException({ code: 'INVALID_STEP', message: 'Choose an earlier step of this process' });
      const defs = await tx.processStep.findMany({ where: { id: { in: run.steps.map((s) => s.stepId) } } });
      const curDef = defs.find((d) => d.id === current.stepId)!;
      const acc = await this.accessCtx(tx, run.workspaceId);
      if (stepAccess(curDef.access, acc.roleIds, acc.isAdmin, true) !== 'edit') throw new ForbiddenException({ code: 'STEP_ACCESS', message: 'You cannot work on the current step' });
      for (const s of run.steps.filter((x) => x.position > target.position && x.status !== 'pending')) {
        if (s.approvalId) await tx.approvalRequest.updateMany({ where: { id: s.approvalId, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } });
        await tx.stepRun.update({ where: { id: s.id }, data: { status: 'pending', locked: false, completedAt: null, completedById: null, approvalId: null } });
      }
      await tx.stepRun.update({ where: { id: target.id }, data: { sentBackCount: { increment: 1 } } });
      const tDef = defs.find((d) => d.id === target.stepId)!;
      await activateStep(tx, target.id, tDef, lead, true);
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'process', remark: `Sent back to ${tDef.name}: ${input.reason}`, data: { runId, from: current.id, to: target.id } }) });
      await this.db.audit(tx, { workspaceId: run.workspaceId, entity: 'process_run', entityId: runId, action: 'process.sent_back', oldValue: { step: curDef.name }, newValue: { step: tDef.name, reason: input.reason } });
      return { ok: true };
    });
  }

  @Post('process-runs/:id/cancel')
  @RequirePermission('process.approve')
  cancel(@Param('id') runId: string, @Body() body: unknown) {
    const input = parse(Reason, body);
    return this.db.tenant(async (tx) => {
      const run = await tx.processRun.findUnique({ where: { id: runId } });
      if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Process not found' });
      const lead = await this.lead(tx, run.leadId, 'process.approve');
      if (run.status !== 'active') throw new BadRequestException({ code: 'RUN_CLOSED', message: 'This process is not running' });
      await tx.processRun.update({ where: { id: runId }, data: { status: 'cancelled', cancelledReason: input.reason, completedAt: new Date() } });
      await tx.approvalRequest.updateMany({ where: { kind: 'process_step', status: 'pending', entityId: { in: (await tx.stepRun.findMany({ where: { runId }, select: { id: true } })).map((s) => s.id) } }, data: { status: 'cancelled', decidedAt: new Date() } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'process', remark: `Process cancelled: ${input.reason}`, data: { runId } }) });
      await this.db.audit(tx, { workspaceId: run.workspaceId, entity: 'process_run', entityId: runId, action: 'process.cancelled', newValue: input });
      return { ok: true };
    });
  }

  /** Customer rating when the process is complete (also stored on the lead). */
  @Post('process-runs/:id/rating')
  @RequirePermission('process.work')
  rate(@Param('id') runId: string, @Body() body: unknown) {
    const input = parse(Rating, body);
    return this.db.tenant(async (tx) => {
      const run = await tx.processRun.findUnique({ where: { id: runId } });
      if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Process not found' });
      const lead = await this.lead(tx, run.leadId, 'process.work');
      if (run.status !== 'completed') throw new BadRequestException({ code: 'RUN_NOT_COMPLETED', message: 'Rate the customer’s experience once the process is complete' });
      await tx.processRun.update({ where: { id: runId }, data: { rating: input.rating, ratingNote: input.note ?? null } });
      await tx.lead.update({ where: { id: lead.id }, data: { rating: input.rating } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'process', remark: `Customer rating: ${'★'.repeat(input.rating)}${input.note ? ` — ${input.note}` : ''}`, data: { runId } }) });
      await this.db.audit(tx, { workspaceId: run.workspaceId, entity: 'process_run', entityId: runId, action: 'process.rated', oldValue: { rating: run.rating }, newValue: input });
      return { ok: true };
    });
  }

  // ── Approvals ──

  @Get('approvals')
  @RequirePermission('crm.lead.view')
  approvals(@Query() query: unknown) {
    const q = parse(ApprovalsQuery, query);
    return this.db.tenant(async (tx) => {
      const a = auth();
      const canDecide = !!a.permissions['process.approve'];
      const scope = await scopeFilter(tx, canDecide ? 'process.approve' : 'crm.lead.view');
      const leads = await tx.lead.findMany({ where: scope, select: { id: true }, take: 50_000 });
      const rows = await tx.approvalRequest.findMany({
        where: {
          ...(q.status === 'all' ? {} : { status: q.status }),
          // Approvers see requests on leads in their scope; everyone else sees only their own requests.
          ...(canDecide ? { leadId: { in: leads.map((l) => l.id) } } : { requestedById: a.userId }),
        },
        orderBy: { createdAt: 'desc' }, take: 300,
      });
      const users = new Map((await tx.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter(Boolean) as string[])] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const leadRows = await tx.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId).filter(Boolean) as string[] } }, select: { id: true, customer: { select: { name: true } } } });
      return {
        canDecide,
        items: rows.map((r) => ({
          ...r, requestedByName: users.get(r.requestedById) ?? null, decidedByName: r.decidedById ? users.get(r.decidedById) ?? null : null,
          customerName: leadRows.find((l) => l.id === r.leadId)?.customer.name ?? null, isMine: r.requestedById === a.userId,
        })),
      };
    });
  }

  @Post('approvals/:id/decide')
  @RequirePermission('process.approve')
  decide(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Decide, body);
    return this.db.tenant(async (tx) => {
      const a = auth();
      const ap = await tx.approvalRequest.findUnique({ where: { id } });
      if (!ap) throw new NotFoundException({ code: 'APPROVAL_NOT_FOUND', message: 'Approval request not found' });
      if (ap.leadId) await this.lead(tx, ap.leadId, 'process.approve');
      if (ap.status !== 'pending') throw new BadRequestException({ code: 'ALREADY_DECIDED', message: `This request is already ${ap.status}` });
      // Nobody approves their own request — except organization-wide approvers (e.g. the owner of a small business).
      if (ap.requestedById === a.userId && a.permissions['process.approve'] !== 'ORGANIZATION') throw new ForbiddenException({ code: 'SELF_APPROVAL', message: 'Someone else has to approve your own request' });
      if (input.decision === 'reject' && !input.note) throw new BadRequestException({ code: 'NOTE_REQUIRED', message: 'Say why it is rejected' });
      const approved = input.decision === 'approve';
      await tx.approvalRequest.update({ where: { id }, data: { status: approved ? 'approved' : 'rejected', decidedById: a.userId, decidedAt: new Date(), decisionNote: input.note ?? null } });
      const lead = ap.leadId ? await tx.lead.findUnique({ where: { id: ap.leadId } }) : null;
      if (ap.kind === 'quote_discount') {
        const q = await tx.quote.findUnique({ where: { id: ap.entityId } });
        if (q && q.approvalId === id) await tx.quote.update({ where: { id: q.id }, data: { status: approved ? 'approved' : 'draft', ...(approved ? {} : { approvalId: null }) } });
        if (lead && q) await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'quote', remark: `Discount on ${q.number} ${approved ? 'approved' : 'rejected'}${input.note ? `: ${input.note}` : ''}`, data: { quoteId: q.id, approvalId: id } }) });
      } else if (ap.kind === 'process_step') {
        const sr = await tx.stepRun.findUnique({ where: { id: ap.entityId } });
        if (sr && sr.approvalId === id && sr.status === 'awaiting_approval') {
          if (approved) await finishStep(tx, sr.id, a.userId);
          else await tx.stepRun.update({ where: { id: sr.id }, data: { status: 'active', approvalId: null } });
          if (lead && !approved) await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'process', remark: `Sign-off rejected: ${input.note}`, data: { stepRunId: sr.id, approvalId: id } }) });
        }
      }
      await notify(tx, [ap.requestedById], { type: 'approval', title: `${approved ? 'Approved' : 'Rejected'}: ${ap.title}`, body: input.note ?? null, link: ap.leadId ? `/app/leads/${ap.leadId}` : '/app/approvals' });
      await this.db.audit(tx, { workspaceId: ap.workspaceId, entity: 'approval', entityId: id, action: approved ? 'approval.approved' : 'approval.rejected', newValue: { kind: ap.kind, note: input.note ?? null } });
      return { status: approved ? 'approved' : 'rejected' };
    });
  }

  // ── helpers ──

  private ws() {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return ws;
  }

  private canManage(workspaceId: string) {
    const a = auth();
    const scope = a.permissions['process.manage'];
    return scope === 'ORGANIZATION' || (!!scope && a.workspaceId === workspaceId);
  }

  private assertManage(workspaceId: string) {
    if (!this.canManage(workspaceId)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can design processes' });
  }

  private async setArchived(id: string, isArchived: boolean) {
    return this.db.tenant(async (tx) => {
      const t = await tx.processTemplate.findUnique({ where: { id } });
      if (!t) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Process template not found' });
      this.assertManage(t.workspaceId);
      await tx.processTemplate.update({ where: { id }, data: { isArchived } });
      await this.db.audit(tx, { workspaceId: t.workspaceId, entity: 'process_template', entityId: id, action: isArchived ? 'process_template.archived' : 'process_template.restored' });
      return { ok: true };
    });
  }

  private stepData(s: z.infer<typeof StepDef>, position: number) {
    return {
      tenantId: tenantId(), position, name: s.name, instructions: s.instructions ?? null, assignTo: s.assignTo,
      assigneeUserId: s.assignTo === 'user' ? s.assigneeUserId ?? null : null, ownerRoleId: s.ownerRoleId ?? null, dueDays: s.dueDays ?? null,
      fields: s.fields, minPaymentPct: s.minPaymentPct ?? null, requiresApproval: s.requiresApproval, access: s.access,
    };
  }

  private async checkTemplate(tx: Tx, ws: string, input: z.infer<typeof TemplateBody>) {
    for (const s of input.steps) {
      if (s.assignTo === 'user' && !s.assigneeUserId) throw new BadRequestException({ code: 'ASSIGNEE_REQUIRED', message: `Choose who does “${s.name}”` });
      if (s.assignTo === 'role' && !s.ownerRoleId) throw new BadRequestException({ code: 'ROLE_REQUIRED', message: `Choose the responsible role for “${s.name}”` });
      const keys = s.fields.map((f) => f.key);
      if (new Set(keys).size !== keys.length) throw new BadRequestException({ code: 'DUPLICATE_FIELD', message: `Two fields in “${s.name}” have the same key` });
      if (s.fields.some((f) => f.type === 'dropdown' && !f.options.length)) throw new BadRequestException({ code: 'OPTIONS_REQUIRED', message: 'A dropdown field needs options' });
    }
    const roleIds = [...new Set(input.steps.flatMap((s) => [s.ownerRoleId, ...Object.keys(s.access)]).filter(Boolean) as string[])];
    if (roleIds.length && (await tx.role.count({ where: { id: { in: roleIds } } })) !== roleIds.length) throw new BadRequestException({ code: 'INVALID_ROLE', message: 'Choose roles of this organization' });
    const userIds = input.steps.map((s) => s.assigneeUserId).filter(Boolean) as string[];
    if (userIds.length && (await tx.user.count({ where: { id: { in: userIds }, isActive: true } })) !== new Set(userIds).size) throw new BadRequestException({ code: 'INVALID_ASSIGNEE', message: 'Choose active people' });
    if (input.packageIds.length && (await tx.package.count({ where: { id: { in: input.packageIds }, workspaceId: ws } })) !== input.packageIds.length) throw new BadRequestException({ code: 'INVALID_PRODUCT', message: 'Choose products of this business line' });
  }

  private async lead(tx: Tx, id: string, perm: 'crm.lead.view' | 'process.work' | 'process.unlock' | 'process.approve') {
    const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, perm), { id }] } });
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return lead;
  }

  private async accessCtx(tx: Tx, workspaceId: string) {
    const now = new Date();
    const roles = await tx.userRole.findMany({
      where: { userId: auth().userId, OR: [{ workspaceId }, { workspaceId: null }], AND: [{ OR: [{ validTo: null }, { validTo: { gt: now } }] }] },
      include: { role: { select: { name: true } } },
    });
    return { roleIds: roles.map((r) => r.roleId), isAdmin: roles.some((r) => r.role.name === ADMIN_ROLE) };
  }

  private async stepInScope(tx: Tx, id: string, perm: 'process.work' | 'process.unlock') {
    const sr = await tx.stepRun.findUnique({ where: { id } });
    if (!sr) throw new NotFoundException({ code: 'STEP_NOT_FOUND', message: 'Step not found' });
    const run = await tx.processRun.findUniqueOrThrow({ where: { id: sr.runId } });
    const lead = await this.lead(tx, run.leadId, perm);
    const def = await tx.processStep.findUniqueOrThrow({ where: { id: sr.stepId } });
    return { sr, run, lead, def };
  }

  /** The step must be the person's to edit: running process, step active and unlocked, edit access for their role. */
  private async editableStep(tx: Tx, id: string) {
    const x = await this.stepInScope(tx, id, 'process.work');
    if (x.run.status !== 'active') throw new BadRequestException({ code: 'RUN_CLOSED', message: 'This process is not running' });
    if (x.sr.locked) throw new BadRequestException({ code: 'STEP_LOCKED', message: 'This step is completed and locked — ask someone with unlock rights' });
    if (x.sr.status === 'pending') throw new BadRequestException({ code: 'STEP_NOT_STARTED', message: 'Finish the earlier steps first' });
    if (x.sr.status === 'awaiting_approval') throw new BadRequestException({ code: 'AWAITING_APPROVAL', message: 'This step is waiting for approval' });
    const acc = await this.accessCtx(tx, x.run.workspaceId);
    if (stepAccess(x.def.access, acc.roleIds, acc.isAdmin, true) !== 'edit') throw new ForbiddenException({ code: 'STEP_ACCESS', message: 'Your role cannot edit this step' });
    return x;
  }

  /** Keeps only the step's own fields, with values of the right type. */
  private cleanData(fields: StepField[], data: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = data[f.key];
      if (v === undefined || v === null || v === '') continue;
      if (f.type === 'number') { const n = Number(v); if (!Number.isFinite(n)) throw new BadRequestException({ code: 'INVALID_VALUE', message: `${f.label} must be a number` }); out[f.key] = n; }
      else if (f.type === 'checkbox') out[f.key] = v === true || v === 'true';
      else if (f.type === 'dropdown') { if (!f.options?.includes(String(v))) throw new BadRequestException({ code: 'INVALID_VALUE', message: `Choose a valid ${f.label}` }); out[f.key] = String(v); }
      else if (f.type === 'date') { const d = new Date(String(v)); if (Number.isNaN(d.getTime())) throw new BadRequestException({ code: 'INVALID_VALUE', message: `${f.label} must be a date` }); out[f.key] = String(v).slice(0, 10); }
      else out[f.key] = String(v).slice(0, 4000);
    }
    return out;
  }

  private async approvers(tx: Tx, workspaceId: string) {
    const now = new Date();
    const users = await tx.user.findMany({
      where: { isActive: true, roles: { some: { OR: [{ workspaceId }, { workspaceId: null }], AND: [{ OR: [{ validTo: null }, { validTo: { gt: now } }] }], role: { permissions: { some: { isDeny: false, permission: { key: 'process.approve' } } } } } } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async describeRuns(tx: Tx, runs: unknown[]) {
    const list = runs as unknown as ({ id: string; templateId: string; leadId: string; customerId: string; workspaceId: string; status: string; dealValuePaise: number; startedAt: Date; completedAt: Date | null; rating: number | null; steps: { id: string; stepId: string; status: string; assigneeId: string | null; dueAt: Date | null; position: number }[] })[];
    const [templates, customers, workspaces, payments] = await Promise.all([
      tx.processTemplate.findMany({ where: { id: { in: [...new Set(list.map((r) => r.templateId))] } }, include: { steps: { select: { id: true, name: true } } } }),
      tx.customer.findMany({ where: { id: { in: [...new Set(list.map((r) => r.customerId))] } }, select: { id: true, name: true, code: true } }),
      tx.workspace.findMany({ select: { id: true, name: true } }),
      tx.payment.groupBy({ by: ['runId'], where: { runId: { in: list.map((r) => r.id) }, isVoided: false }, _sum: { amountPaise: true } }),
    ]);
    const users = new Map((await tx.user.findMany({ where: { id: { in: [...new Set(list.flatMap((r) => r.steps.map((s) => s.assigneeId)).filter(Boolean) as string[])] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return list.map((r) => {
      const t = templates.find((x) => x.id === r.templateId);
      const name = (stepId: string) => t?.steps.find((s) => s.id === stepId)?.name ?? 'Step';
      const cur = r.steps.find((s) => s.status === 'active' || s.status === 'awaiting_approval');
      const received = payments.find((p) => p.runId === r.id)?._sum.amountPaise ?? 0;
      const c = customers.find((x) => x.id === r.customerId);
      return {
        id: r.id, leadId: r.leadId, templateId: r.templateId, templateName: t?.name ?? '', customerName: c?.name ?? '', customerCode: c?.code ?? '',
        workspaceName: workspaces.find((w) => w.id === r.workspaceId)?.name ?? '', status: r.status, dealValuePaise: r.dealValuePaise, receivedPaise: received,
        balancePaise: Math.max(0, r.dealValuePaise - received), startedAt: r.startedAt, completedAt: r.completedAt, rating: r.rating,
        currentStep: cur ? name(cur.stepId) : null, currentStepId: cur?.stepId ?? null, currentStatus: cur?.status ?? null,
        currentAssignee: cur?.assigneeId ? users.get(cur.assigneeId) ?? null : null, currentDueAt: cur?.dueAt ?? null,
        overdue: !!cur?.dueAt && cur.dueAt < new Date(),
        doneSteps: r.steps.filter((s) => s.status === 'done').length, totalSteps: r.steps.length,
        steps: r.steps.map((s) => ({ name: name(s.stepId), status: s.status })),
      };
    });
  }
}
