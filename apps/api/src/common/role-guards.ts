import { ForbiddenException } from '@nestjs/common';
import type { Tx } from '@ubos/database';
import { ADMIN_ROLE, DATA_SCOPES, DataScope, resolvePermissions } from '@ubos/shared';
import { auth } from './context';

const rank = (s: DataScope) => DATA_SCOPES.indexOf(s);

/**
 * Anti-escalation rule: a user may only grant (via a role or a role assignment) permissions they hold
 * themselves organization-wide, at least at the same scope. Only an admin can hand out the admin role.
 */
export function assertCanGrant(grants: { key: string; scope: DataScope; isDeny?: boolean }[], roleName?: string) {
  const a = auth();
  const mine = resolvePermissions(a.assignments, { workspaceId: null, features: null });
  if (roleName === ADMIN_ROLE && !a.assignments.some((r) => r.roleName === ADMIN_ROLE && r.workspaceId === null)) {
    throw new ForbiddenException({ code: 'ESCALATION_BLOCKED', message: `Only an ${ADMIN_ROLE} can assign the ${ADMIN_ROLE} role` });
  }
  for (const g of grants) {
    if (g.isDeny) continue; // denies only reduce access
    const held = mine[g.key as keyof typeof mine];
    if (!held || rank(held) < rank(g.scope)) {
      throw new ForbiddenException({
        code: 'ESCALATION_BLOCKED',
        message: `You cannot grant "${g.key}" at ${g.scope.toLowerCase()} scope because you do not have it yourself`,
      });
    }
  }
}

/** Number of active users who hold the admin role organization-wide (optionally ignoring one user). */
export async function activeAdminCount(tx: Tx, excludeUserId?: string) {
  const now = new Date();
  return tx.user.count({
    where: {
      isActive: true,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      roles: {
        some: {
          workspaceId: null,
          role: { name: ADMIN_ROLE },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
          AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }],
        },
      },
    },
  });
}

export function lastAdminError() {
  return new ForbiddenException({
    code: 'LAST_ADMIN',
    message: `Your organization must keep at least one active ${ADMIN_ROLE}. Assign it to someone else first.`,
  });
}
