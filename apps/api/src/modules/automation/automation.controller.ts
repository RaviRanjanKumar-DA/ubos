import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, CONDITION_FIELDS, CONDITION_OPS, type AutomationAction, type AutomationTrigger, type ConditionOp } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { AutomationService } from './automation.service';

export const Condition = z.object({ field: z.string().regex(/^(source|status|stage|owner|score|city|cf:[a-z][a-z0-9_]*)$/), op: z.enum(Object.keys(CONDITION_OPS) as [ConditionOp, ...ConditionOp[]]), value: z.string().max(200).optional() });
export const Action = z.object({
  type: z.enum(Object.keys(AUTOMATION_ACTIONS) as [AutomationAction, ...AutomationAction[]]), userId: z.string().max(40).optional(), stageId: z.string().uuid().optional(), status: z.string().max(60).optional(), labelId: z.string().uuid().optional(),
  title: z.string().trim().max(150).optional(), dueHours: z.number().min(0).max(8760).optional(), text: z.string().trim().max(1000).optional(), templateId: z.string().uuid().optional(), sequenceId: z.string().uuid().optional(),
});
const RuleBody = z.object({
  name: z.string().trim().min(2).max(80), trigger: z.enum(Object.keys(AUTOMATION_TRIGGERS) as [AutomationTrigger, ...AutomationTrigger[]]), idleDays: z.number().int().min(0).max(365).nullable().optional(),
  conditions: z.array(Condition).max(10).default([]), actions: z.array(Action).min(1).max(10), isActive: z.boolean().default(true),
});
const SeqBody = z.object({ name: z.string().trim().min(2).max(80), stopOnReply: z.boolean().default(true), steps: z.array(z.object({ delayHours: z.number().min(0).max(8760), templateId: z.string().uuid() })).min(1).max(20) });
const REQUIRED: Record<string, keyof z.infer<typeof Action>> = { change_stage: 'stageId', set_status: 'status', add_label: 'labelId', create_task: 'title', add_remark: 'text', send_template: 'templateId', notify_owner: 'text', enroll_sequence: 'sequenceId' };

/** Automation rules ("when, if, then") and message sequences of a business line. */
@Controller('api/v1')
@RequireFeature('module.workflows')
export class AutomationController {
  constructor(private db: DbService, private automation: AutomationService) {}

