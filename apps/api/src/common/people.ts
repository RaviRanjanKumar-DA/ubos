import type { Tx } from '@ubos/database';
import { auth } from './context';

/**
 * People whose tasks / calendar the viewer may see, following their "View leads" scope:
 * own → just me; team / department / branch → those colleagues; business line → people working in my business lines;
 * organization → everyone (returns null = no restriction).
 */
export async function visibleUserIds(tx: Tx): Promise<string[] | null> {
  const a = auth();
  const scope = a.permissions['crm.lead.view'];
  if (scope === 'ORGANIZATION' && !a.workspaceId) return null;
  if (!scope || scope === 'OWN') return [a.userId];
  if (scope === 'WORKSPACE' || scope === 'ORGANIZATION') {
    const ws = a.workspaceId ? [a.workspaceId] : a.accessibleWorkspaceIds;
    const rows = await tx.userRole.findMany({ where: { OR: [{ workspaceId: { in: ws } }, { workspaceId: null }] }, select: { userId: true } });
    return [...new Set([a.userId, ...rows.map((r) => r.userId)])];
  }
  const me = await tx.user.findUnique({ where: { id: a.userId }, include: { team: { include: { department: true } } } });
  if (!me?.team) return [a.userId];
  const where =
    scope === 'TEAM' ? { teamId: me.team.id }
    : scope === 'DEPARTMENT' ? { team: { departmentId: me.team.departmentId } }
    : { team: { department: { branchId: me.team.department.branchId } } };
  const users = await tx.user.findMany({ where, select: { id: true } });
  return [...new Set([a.userId, ...users.map((u) => u.id)])];
}
