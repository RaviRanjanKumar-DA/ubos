import { rescoreLead } from '../../common/lead-rules';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { firstStep, locate, matchesConditions, nextStep, type FlowGraph, type RuleCondition, LIVE_TENANT_STATUSES } from '@ubos/shared';
import { DbService } from '../../common/db.service';
import { contextStore } from '../../common/context';
import { activity, applyStageChange, assignmentAvailability, eligibleOwners, makeAssigner } from '../../common/lead-ops';
import { notify } from '../../common/notify';
import { MessagingService } from '../messaging/messaging.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

export interface RuleAction { type: string; userId?: string; stageId?: string; status?: string; labelId?: string; title?: string; dueHours?: number; text?: string; templateId?: string; sequenceId?: string }
interface Rule { id: string; tenantId: string; workspaceId: string; name: string; conditions: unknown; actions: unknown; createdById: string }
interface Step { delayHours: number; templateId: string }
interface Flow { id: string; tenantId: string; workspaceId: string; name: string; trigger: string; graph: unknown; stopWhenClosed: boolean; createdById: string; idleDays?: number | null }
type LogEntry = { nodeId: string; at: string; result: string };
const MAX_STEPS_PER_PASS = 25;
// Length of an hour for flow waits; only tests shorten it (AUTOMATION_HOUR_MS).
const HOUR_MS = Number(process.env.AUTOMATION_HOUR_MS ?? 3_600_000);

/**
 * Runs automation in the background, a moment after the change that caused it, so a broken rule can never block
 * someone's work: queued events → matching rules; sequences that are due; leads that have gone quiet.
 * Rules that trigger rules stop after three links (no endless loops). Set AUTOMATION_DISABLED=true to pause it.
 */
