import type { Prisma, Tx } from '@ubos/database';
import { startProcessesOnWin } from './process-engine';
import { emitEvent } from './events';

/**
 * Active users who may own leads in a workspace: a valid role there (or organization-wide) that can work leads
 * (crm.lead.update), and no role that denies it — so read-only people such as auditors never receive leads.
 */
export async function eligibleOwners(tx: Tx, workspaceId: string) {
  const now = new Date();
  const valid = { AND: [{ OR: [{ validTo: null }, { validTo: { gt: now } }] }, { OR: [{ validFrom: null }, { validFrom: { lte: now } }] }] };
  return tx.user.findMany({
    where: {
      isActive: true,
      roles: {
        some: {
          OR: [{ workspaceId }, { workspaceId: null }],
          ...valid,
          role: { permissions: { some: { isDeny: false, permission: { key: 'crm.lead.update' } } } },
        },
      },
      NOT: { roles: { some: { ...valid, role: { permissions: { some: { isDeny: true, permission: { key: 'crm.lead.update' } } } } } } },
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * Picks the owner for an incoming lead using the workspace's assignment rules:
 * 1. sticky — a returning customer goes back to their primary RM (if still eligible here);
 * 2. otherwise round-robin over the pool (or all eligible users), a fixed owner, or the creator.
 * The caller persists `state.cursor` back to the workspace after a batch.
 */
export function makeAssigner(
  ws: { assignmentMode: string; assignmentUserIds: string[]; assignmentCursor: number; stickyOwner: boolean },
  eligible: string[],
  creatorId: string,
  avail: Availability = { paused: new Set(), cover: new Map() },
) {
  const eligibleSet = new Set(eligible);
  const pool = ws.assignmentUserIds.filter((id) => eligibleSet.has(id));
  const rr = pool.length ? pool : eligible;
  const state = { cursor: ws.assignmentCursor };
  // Someone away hands new leads to their cover person (when that person works in this business line).
  const covered = (id: string) => { const c = avail.cover.get(id); return c && eligibleSet.has(c) ? c : id; };
  const free = (id: string) => !avail.paused.has(id) && !avail.cover.has(id);
  return {
    state,
    pick(customerPrimaryRmId?: string | null): string {
      if (ws.stickyOwner && customerPrimaryRmId && eligibleSet.has(customerPrimaryRmId)) {
        if (avail.cover.has(customerPrimaryRmId)) return covered(customerPrimaryRmId);
        if (!avail.paused.has(customerPrimaryRmId)) return customerPrimaryRmId;
      }
      if (ws.assignmentMode === 'creator' || !rr.length) return creatorId;
      if (ws.assignmentMode === 'fixed') return pool[0] ? covered(pool[0]) : creatorId;
      // Round-robin skips people who stopped accepting new leads or are away.
      for (let i = 0; i < rr.length; i++) {
        const owner = rr[state.cursor % rr.length];
        state.cursor = (state.cursor + 1) % 1_000_000;
        if (free(owner)) return owner;
      }
      return covered(rr[state.cursor % rr.length]);
    },
  };
}

export interface Availability { paused: Set<string>; cover: Map<string, string> }

/** Who is not taking new leads right now: the accepting-new-leads switch is off, or they are away with a cover. */
export async function assignmentAvailability(tx: Tx): Promise<Availability> {
  const now = new Date();
  const [paused, covers] = await Promise.all([
    tx.user.findMany({ where: { acceptingLeads: false }, select: { id: true } }),
    tx.userCover.findMany({ where: { cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { paused: new Set(paused.map((u) => u.id)), cover: new Map(covers.map((c) => [c.userId, c.coverUserId])) };
}

/** Keeps Lead.nextFollowUpAt equal to the earliest open follow-up. */
export async function syncNextFollowUp(tx: Tx, leadId: string) {
  const next = await tx.followUp.findFirst({ where: { leadId, doneAt: null }, orderBy: { dueAt: 'asc' }, select: { dueAt: true } });
  await tx.lead.update({ where: { id: leadId }, data: { nextFollowUpAt: next?.dueAt ?? null } });
}

/** Adds a follow-up to a lead and puts it on the lead's journey. */
export async function addLeadFollowUp(tx: Tx, lead: { id: string; tenantId: string; workspaceId: string; ownerId: string | null }, userId: string, dueAt: Date, note?: string | null) {
  const f = await tx.followUp.create({ data: { tenantId: lead.tenantId, leadId: lead.id, dueAt, note: note ?? null, userId: lead.ownerId ?? userId, createdById: userId } });
  await tx.leadActivity.create({ data: activity(lead, userId, { type: 'follow_up', remark: note ?? null, data: { dueAt: dueAt.toISOString() } }) });
  return f;
}

export function activity(
  lead: { id: string; tenantId: string; workspaceId: string },
  userId: string | null,
  a: { type: string; remark?: string | null; disposition?: string | null; connected?: boolean | null; durationSec?: number | null; data?: Prisma.InputJsonValue },
): Prisma.LeadActivityCreateManyInput {
  return { tenantId: lead.tenantId, workspaceId: lead.workspaceId, leadId: lead.id, userId, ...a };
}

type StageRow = { id: string; name: string; pipelineId: string; isLost: boolean; isWon?: boolean; requiredFieldKeys: string[]; setStatus: string | null; followUpDays: number | null };
type LeadRow = { id: string; tenantId: string; workspaceId: string; pipelineId: string; stageId: string; status: string | null; lostReason: string | null; ownerId: string | null; customFields: unknown };

/**
 * Moves a lead to a stage applying the stage rules: same pipeline, required fields filled, lost reason
 * for Lost stages, then auto-status and auto follow-up. Returns a reason string when it is not allowed.
 */
export async function applyStageChange(tx: Tx, lead: LeadRow, stage: StageRow, userId: string, lostReason?: string | null): Promise<string | null> {
  if (lead.pipelineId !== stage.pipelineId) return 'Lead is in a different pipeline';
  const values = (lead.customFields ?? {}) as Record<string, unknown>;
  const missing = stage.requiredFieldKeys.filter((k) => values[k] === undefined || values[k] === null || values[k] === '' || (Array.isArray(values[k]) && !(values[k] as unknown[]).length));
  if (missing.length) {
    const labels = await tx.leadField.findMany({ where: { workspaceId: lead.workspaceId, key: { in: missing } }, select: { label: true } });
    return `Fill ${labels.map((l) => l.label).join(', ') || missing.join(', ')} before moving to ${stage.name}`;
  }
  let reason: string | null = null;
  if (stage.isLost) {
    const reasons = await tx.workspaceOption.findMany({ where: { workspaceId: lead.workspaceId, kind: 'lost_reason', isArchived: false } });
    if (reasons.length && !reasons.some((r) => r.value === lostReason)) return 'Choose a lost reason of this business line';
    reason = lostReason ?? null;
  }
  if (lead.stageId === stage.id && lead.lostReason === reason) return null;
  let status = lead.status;
  if (stage.setStatus) {
    const ok = await tx.workspaceOption.findFirst({ where: { workspaceId: lead.workspaceId, kind: 'lead_status', value: stage.setStatus, isArchived: false } });
    if (ok) status = stage.setStatus;
  }
  await tx.lead.update({ where: { id: lead.id }, data: { stageId: stage.id, lostReason: reason, stageChangedAt: new Date(), status } });
  await tx.leadActivity.create({ data: activity(lead, userId, { type: 'stage', data: { from: lead.stageId, to: stage.id, lostReason: reason } }) });
  if (status !== lead.status) await tx.leadActivity.create({ data: activity(lead, userId, { type: 'status', data: { from: lead.status, to: status, auto: true } }) });
  if (stage.followUpDays && !stage.isLost) {
    const due = new Date(Date.now() + stage.followUpDays * 86_400_000);
    due.setHours(11, 0, 0, 0);
    await tx.followUp.create({ data: { tenantId: lead.tenantId, leadId: lead.id, dueAt: due, userId: lead.ownerId ?? userId, createdById: userId, note: `Auto follow-up after moving to ${stage.name}` } });
    await syncNextFollowUp(tx, lead.id);
  }
  const evt = { leadId: lead.id, customerId: (lead as { customerId?: string }).customerId ?? null, from: lead.stageId, to: stage.id, stageName: stage.name, lostReason: reason, by: userId };
  await emitEvent(tx, lead.tenantId, lead.workspaceId, 'lead.stage_changed', evt);
  if (stage.isWon) await emitEvent(tx, lead.tenantId, lead.workspaceId, 'lead.won', evt);
  if (stage.isLost) await emitEvent(tx, lead.tenantId, lead.workspaceId, 'lead.lost', evt);
  if (stage.isWon) await startProcessesOnWin(tx, lead.id, userId);
  return null;
}

/** The default lead status of a workspace (given to new leads), if one is set. */
export async function defaultStatus(tx: Tx, workspaceId: string) {
  return (await tx.workspaceOption.findFirst({ where: { workspaceId, kind: 'lead_status', isDefault: true, isArchived: false }, select: { value: true } }))?.value ?? null;
}
