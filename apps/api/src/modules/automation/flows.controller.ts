import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, flowFromRule, locate, matchesConditions, nextStep, firstStep, validateFlow, type AutomationTrigger, type FlowGraph, type FlowNode, type RuleCondition } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { AutomationService } from './automation.service';
import { Action, Condition } from './automation.controller';

const FlowBody = z.object({
  name: z.string().trim().min(2).max(80), trigger: z.enum(Object.keys(AUTOMATION_TRIGGERS) as [AutomationTrigger, ...AutomationTrigger[]]), idleDays: z.number().int().min(1).max(365).nullable().optional(),
  stopWhenClosed: z.boolean().default(true), graph: z.object({ steps: z.array(z.any()) }),
});
const NO_VALUE = ['empty', 'not_empty'];
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12);

/** Visual automation flows of a business line: draw, test on a lead, switch on, watch each lead's way through. */
@Controller('api/v1')
@RequireFeature('module.workflows')
export class FlowsController {
  constructor(private db: DbService, private automation: AutomationService) {}

  private ws() {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return ws;
  }
  private assertManage(ws: string) {
    const s = auth().permissions['crm.automation.manage' as never] as string | undefined;
    if (!(s === 'ORGANIZATION' || (!!s && auth().workspaceId === ws))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can change automation' });
  }
  private async flow(tx: Tx, id: string, manage = false) {
    const f = await tx.automationFlow.findFirst({ where: { id, isArchived: false } });
    if (!f || (!manage && f.workspaceId !== auth().workspaceId && auth().permissions['crm.lead.view' as never] !== 'ORGANIZATION')) throw new NotFoundException({ code: 'FLOW_NOT_FOUND', message: 'Flow not found' });
    if (manage) this.assertManage(f.workspaceId);
    return f;
  }
  private async lead(tx: Tx, id: string) {
    const l = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.lead.view'), { id }] } });
    if (!l) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return l;
  }

  /** Every step's shape and values are checked, not just the drawing. */
  private check(input: z.infer<typeof FlowBody>) {
    if (input.trigger === 'lead.idle' && !input.idleDays) throw new BadRequestException({ code: 'IDLE_DAYS_REQUIRED', message: 'Say how many days without activity' });
    const g = input.graph as FlowGraph;
    const problems = validateFlow(g);
    if (problems.length) throw new BadRequestException({ code: 'FLOW_INVALID', message: problems[0], problems });
    const walk = (list: FlowNode[]): FlowNode[] => list.map((n) => {
      if (n.type === 'action') return { id: n.id, type: 'action', action: parse(Action, n.action) };
      if (n.type === 'wait') return { id: n.id, type: 'wait', hours: n.hours };
      const conditions = n.conditions.map((c) => parse(Condition, c)) as RuleCondition[];
      if (conditions.some((c) => !NO_VALUE.includes(c.op) && !c.value)) throw new BadRequestException({ code: 'CONDITION_INCOMPLETE', message: 'Give each condition a value' });
      return { id: n.id, type: 'condition', conditions, yes: walk(n.yes), no: walk(n.no) };
    });
    return { steps: walk(g.steps) } as FlowGraph;
  }

  @Get('automation/flows')
  @RequirePermission('crm.lead.view')
  async list() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const flows = await tx.automationFlow.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, trigger: true, idleDays: true, isActive: true, runCount: true, lastRunAt: true, graph: true, updatedAt: true } });
      const counts = await tx.automationFlowRun.groupBy({ by: ['flowId', 'status'], where: { flowId: { in: flows.map((f) => f.id) } }, _count: true });
      return flows.map(({ graph, ...f }) => ({ ...f, steps: locate(graph as unknown as FlowGraph).size, runs: Object.fromEntries(counts.filter((c) => c.flowId === f.id).map((c) => [c.status, c._count])) }));
    });
  }

  @Get('automation/flows/:id')
  @RequirePermission('crm.lead.view')
  get(@Param('id') id: string) {
    return this.db.tenant((tx) => this.flow(tx, id));
  }

  @Post('automation/flows')
  @RequirePermission('crm.automation.manage')
  create(@Body() body: unknown) {
    const input = parse(FlowBody, body);
    const ws = this.ws();
    this.assertManage(ws);
    const graph = this.check(input);
    return this.db.tenant(async (tx) => {
      const f = await tx.automationFlow.create({ data: { tenantId: tenantId(), workspaceId: ws, createdById: auth().userId, name: input.name, trigger: input.trigger, idleDays: input.idleDays ?? null, stopWhenClosed: input.stopWhenClosed, graph: graph as never } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'automation_flow', entityId: f.id, action: 'automation_flow.created', newValue: { name: f.name, trigger: f.trigger, steps: locate(graph).size } });
      return f;
    });
  }

  /** Leads already waiting carry on from the same step if it is still there; a removed step ends their run. */
  @Put('automation/flows/:id')
  @RequirePermission('crm.automation.manage')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(FlowBody, body);
    const graph = this.check(input);
    return this.db.tenant(async (tx) => {
      const old = await this.flow(tx, id, true);
      const f = await tx.automationFlow.update({ where: { id }, data: { name: input.name, trigger: input.trigger, idleDays: input.idleDays ?? null, stopWhenClosed: input.stopWhenClosed, graph: graph as never } });
      await this.db.audit(tx, { workspaceId: f.workspaceId, entity: 'automation_flow', entityId: id, action: 'automation_flow.updated', oldValue: { name: old.name, trigger: old.trigger, steps: locate(old.graph as unknown as FlowGraph).size }, newValue: { name: f.name, trigger: f.trigger, steps: locate(graph).size } });
      return f;
    });
  }

  /** Switch on or off, or archive (leads still in it stop; history stays). */
  @Patch('automation/flows/:id')
  @RequirePermission('crm.automation.manage')
  patch(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ isActive: z.boolean().optional(), isArchived: z.boolean().optional() }), body);
    return this.db.tenant(async (tx) => {
      const f = await this.flow(tx, id, true);
      await tx.automationFlow.update({ where: { id }, data: input });
      if (input.isArchived) await tx.automationFlowRun.updateMany({ where: { flowId: id, status: { in: ['running', 'waiting'] } }, data: { status: 'stopped', error: 'flow archived' } });
      await this.db.audit(tx, { workspaceId: f.workspaceId, entity: 'automation_flow', entityId: id, action: input.isArchived ? 'automation_flow.archived' : input.isActive ? 'automation_flow.switched_on' : 'automation_flow.switched_off' });
      return { ok: true };
    });
  }

  /** What would happen to this lead, step by step, without doing anything. Waits are passed over and listed. */
  @Post('automation/flows/:id/preview')
  @HttpCode(200)
  @RequirePermission('crm.lead.view')
  async preview(@Param('id') id: string, @Body() body: unknown) {
    const { leadId } = parse(z.object({ leadId: z.string().uuid() }), body);
    const f = await this.db.tenant(async (tx) => { await this.lead(tx, leadId); return this.flow(tx, id); });
    const lv = await this.automation.leadValues(leadId);
    if (!lv || lv.lead.workspaceId !== f.workspaceId) throw new BadRequestException({ code: 'OTHER_WORKSPACE', message: 'This lead is in another business line' });
    const g = f.graph as unknown as FlowGraph;
    const path: { nodeId: string; result: string }[] = [];
    let node: string | null = firstStep(g);
    for (let i = 0; node && i < 100; i++) {
      const n = locate(g).get(node)!.node;
      if (n.type === 'condition') { const yes = matchesConditions(n.conditions, lv.values); path.push({ nodeId: n.id, result: yes ? 'yes' : 'no' }); node = nextStep(g, n.id, yes); continue; }
      path.push({ nodeId: n.id, result: n.type === 'wait' ? `waits ${n.hours} h` : `would ${AUTOMATION_ACTIONS[n.action.type as keyof typeof AUTOMATION_ACTIONS]?.toLowerCase() ?? n.action.type}` });
      node = nextStep(g, n.id);
    }
    return { leadName: lv.lead.customer.name, path };
  }

  /** Runs the flow for one lead now (to try it out), even before it is switched on. */
  @Post('automation/flows/:id/start')
  @HttpCode(200)
  @RequirePermission('crm.automation.manage')
  async start(@Param('id') id: string, @Body() body: unknown) {
    const { leadId } = parse(z.object({ leadId: z.string().uuid() }), body);
    const f = await this.db.tenant(async (tx) => { await this.lead(tx, leadId); return this.flow(tx, id, true); });
    const runId = await this.automation.startFlow(f, leadId, 'manual', {});
    if (!runId) throw new BadRequestException({ code: 'ALREADY_RUNNING', message: 'This lead is already in the flow, or is in another business line' });
    await this.db.tenant((tx) => this.db.audit(tx, { workspaceId: f.workspaceId, entity: 'automation_flow', entityId: id, action: 'automation_flow.started_by_hand', newValue: { leadId } }));
    return this.db.tenant((tx) => tx.automationFlowRun.findUniqueOrThrow({ where: { id: runId } }));
  }

  @Get('automation/flows/:id/runs')
  @RequirePermission('crm.lead.view')
  runs(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await this.flow(tx, id);
      const runs = await tx.automationFlowRun.findMany({ where: { flowId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
      const scope = await scopeFilter(tx, 'crm.lead.view');
      const leads = new Map((await tx.lead.findMany({ where: { AND: [scope, { id: { in: [...new Set(runs.map((r) => r.leadId))] } }] }, select: { id: true, customer: { select: { name: true } } } })).map((l) => [l.id, l.customer.name]));
      return runs.filter((r) => leads.has(r.leadId)).map((r) => ({ ...r, leadName: leads.get(r.leadId) }));
    });
  }

  @Post('automation/flow-runs/:id/stop')
  @HttpCode(200)
  @RequirePermission('crm.automation.manage')
  stop(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.automationFlowRun.findUnique({ where: { id }, include: { flow: true } });
      if (!r) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Not found' });
      this.assertManage(r.flow.workspaceId);
      const done = await tx.automationFlowRun.updateMany({ where: { id, status: { in: ['running', 'waiting'] } }, data: { status: 'stopped', error: `stopped by ${auth().name}` } });
      if (!done.count) throw new BadRequestException({ code: 'NOT_RUNNING', message: 'This lead is no longer in the flow' });
      return { ok: true };
    });
  }

  /** Draws an existing rule as a new flow (switched off), so it can grow waits and paths. The rule stays as it is. */
  @Post('automation/rules/:id/to-flow')
  @RequirePermission('crm.automation.manage')
  fromRule(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.automationRule.findFirst({ where: { id, isArchived: false } });
      if (!r) throw new NotFoundException({ code: 'RULE_NOT_FOUND', message: 'Rule not found' });
      this.assertManage(r.workspaceId);
      const graph = flowFromRule({ conditions: r.conditions as unknown as RuleCondition[], actions: r.actions as never }, shortId);
      const f = await tx.automationFlow.create({ data: { tenantId: tenantId(), workspaceId: r.workspaceId, createdById: auth().userId, name: `${r.name} (flow)`.slice(0, 80), trigger: r.trigger, idleDays: r.idleDays, graph: graph as never } });
      await this.db.audit(tx, { workspaceId: r.workspaceId, entity: 'automation_flow', entityId: f.id, action: 'automation_flow.created_from_rule', newValue: { rule: r.name } });
      return f;
    });
  }
}