@Injectable()
export class AutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Automation');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastIdle = 0;
  constructor(private db: DbService, private messaging: MessagingService, private wa: WhatsAppService) {}

  onModuleInit() {
    if (process.env.AUTOMATION_DISABLED === 'true') return;
    this.timer = setInterval(() => { this.run().catch((e) => this.log.error(e instanceof Error ? e.message : e)); }, 2_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async asTenant<T>(tenantId: string, depth: number, fn: () => Promise<T>): Promise<T | null> {
    const t = await this.db.platform.tenant.findUnique({ where: { id: tenantId } });
    if (!t || !LIVE_TENANT_STATUSES.includes(t.status)) return null;
    return contextStore.run({ traceId: `automation-${Date.now()}`, ip: null, tenant: { id: t.id, slug: t.slug, name: t.name, status: t.status }, automationDepth: depth }, fn);
  }

  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      const events = await this.db.platform.automationEvent.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 50 });
      for (const ev of events) {
        await this.asTenant(ev.tenantId, ev.depth + 1, () => this.handle(ev)).catch((e) => this.log.error(e instanceof Error ? e.message : e));
        await this.db.platform.automationEvent.update({ where: { id: ev.id }, data: { status: 'done', processedAt: new Date() } });
      }
      const due = await this.db.platform.sequenceEnrollment.findMany({ where: { status: 'active', nextAt: { lte: new Date() } }, orderBy: { nextAt: 'asc' }, take: 50 });
      for (const en of due) await this.asTenant(en.tenantId, 1, () => this.step(en.id)).catch((e) => this.log.error(e instanceof Error ? e.message : e));
      const waking = await this.db.platform.automationFlowRun.findMany({ where: { status: 'waiting', nextAt: { lte: new Date() } }, orderBy: { nextAt: 'asc' }, take: 50 });
      for (const r of waking) await this.asTenant(r.tenantId, 1, () => this.advance(r.id, {})).catch((e) => this.log.error(e instanceof Error ? e.message : e));
      if (Date.now() - this.lastIdle > Number(process.env.AUTOMATION_IDLE_MS ?? 60_000)) { this.lastIdle = Date.now(); await this.idle(); await this.idleFlows(); }
    } finally { this.busy = false; }
  }

  private async handle(ev: { tenantId: string; event: string; workspaceId: string | null; data: unknown }) {
    const data = (ev.data ?? {}) as Record<string, unknown>;
    if (typeof data.leadId !== 'string' || !ev.workspaceId) return;
    const leadId = data.leadId;
    await this.db.tenant((tx) => rescoreLead(tx, leadId)); // first, so rules can test the new score
    const rules = await this.db.tenant((tx) => tx.automationRule.findMany({ where: { trigger: ev.event, isActive: true, isArchived: false, workspaceId: ev.workspaceId! }, orderBy: { createdAt: 'asc' } }));
    for (const r of rules) await this.apply(r, data.leadId, ev.event, data);
    const flows = await this.db.tenant((tx) => tx.automationFlow.findMany({ where: { trigger: ev.event, isActive: true, isArchived: false, workspaceId: ev.workspaceId! }, orderBy: { createdAt: 'asc' } }));
    for (const f of flows) await this.startFlow(f, leadId, ev.event, data);
  }

  /** Leads that have gone quiet: each rule fires once per quiet spell. */
  private async idle() {
    const rules = await this.db.platform.automationRule.findMany({ where: { trigger: 'lead.idle', isActive: true, isArchived: false } });
    for (const r of rules) {
      await this.asTenant(r.tenantId, 1, async () => {
        const open = (await this.db.tenant((tx) => tx.leadStage.findMany({ where: { isWon: false, isLost: false }, select: { id: true } }))).map((s) => s.id);
        const cutoff = new Date(Date.now() - (r.idleDays ?? 7) * 86_400_000);
        const leads = await this.db.tenant((tx) => tx.lead.findMany({ where: { workspaceId: r.workspaceId, stageId: { in: open }, OR: [{ lastActivityAt: { lte: cutoff } }, { lastActivityAt: null, createdAt: { lte: cutoff } }] }, take: 200, orderBy: { updatedAt: 'asc' } }));
        for (const l of leads) {
          const fired = await this.db.tenant((tx) => tx.automationRun.findFirst({ where: { ruleId: r.id, leadId: l.id, createdAt: { gte: l.lastActivityAt ?? l.createdAt } } }));
          if (!fired) await this.apply(r, l.id, 'lead.idle', {});
        }
      }).catch((e) => this.log.error(e instanceof Error ? e.message : e));
    }
  }

  /** Quiet leads enter idle flows once per quiet spell. */
  private async idleFlows() {
    const flows = await this.db.platform.automationFlow.findMany({ where: { trigger: 'lead.idle', isActive: true, isArchived: false } });
    for (const f of flows) {
      await this.asTenant(f.tenantId, 1, async () => {
        const open = (await this.db.tenant((tx) => tx.leadStage.findMany({ where: { isWon: false, isLost: false }, select: { id: true } }))).map((x) => x.id);
        const cutoff = new Date(Date.now() - (f.idleDays ?? 7) * 86_400_000);
        const leads = await this.db.tenant((tx) => tx.lead.findMany({ where: { workspaceId: f.workspaceId, stageId: { in: open }, OR: [{ lastActivityAt: { lte: cutoff } }, { lastActivityAt: null, createdAt: { lte: cutoff } }] }, take: 200, orderBy: { updatedAt: 'asc' } }));
        for (const l of leads) {
          const since = await this.db.tenant((tx) => tx.automationFlowRun.findFirst({ where: { flowId: f.id, leadId: l.id, createdAt: { gte: l.lastActivityAt ?? l.createdAt } } }));
          if (!since) await this.startFlow(f, l.id, 'lead.idle', {});
        }
      }).catch((e) => this.log.error(e instanceof Error ? e.message : e));
    }
  }

  /** The values conditions are tested against. */
  async leadValues(leadId: string, data: Record<string, unknown> = {}) {
    const lead = await this.db.tenant((tx) => tx.lead.findUnique({ where: { id: leadId }, include: { customer: true } }));
    if (!lead) return null;
    const cf = Object.fromEntries(Object.entries((lead.customFields ?? {}) as Record<string, unknown>).map(([k, v]) => [`cf:${k}`, v]));
    return { lead, values: { ...cf, source: lead.source, status: lead.status, stage: data.to ?? lead.stageId, owner: lead.ownerId, score: lead.score, city: lead.customer.city } as Record<string, unknown> };
  }

  /** Puts a lead into a flow, unless it is already in it. */
  async startFlow(f: Flow, leadId: string, event: string, data: Record<string, unknown>) {
    const lead = await this.db.tenant((tx) => tx.lead.findUnique({ where: { id: leadId }, select: { workspaceId: true } }));
    if (!lead || lead.workspaceId !== f.workspaceId) return null;
    const first = firstStep(f.graph as FlowGraph);
    if (!first) return null;
    const run = await this.db.tenant(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`flow-run:${f.id}:${leadId}`}))`;
      if (await tx.automationFlowRun.findFirst({ where: { flowId: f.id, leadId, status: { in: ['running', 'waiting'] } }, select: { id: true } })) return null;
      const r = await tx.automationFlowRun.create({ data: { tenantId: f.tenantId, flowId: f.id, leadId, event, nodeId: first, status: 'running' } });
      await tx.automationFlow.update({ where: { id: f.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } });
      return r;
    });
    if (run) await this.advance(run.id, data);
    return run?.id ?? null;
  }

  /**
   * Moves a lead through its flow until a wait, the end, or a failure. A step removed while a lead waited ends the run;
   * a lead that is won or lost leaves the flow (unless the flow says otherwise).
   */
  async advance(runId: string, data: Record<string, unknown>) {
    const run = await this.db.tenant((tx) => tx.automationFlowRun.findUnique({ where: { id: runId }, include: { flow: true } }));
    if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
    const f = run.flow;
    const g = f.graph as unknown as FlowGraph;
    const log = [...((run.log as unknown as LogEntry[]) ?? [])];
    const save = (patch: { nodeId?: string | null; status: string; nextAt?: Date | null; error?: string | null }) => this.db.tenant((tx) => tx.automationFlowRun.update({ where: { id: runId }, data: { ...patch, log: log as never } }));
    const note = (nodeId: string, result: string) => log.push({ nodeId, at: new Date().toISOString(), result });
    let nodeId: string | null = run.nodeId === '__end__' ? null : run.nodeId;
    if (f.isArchived) return void (await save({ status: 'stopped', error: 'flow archived', nodeId }));
    for (let i = 0; i < MAX_STEPS_PER_PASS && nodeId; i++) {
      const place = locate(g).get(nodeId);
      if (!place) return void (await save({ status: 'stopped', error: 'the flow was changed and this step is gone', nodeId: null }));
      const lv = await this.leadValues(run.leadId, i === 0 ? data : {});
      if (!lv) return void (await save({ status: 'stopped', error: 'lead not found', nodeId }));
      if (f.stopWhenClosed && f.trigger !== 'lead.won' && f.trigger !== 'lead.lost') {
        const st = await this.db.tenant((tx) => tx.leadStage.findUnique({ where: { id: lv.lead.stageId }, select: { isWon: true, isLost: true } }));
        if (st?.isWon || st?.isLost) return void (await save({ status: 'stopped', error: 'lead closed', nodeId }));
      }
      const node = place.node;
      if (node.type === 'wait') {
        note(node.id, `waiting ${node.hours} h`);
        return void (await save({ status: 'waiting', nextAt: new Date(Date.now() + node.hours * HOUR_MS), nodeId: nextStep(g, node.id) ?? '__end__' }));
      }
      if (node.type === 'condition') {
        const yes = matchesConditions(node.conditions, lv.values);
        note(node.id, yes ? 'yes' : 'no');
        nodeId = nextStep(g, node.id, yes);
        continue;
      }
      const rule = { id: f.id, tenantId: f.tenantId, workspaceId: f.workspaceId, name: f.name, conditions: [], actions: [], createdById: f.createdById };
      try {
        const done = await this.act(rule, run.leadId, node.action as RuleAction);
        note(node.id, done);
        await this.db.tenant(async (tx) => {
          const l = await tx.lead.findUniqueOrThrow({ where: { id: run.leadId } });
          await tx.leadActivity.create({ data: activity(l, null, { type: 'automation', remark: `Flow “${f.name}”: ${done}`, data: { flowId: f.id } }) });
        });
      } catch (e) {
        const why = `${node.action.type}: ${e instanceof Error ? e.message : e}`.slice(0, 300);
        note(node.id, `failed: ${why}`);
        return void (await save({ status: 'failed', error: why, nodeId }));
      }
      nodeId = nextStep(g, node.id);
    }
    if (nodeId === '__end__') nodeId = null;
    await save(nodeId ? { status: 'running', nodeId } : { status: 'done', nodeId: null, nextAt: null });
    // Very long flows continue on the next pass rather than holding the loop.
    if (nodeId) await this.db.tenant((tx) => tx.automationFlowRun.update({ where: { id: runId }, data: { status: 'waiting', nextAt: new Date() } }));
  }

  private async apply(rule: Rule, leadId: string, event: string, data: Record<string, unknown>) {
    const lead = await this.db.tenant((tx) => tx.lead.findUnique({ where: { id: leadId }, include: { customer: true } }));
    if (!lead || lead.workspaceId !== rule.workspaceId) return;
    const cf = Object.fromEntries(Object.entries((lead.customFields ?? {}) as Record<string, unknown>).map(([k, v]) => [`cf:${k}`, v]));
    const values = { ...cf, source: lead.source, status: lead.status, stage: data.to ?? lead.stageId, owner: lead.ownerId, score: lead.score, city: lead.customer.city };
    if (!matchesConditions(rule.conditions as RuleCondition[], values)) return;
    const done: string[] = [];
    let error: string | null = null;
    for (const a of rule.actions as RuleAction[]) {
      try { done.push(await this.act(rule, leadId, a)); } catch (e) { error = `${a.type}: ${e instanceof Error ? e.message : e}`.slice(0, 300); break; }
    }
    await this.db.tenant(async (tx) => {
      await tx.automationRun.create({ data: { tenantId: rule.tenantId, ruleId: rule.id, event, leadId, status: error ? 'failed' : 'done', detail: error ?? done.join('; ') } });
      await tx.automationRule.update({ where: { id: rule.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } });
      const l = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
      await tx.leadActivity.create({ data: activity(l, null, { type: 'automation', remark: `Rule “${rule.name}”: ${error ?? done.join('; ')}`, data: { ruleId: rule.id } }) });
    });
  }

  /** Runs one action; returns a short description, throws with the reason if it cannot be done. */
  private async act(rule: Rule, leadId: string, a: RuleAction): Promise<string> {
    const actor = rule.createdById;
    if (a.type === 'send_template') {
      const t = await this.db.tenant((tx) => tx.messageTemplate.findUnique({ where: { id: a.templateId ?? '' } }));
      if (!t) throw new Error('Template not found');
      await this.sendTemplate(rule.tenantId, leadId, t, actor);
      return `sent ${t.channel} template ${t.name}`;
    }
    return this.db.tenant(async (tx) => {
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, include: { customer: true } });
      const say = (s: string) => s.replace(/\{name\}/g, lead.customer.name);
      switch (a.type) {
        case 'assign': {
          const eligible = (await eligibleOwners(tx, lead.workspaceId)).map((u) => u.id);
          let owner = a.userId && a.userId !== 'rules' ? a.userId : null;
          if (owner && !eligible.includes(owner)) throw new Error('That person cannot own leads in this business line');
          if (!owner) {
            const ws = await tx.workspace.findUniqueOrThrow({ where: { id: lead.workspaceId } });
            const assigner = makeAssigner({ ...ws, assignmentMode: 'round_robin', stickyOwner: false }, eligible, lead.ownerId ?? actor, await assignmentAvailability(tx));
            owner = assigner.pick(null);
            await tx.workspace.update({ where: { id: ws.id }, data: { assignmentCursor: assigner.state.cursor } });
          }
          if (owner === lead.ownerId) return 'already with that owner';
          await tx.lead.update({ where: { id: leadId }, data: { ownerId: owner, assignedAt: new Date() } });
          await tx.leadActivity.create({ data: activity(lead, null, { type: 'assignment', data: { from: lead.ownerId, to: owner, auto: true } }) });
          await notify(tx, [owner], { type: 'lead', title: `Lead assigned to you: ${lead.customer.name}`, link: `/app/leads/${leadId}` });
          return 'assigned';
        }
        case 'change_stage': {
          const stage = await tx.leadStage.findFirst({ where: { id: a.stageId ?? '', pipelineId: lead.pipelineId } });
          if (!stage) throw new Error('That stage is not in this lead’s pipeline');
          const refused = await applyStageChange(tx, lead, stage, actor);
          if (refused) throw new Error(refused);
          return `moved to ${stage.name}`;
        }
        case 'set_status': {
          if (!(await tx.workspaceOption.findFirst({ where: { workspaceId: lead.workspaceId, kind: 'lead_status', value: a.status ?? '', isArchived: false } }))) throw new Error('Unknown status');
          await tx.lead.update({ where: { id: leadId }, data: { status: a.status } });
          await tx.leadActivity.create({ data: activity(lead, null, { type: 'status', data: { from: lead.status, to: a.status, auto: true } }) });
          return `status ${a.status}`;
        }
        case 'add_label': {
          if (!(await tx.label.findFirst({ where: { id: a.labelId ?? '', isArchived: false } }))) throw new Error('Label not found');
          if (!lead.labelIds.includes(a.labelId!)) await tx.lead.update({ where: { id: leadId }, data: { labelIds: { push: a.labelId! } } });
          return 'label added';
        }
        case 'create_task': {
          await tx.task.create({ data: { tenantId: rule.tenantId, workspaceId: lead.workspaceId, leadId, type: 'task', title: say(a.title ?? 'Follow up'), dueAt: new Date(Date.now() + (a.dueHours ?? 24) * 3_600_000), assigneeId: lead.ownerId ?? actor, createdById: actor } });
          return 'task created';
        }
        case 'add_remark': {
          await tx.leadActivity.create({ data: activity(lead, null, { type: 'remark', remark: say(a.text ?? ''), data: { ruleId: rule.id } }) });
          return 'remark added';
        }
        case 'notify_owner': {
          if (lead.ownerId) await notify(tx, [lead.ownerId], { type: 'automation', title: say(a.text ?? rule.name), link: `/app/leads/${leadId}` });
          return 'owner notified';
        }
        case 'enroll_sequence': return this.enroll(tx, rule.tenantId, leadId, a.sequenceId ?? '', actor);
        default: throw new Error('Unknown action');
      }
    });
  }

  private sendTemplate(tenantId: string, leadId: string, t: { id: string; channel: string }, actor: string) {
    return t.channel === 'whatsapp' ? this.wa.sendTemplate(tenantId, leadId, t.id, actor) : this.messaging.send(tenantId, leadId, t.id, actor);
  }

  /** Puts a lead on a sequence (once at a time). */
  async enroll(tx: Parameters<Parameters<DbService['tenant']>[0]>[0], tenantId: string, leadId: string, sequenceId: string, actor: string) {
    const s = await tx.sequence.findFirst({ where: { id: sequenceId, isArchived: false } });
    if (!s) throw new Error('Sequence not found');
    if (await tx.sequenceEnrollment.findFirst({ where: { sequenceId, leadId, status: 'active' } })) throw new Error('Already on this sequence');
    const steps = s.steps as unknown as Step[];
    await tx.sequenceEnrollment.create({ data: { tenantId, sequenceId, leadId, nextAt: new Date(Date.now() + steps[0].delayHours * 3_600_000), createdById: actor } });
    return `started sequence ${s.name}`;
  }

  /** Sends the due step of a sequence, or ends it if the lead was won or lost, opted out, or the send failed. */
  private async step(id: string) {
    const en = await this.db.tenant((tx) => tx.sequenceEnrollment.findUnique({ where: { id }, include: { sequence: true } }));
    if (!en || en.status !== 'active') return;
    const stop = (reason: string, status = 'stopped') => this.db.tenant((tx) => tx.sequenceEnrollment.update({ where: { id }, data: { status, stopReason: reason } }));
    const lead = await this.db.tenant((tx) => tx.lead.findUnique({ where: { id: en.leadId } }));
    const stage = lead ? await this.db.tenant((tx) => tx.leadStage.findUnique({ where: { id: lead.stageId } })) : null;
    if (!lead || stage?.isWon || stage?.isLost) return void (await stop('lead closed'));
    const steps = en.sequence.steps as unknown as Step[];
    const t = await this.db.tenant((tx) => tx.messageTemplate.findUnique({ where: { id: steps[en.stepIndex]?.templateId ?? '' } }));
    if (!t || t.isArchived) return void (await stop('template not available'));
    try { await this.sendTemplate(en.tenantId, en.leadId, t, en.createdById); } catch (e) { return void (await stop((e instanceof Error ? e.message : 'send failed').slice(0, 200))); }
    const next = en.stepIndex + 1;
    if (next >= steps.length) return void (await stop('all steps sent', 'completed'));
    await this.db.tenant((tx) => tx.sequenceEnrollment.update({ where: { id }, data: { stepIndex: next, nextAt: new Date(Date.now() + steps[next].delayHours * 3_600_000) } }));
  }
}
