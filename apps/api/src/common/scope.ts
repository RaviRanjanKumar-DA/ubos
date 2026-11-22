import { Prisma } from '@ubos/database';
import type { Tx } from '@ubos/database';
import type { PermissionKey } from '@ubos/shared';
import { auth } from './context';

/**
 * Translates the user's data scope for `perm` into a Prisma filter on records that have
 * `workspaceId` and `ownerId` (leads today; tasks, deals etc. later).
 */
export async function scopeFilter(tx: Tx, perm: PermissionKey, opts: { deleted?: boolean } = {}): Promise<Prisma.LeadWhereInput> {
  const a = auth();
  const scope = a.permissions[perm];
  if (!scope) return { id: '__none__' };

  // Deleted leads drop out of every list, count and report, except Reports → Deleted leads.
  const gone: Prisma.LeadWhereInput = opts.deleted ? { deletedAt: { not: null } } : { deletedAt: null };
  const where: Prisma.LeadWhereInput = a.workspaceId
    ? { workspaceId: a.workspaceId, ...gone }
    : { workspaceId: { in: a.accessibleWorkspaceIds }, ...gone };

  if (scope === 'WORKSPACE' || scope === 'ORGANIZATION') return where;
  // Besides their own leads, people see leads they were added to (lead team) and leads of colleagues they cover for.
  const onTeam: Prisma.LeadWhereInput = { teamMembers: { some: { userId: a.userId, removedAt: null } } };
  const covering = await coveredUserIds(tx, a.userId);
  if (scope === 'OWN') return { ...where, OR: [{ ownerId: { in: [a.userId, ...covering] } }, onTeam] };

  // TEAM / DEPARTMENT / BRANCH: owners who share the user's team, department or branch.
  const me = await tx.user.findUnique({
    where: { id: a.userId },
    include: { team: { include: { department: true } } },
  });
  if (!me?.team) return { ...where, OR: [{ ownerId: { in: [a.userId, ...covering] } }, onTeam] };
  const teamWhere: Prisma.TeamWhereInput =
    scope === 'TEAM' ? { id: me.team.id }
    : scope === 'DEPARTMENT' ? { departmentId: me.team.departmentId }
    : { department: { branchId: me.team.department.branchId } };
  const owners = await tx.user.findMany({ where: { team: teamWhere }, select: { id: true } });
  return { ...where, OR: [{ ownerId: { in: [...owners.map((o) => o.id), ...covering] } }, onTeam] };
}

/** People this user is covering for right now (temporary cover / out of office). */
export async function coveredUserIds(tx: Tx, userId: string) {
  const now = new Date();
  const rows = await tx.userCover.findMany({ where: { coverUserId: userId, cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now } }, select: { userId: true } });
  return rows.map((r) => r.userId);
}
