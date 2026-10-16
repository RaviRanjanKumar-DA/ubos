import { Prisma } from '@ubos/database';
import type { Tx } from '@ubos/database';
import type { PermissionKey } from '@ubos/shared';
import { auth } from './context';

/**
 * Translates the user's data scope for `perm` into a Prisma filter on records that have
 * `workspaceId` and `ownerId` (leads today; tasks, deals etc. later).
 */
export async function scopeFilter(tx: Tx, perm: PermissionKey): Promise<Prisma.LeadWhereInput> {
  const a = auth();
  const scope = a.permissions[perm];
  if (!scope) return { id: '__none__' };

  const where: Prisma.LeadWhereInput = a.workspaceId
    ? { workspaceId: a.workspaceId }
    : { workspaceId: { in: a.accessibleWorkspaceIds } };

  if (scope === 'OWN') return { ...where, ownerId: a.userId };
  if (scope === 'WORKSPACE' || scope === 'ORGANIZATION') return where;

  // TEAM / DEPARTMENT / BRANCH: owners who share the user's team, department or branch.
  const me = await tx.user.findUnique({
    where: { id: a.userId },
    include: { team: { include: { department: true } } },
  });
  if (!me?.team) return { ...where, ownerId: a.userId };
  const teamWhere: Prisma.TeamWhereInput =
    scope === 'TEAM' ? { id: me.team.id }
    : scope === 'DEPARTMENT' ? { departmentId: me.team.departmentId }
    : { department: { branchId: me.team.department.branchId } };
  const owners = await tx.user.findMany({ where: { team: teamWhere }, select: { id: true } });
  return { ...where, ownerId: { in: owners.map((o) => o.id) } };
}