  @Get('automation/options')
  @RequirePermission('crm.lead.view')
  options() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const [pipelines, opts, labels, fields, templates, sequences] = await Promise.all([
        tx.pipeline.findMany({ where: { workspaceId: ws }, include: { stages: { orderBy: { position: 'asc' } } } }),
        tx.workspaceOption.findMany({ where: { workspaceId: ws, isArchived: false } }),
        tx.label.findMany({ where: { isArchived: false, OR: [{ workspaceId: null }, { workspaceId: ws }] } }),
        tx.leadField.findMany({ where: { workspaceId: ws, isArchived: false } }),
        tx.messageTemplate.findMany({ where: { isArchived: false }, orderBy: { name: 'asc' } }),
        tx.sequence.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { name: 'asc' } }),
      ]);
      const users = await tx.user.findMany({ where: { isActive: true, roles: { some: { OR: [{ workspaceId: ws }, { workspaceId: null }] } } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
      return {
        canManage: this.canManage(ws),
        triggers: Object.entries(AUTOMATION_TRIGGERS).map(([value, label]) => ({ value, label })), actions: Object.entries(AUTOMATION_ACTIONS).map(([value, label]) => ({ value, label })),
        ops: Object.entries(CONDITION_OPS).map(([value, label]) => ({ value, label })),
        fields: [...Object.entries(CONDITION_FIELDS).map(([value, label]) => ({ value, label })), ...fields.map((f) => ({ value: `cf:${f.key}`, label: f.label }))],
        stages: pipelines.flatMap((p) => p.stages.map((s) => ({ value: s.id, label: pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name }))),
        statuses: opts.filter((o) => o.kind === 'lead_status').map((o) => ({ value: o.value, label: o.label })), sources: opts.filter((o) => o.kind === 'lead_source').map((o) => ({ value: o.value, label: o.label })),
        labels: labels.map((l) => ({ value: l.id, label: l.name })), users: users.map((u) => ({ value: u.id, label: u.name })),
        templates: templates.map((t) => ({ value: t.id, label: `${t.channel === 'whatsapp' ? 'WhatsApp' : t.channel === 'sms' ? 'SMS' : 'Email'} · ${t.name}` })), sequences: sequences.map((s) => ({ value: s.id, label: s.name })),
      };
    });
  }

  @Get('automation/rules')
  @RequirePermission('crm.lead.view')
  rules() {
    const ws = this.ws();
    return this.db.tenant((tx) => tx.automationRule.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { createdAt: 'desc' } }));
  }

  @Post('automation/rules')
  @RequirePermission('crm.automation.manage')
  create(@Body() body: unknown) {
    const input = parse(RuleBody, body);
    const ws = this.ws();
    this.assertManage(ws);
    this.check(input);
    return this.db.tenant(async (tx) => {
      const r = await tx.automationRule.create({ data: { tenantId: tenantId(), workspaceId: ws, createdById: auth().userId, ...input, idleDays: input.idleDays ?? null } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'automation_rule', entityId: r.id, action: 'automation_rule.created', newValue: input });
      return r;
    });
  }

  @Put('automation/rules/:id')
  @RequirePermission('crm.automation.manage')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(RuleBody, body);
    this.check(input);
    return this.db.tenant(async (tx) => {
      const r = await this.rule(tx, id);
      const u = await tx.automationRule.update({ where: { id }, data: { ...input, idleDays: input.idleDays ?? null } });
      await this.db.audit(tx, { workspaceId: r.workspaceId, entity: 'automation_rule', entityId: id, action: 'automation_rule.updated', oldValue: { name: r.name, trigger: r.trigger, actions: r.actions as object }, newValue: input });
      return u;
    });
  }

  /** Switch a rule on or off, or archive it (its history stays). */
  @Patch('automation/rules/:id')
  @RequirePermission('crm.automation.manage')
  patch(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ isActive: z.boolean().optional(), isArchived: z.boolean().optional() }), body);
    return this.db.tenant(async (tx) => {
      const r = await this.rule(tx, id);
      await tx.automationRule.update({ where: { id }, data: input });
      await this.db.audit(tx, { workspaceId: r.workspaceId, entity: 'automation_rule', entityId: id, action: input.isArchived ? 'automation_rule.archived' : input.isActive === false ? 'automation_rule.paused' : 'automation_rule.resumed' });
      return { ok: true };
    });
  }

  @Get('automation/runs')
  @RequirePermission('crm.lead.view')
  runs(@Query('ruleId') ruleId?: string) {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const ids = (await tx.automationRule.findMany({ where: { workspaceId: ws }, select: { id: true, name: true } }));
      const rows = await tx.automationRun.findMany({ where: { ruleId: ruleId ? ruleId : { in: ids.map((r) => r.id) } }, orderBy: { createdAt: 'desc' }, take: 100 });
      const leads = await tx.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId).filter(Boolean) as string[] } }, select: { id: true, customer: { select: { name: true } } } });
      return rows.map((r) => ({ ...r, ruleName: ids.find((x) => x.id === r.ruleId)?.name ?? '', leadName: leads.find((l) => l.id === r.leadId)?.customer.name ?? null }));
    });
  }

  // ── Sequences ──

  @Get('automation/sequences')
  @RequirePermission('crm.lead.view')
  sequences() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const rows = await tx.sequence.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { createdAt: 'desc' } });
      const counts = await tx.sequenceEnrollment.groupBy({ by: ['sequenceId', 'status'], where: { sequenceId: { in: rows.map((r) => r.id) } }, _count: true });
      return rows.map((s) => ({ ...s, counts: Object.fromEntries(counts.filter((c) => c.sequenceId === s.id).map((c) => [c.status, c._count])) }));
    });
  }

  @Post('automation/sequences')
  @RequirePermission('crm.automation.manage')
  createSeq(@Body() body: unknown) {
    const input = parse(SeqBody, body);
    const ws = this.ws();
    this.assertManage(ws);
    return this.db.tenant(async (tx) => {
      const ids = [...new Set(input.steps.map((s) => s.templateId))];
      if ((await tx.messageTemplate.count({ where: { id: { in: ids }, isArchived: false } })) !== ids.length) throw new BadRequestException({ code: 'TEMPLATE_NOT_FOUND', message: 'Choose active templates' });
      const s = await tx.sequence.create({ data: { tenantId: tenantId(), workspaceId: ws, createdById: auth().userId, ...input } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'sequence', entityId: s.id, action: 'sequence.created', newValue: { name: s.name, steps: input.steps.length } });
      return s;
    });
  }

  /** Archives a sequence; people still on it are stopped. */
  @Post('automation/sequences/:id/archive')
  @RequirePermission('crm.automation.manage')
  archiveSeq(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const s = await tx.sequence.findUnique({ where: { id } });
      if (!s) throw new NotFoundException({ code: 'SEQUENCE_NOT_FOUND', message: 'Sequence not found' });
      this.assertManage(s.workspaceId);
      await tx.sequence.update({ where: { id }, data: { isArchived: true } });
      await tx.sequenceEnrollment.updateMany({ where: { sequenceId: id, status: 'active' }, data: { status: 'stopped', stopReason: 'sequence archived' } });
      await this.db.audit(tx, { workspaceId: s.workspaceId, entity: 'sequence', entityId: id, action: 'sequence.archived' });
      return { ok: true };
    });
  }

  @Get('leads/:id/sequences')
  @RequirePermission('crm.lead.view')
  leadSeqs(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await this.lead(tx, id, 'crm.lead.view');
      const rows = await tx.sequenceEnrollment.findMany({ where: { leadId: id }, include: { sequence: { select: { name: true, steps: true } } }, orderBy: { createdAt: 'desc' }, take: 20 });
      return rows.map((e) => ({ id: e.id, name: e.sequence.name, status: e.status, stopReason: e.stopReason, stepIndex: e.stepIndex, totalSteps: (e.sequence.steps as unknown[]).length, nextAt: e.nextAt }));
    });
  }

  @Post('leads/:id/sequences')
  @RequirePermission('crm.message.send')
  enroll(@Param('id') id: string, @Body() body: unknown) {
    const { sequenceId } = parse(z.object({ sequenceId: z.string().uuid() }), body);
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, id, 'crm.message.send');
      const seq = await tx.sequence.findFirst({ where: { id: sequenceId, workspaceId: lead.workspaceId } });
      if (!seq) throw new BadRequestException({ code: 'SEQUENCE_NOT_FOUND', message: 'Choose a sequence of this business line' });
      try { return { message: await this.automation.enroll(tx, tenantId(), id, sequenceId, auth().userId) }; } catch (e) { throw new BadRequestException({ code: 'CANNOT_ENROLL', message: e instanceof Error ? e.message : 'Failed' }); }
    });
  }

  @Post('leads/:id/sequences/:enrollmentId/stop')
  @RequirePermission('crm.message.send')
  stop(@Param('id') id: string, @Param('enrollmentId') eid: string) {
    return this.db.tenant(async (tx) => {
      await this.lead(tx, id, 'crm.message.send');
      await tx.sequenceEnrollment.updateMany({ where: { id: eid, leadId: id, status: 'active' }, data: { status: 'stopped', stopReason: `stopped by ${auth().name}` } });
      return { ok: true };
    });
  }

  private check(input: z.infer<typeof RuleBody>) {
    if (input.trigger === 'lead.idle' && (input.idleDays === null || input.idleDays === undefined)) throw new BadRequestException({ code: 'IDLE_DAYS_REQUIRED', message: 'Say how many days without activity' });
    for (const a of input.actions) {
      const need = REQUIRED[a.type];
      if (need && (a[need] === undefined || a[need] === '')) throw new BadRequestException({ code: 'ACTION_INCOMPLETE', message: `Complete the “${AUTOMATION_ACTIONS[a.type]}” action` });
    }
    const noValue = ['empty', 'not_empty'];
    if (input.conditions.some((c) => !noValue.includes(c.op) && !c.value)) throw new BadRequestException({ code: 'CONDITION_INCOMPLETE', message: 'Give each condition a value' });
  }

  private ws() {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return ws;
  }
  private canManage(ws: string) {
    const s = auth().permissions['crm.automation.manage'];
    return s === 'ORGANIZATION' || (!!s && auth().workspaceId === ws);
  }
  private assertManage(ws: string) {
    if (!this.canManage(ws)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can change automation' });
  }
  private async rule(tx: Tx, id: string) {
    const r = await tx.automationRule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: 'Rule not found' });
    this.assertManage(r.workspaceId);
    return r;
  }
  private async lead(tx: Tx, id: string, perm: 'crm.lead.view' | 'crm.message.send') {
    const l = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, perm), { id }] } });
    if (!l) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return l;
  }
}
