import type { Tx } from '@ubos/database';
import { activity } from './lead-ops';
import { notify } from './notify';

/** A form field of a process step; values live in StepRun.data under `key`. */
export interface StepField { key: string; label: string; type: string; options?: string[]; required?: boolean }
export type StepAccess = 'edit' | 'view' | 'none';

type LeadRow = { id: string; tenantId: string; workspaceId: string; customerId: string; ownerId: string | null; customFields: unknown };
type StepDef = { id: string; name: string; position: number; assignTo: string; assigneeUserId: string | null; ownerRoleId: string | null; dueDays: number | null };

/** Deal value in paise: the accepted quote total, else the business line's value field on the lead. */
export async function dealValueOf(tx: Tx, lead: LeadRow, quoteId?: string | null) {
  if (quoteId) {
    const q = await tx.quote.findUnique({ where: { id: quoteId }, select: { totalPaise: true } });
    if (q) return q.totalPaise;
  }
  const ws = await tx.workspace.findUnique({ where: { id: lead.workspaceId }, select: { valueFieldKey: true } });
  const v = ws?.valueFieldKey && lead.customFields && typeof lead.customFields === 'object' ? Number((lead.customFields as Record<string, unknown>)[ws.valueFieldKey]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0;
}

/** Someone covering for an away colleague takes their new steps. */
async function withCover(tx: Tx, userId: string | null) {
  if (!userId) return null;
  const now = new Date();
  const c = await tx.userCover.findFirst({ where: { userId, cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { createdAt: 'asc' } });
  return c?.coverUserId ?? userId;
}

/** Who does a step: the lead owner, a fixed person, or the first active person with the responsible role here. */
export async function pickAssignee(tx: Tx, step: StepDef, lead: LeadRow) {
  if (step.assignTo === 'user' && step.assigneeUserId) return withCover(tx, step.assigneeUserId);
  if (step.assignTo === 'role' && step.ownerRoleId) {
    const now = new Date();
    const people = await tx.user.findMany({
      where: {
        isActive: true,
        roles: { some: { roleId: step.ownerRoleId, OR: [{ workspaceId: lead.workspaceId }, { workspaceId: null }], AND: [{ OR: [{ validTo: null }, { validTo: { gt: now } }] }] } },
      },
      select: { id: true, acceptingLeads: true }, orderBy: { name: 'asc' },
    });
    const pick = people.find((p) => p.acceptingLeads) ?? people[0];
    if (pick) return withCover(tx, pick.id);
  }
  return withCover(tx, lead.ownerId);
}

/** Makes a step the current one: assignee, due date, notification. */
export async function activateStep(tx: Tx, stepRunId: string, def: StepDef, lead: LeadRow, keepAssignee = false) {
  const sr = await tx.stepRun.findUniqueOrThrow({ where: { id: stepRunId } });
  const assigneeId = keepAssignee && sr.assigneeId ? sr.assigneeId : await pickAssignee(tx, def, lead);
  const dueAt = def.dueDays ? new Date(Date.now() + def.dueDays * 86_400_000) : null;
  await tx.stepRun.update({ where: { id: stepRunId }, data: { status: 'active', assigneeId, dueAt, startedAt: new Date(), locked: false } });
  // The person doing a step joins the lead team, so they can open the lead even if it is not theirs.
  if (assigneeId && assigneeId !== lead.ownerId && !(await tx.leadTeamMember.findFirst({ where: { leadId: lead.id, userId: assigneeId, removedAt: null } }))) {
    await tx.leadTeamMember.create({ data: { tenantId: lead.tenantId, leadId: lead.id, userId: assigneeId, roleLabel: def.name.slice(0, 40), addedById: sr.assigneeId ?? assigneeId } });
  }
  if (assigneeId) await notify(tx, [assigneeId], { type: 'process', title: `Process step for you: ${def.name}`, link: `/app/leads/${lead.id}?tab=process` });
  return assigneeId;
}

/** Starts a process template for a lead (creates every step; the first one becomes active). */
export async function startRun(tx: Tx, templateId: string, lead: LeadRow, userId: string, quoteId?: string | null) {
  const steps = await tx.processStep.findMany({ where: { templateId, isArchived: false }, orderBy: { position: 'asc' } });
  const dealValuePaise = await dealValueOf(tx, lead, quoteId);
  const run = await tx.processRun.create({
    data: { tenantId: lead.tenantId, workspaceId: lead.workspaceId, templateId, leadId: lead.id, customerId: lead.customerId, quoteId: quoteId ?? null, dealValuePaise, createdById: userId },
  });
  await tx.stepRun.createMany({ data: steps.map((s, i) => ({ tenantId: lead.tenantId, runId: run.id, stepId: s.id, position: i, status: 'pending' })) });
  const first = await tx.stepRun.findFirst({ where: { runId: run.id }, orderBy: { position: 'asc' } });
  if (first) await activateStep(tx, first.id, steps[0], lead);
  else await tx.processRun.update({ where: { id: run.id }, data: { status: 'completed', completedAt: new Date() } });
  // Payments already received for this sale (e.g. a token before the lead was won) count towards it.
  await tx.payment.updateMany({ where: { leadId: lead.id, runId: null, isVoided: false }, data: { runId: run.id } });
  const t = await tx.processTemplate.findUnique({ where: { id: templateId }, select: { name: true } });
  await tx.leadActivity.create({ data: activity(lead, userId, { type: 'process', remark: `Process started: ${t?.name ?? ''}`, data: { runId: run.id, templateId } }) });
  return run;
}

/**
 * When a lead is won, start every active "on win" template of its business line that fits the sale: templates
 * limited to some products start only when the lead's accepted quote has one of them. Never starts the same
 * template twice for one lead while a run is still active.
 */
export async function startProcessesOnWin(tx: Tx, leadId: string, userId: string) {
  const lead = await tx.lead.findUnique({ where: { id: leadId } });
  if (!lead) return [];
  const templates = await tx.processTemplate.findMany({ where: { workspaceId: lead.workspaceId, trigger: 'won', isArchived: false }, orderBy: { createdAt: 'asc' } });
  if (!templates.length) return [];
  const quote = await tx.quote.findFirst({ where: { leadId, status: 'accepted' }, orderBy: { decidedAt: 'desc' }, include: { items: { select: { packageId: true } } } });
  const sold = new Set((quote?.items ?? []).map((i) => i.packageId).filter(Boolean) as string[]);
  const runs = [];
  for (const t of templates) {
    if (t.packageIds.length && !t.packageIds.some((p) => sold.has(p))) continue;
    const open = await tx.processRun.findFirst({ where: { leadId, templateId: t.id, status: 'active' } });
    if (open) continue;
    runs.push(await startRun(tx, t.id, lead, userId, quote?.id));
  }
  return runs;
}

/** Money received for a run (voided entries excluded). */
export async function receivedPaise(tx: Tx, runId: string) {
  const r = await tx.payment.aggregate({ where: { runId, isVoided: false }, _sum: { amountPaise: true } });
  return r._sum.amountPaise ?? 0;
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && v !== false;

/** Why a step cannot be completed yet (null = it can): earlier steps, required fields, payment received. */
export async function gateProblem(tx: Tx, stepRun: { id: string; runId: string; position: number; data: unknown }, def: { fields: unknown; minPaymentPct: number | null }) {
  const earlier = await tx.stepRun.count({ where: { runId: stepRun.runId, position: { lt: stepRun.position }, status: { not: 'done' } } });
  if (earlier) return 'Finish the earlier steps first';
  const data = (stepRun.data ?? {}) as Record<string, unknown>;
  const missing = ((def.fields ?? []) as StepField[]).filter((f) => f.required && !filled(data[f.key])).map((f) => f.label);
  if (missing.length) return `Fill ${missing.join(', ')} first`;
  if (def.minPaymentPct) {
    const run = await tx.processRun.findUniqueOrThrow({ where: { id: stepRun.runId } });
    const got = await receivedPaise(tx, run.id);
    const pct = run.dealValuePaise ? Math.floor((got * 100) / run.dealValuePaise) : 0;
    if (pct < def.minPaymentPct) return `${def.minPaymentPct}% of the deal value must be received first (received ${pct}%)`;
  }
  return null;
}

/** Marks a step done and locked, then moves on: the next pending step becomes active, or the run completes. */
export async function finishStep(tx: Tx, stepRunId: string, userId: string) {
  const sr = await tx.stepRun.update({ where: { id: stepRunId }, data: { status: 'done', locked: true, completedAt: new Date(), completedById: userId, approvalId: null } });
  const run = await tx.processRun.findUniqueOrThrow({ where: { id: sr.runId } });
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: run.leadId } });
  const def = await tx.processStep.findUniqueOrThrow({ where: { id: sr.stepId } });
  await tx.leadActivity.create({ data: activity(lead, userId, { type: 'process', remark: `Step done: ${def.name}`, data: { runId: run.id, stepRunId } }) });
  const open = await tx.stepRun.findFirst({ where: { runId: run.id, status: { not: 'done' } }, orderBy: { position: 'asc' } });
  if (!open) {
    await tx.processRun.update({ where: { id: run.id }, data: { status: 'completed', completedAt: new Date() } });
    await tx.leadActivity.create({ data: activity(lead, userId, { type: 'process', remark: 'Process completed — record the customer’s rating', data: { runId: run.id } }) });
    return { completed: true };
  }
  if (open.status === 'pending') {
    const next = await tx.processStep.findUniqueOrThrow({ where: { id: open.stepId } });
    await activateStep(tx, open.id, next, lead);
  }
  return { completed: false };
}

/** The person's access to a step: their roles' setting on the step (best wins); roles not listed may edit. */
export function stepAccess(access: unknown, myRoleIds: string[], isAdmin: boolean, canWork: boolean): StepAccess {
  if (isAdmin) return 'edit';
  const map = (access ?? {}) as Record<string, StepAccess>;
  const levels = myRoleIds.map((r) => map[r] ?? 'edit');
  const best: StepAccess = levels.includes('edit') ? 'edit' : levels.includes('view') ? 'view' : levels.length ? 'none' : 'view';
  return best === 'edit' && !canWork ? 'view' : best;
}
