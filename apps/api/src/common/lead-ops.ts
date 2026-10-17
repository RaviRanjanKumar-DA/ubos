import type { Prisma, Tx } from '@ubos/database';

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
) {
  const eligibleSet = new Set(eligible);
  const pool = ws.assignmentUserIds.filter((id) => eligibleSet.has(id));
  const rr = pool.length ? pool : eligible;
  const state = { cursor: ws.assignmentCursor };
  return {
    state,
    pick(customerPrimaryRmId?: string | null): string {
      if (ws.stickyOwner && customerPrimaryRmId && eligibleSet.has(customerPrimaryRmId)) return customerPrimaryRmId;
      if (ws.assignmentMode === 'creator' || !rr.length) return creatorId;
      if (ws.assignmentMode === 'fixed') return pool[0] ?? creatorId;
      const owner = rr[state.cursor % rr.length];
      state.cursor = (state.cursor + 1) % 1_000_000;
      return owner;
    },
  };
}

/** Keeps Lead.nextFollowUpAt equal to the earliest open follow-up. */
export async function syncNextFollowUp(tx: Tx, leadId: string) {
  const next = await tx.followUp.findFirst({ where: { leadId, doneAt: null }, orderBy: { dueAt: 'asc' }, select: { dueAt: true } });
  await tx.lead.update({ where: { id: leadId }, data: { nextFollowUpAt: next?.dueAt ?? null } });
}

export function activity(
  lead: { id: string; tenantId: string; workspaceId: string },
  userId: string | null,
  a: { type: string; remark?: string | null; disposition?: string | null; connected?: boolean | null; durationSec?: number | null; data?: Prisma.InputJsonValue },
): Prisma.LeadActivityCreateManyInput {
  return { tenantId: lead.tenantId, workspaceId: lead.workspaceId, leadId: lead.id, userId, ...a };
}
