import { accessibleWorkspaceIds, DataScope, FeatureKey, resolvePermissions, RoleAssignment } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import type { DbService } from './db.service';
import { AuthInfo, contextStore, TenantInfo } from './context';

/** The plan's modules for the organization in context (subscription features + overrides). */
export async function tenantFeatures(tx: Tx) {
  const sub = await tx.subscription.findFirst({ where: { status: { in: ['active', 'trialing'] } }, include: { plan: { include: { features: true } } }, orderBy: { currentPeriodEnd: 'desc' } });
  const features = new Set<FeatureKey>((sub?.plan.features ?? []).map((f) => f.featureKey as FeatureKey));
  for (const o of await tx.tenantEntitlement.findMany()) { if (o.enabled) features.add(o.featureKey as FeatureKey); else features.delete(o.featureKey as FeatureKey); }
  return { features, plan: sub?.plan ?? null };
}

/**
 * The same permissions the person gets when signed in (organization view) — for work done on their behalf outside a
 * browser session: scheduled emails, the phone app.
 */
export async function authFor(db: DbService, t: TenantInfo, userId: string, sessionId = 'system'): Promise<AuthInfo> {
  return contextStore.run({ traceId: 'auth', ip: null, tenant: t }, () => db.tenant(async (tx: Tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
    const workspaces = await tx.workspace.findMany({ where: { isArchived: false }, select: { id: true } });
    const { features } = await tenantFeatures(tx);
    const assignments: RoleAssignment[] = user.roles.map((r) => ({
      roleName: r.role.name, workspaceId: r.workspaceId, validFrom: r.validFrom, validTo: r.validTo,
      grants: r.role.permissions.map((p) => ({ key: p.permission.key, scope: p.scope as DataScope, isDeny: p.isDeny })),
    }));
    return {
      userId: user.id, sessionId, totpEnabled: user.totpEnabled, mustChangePassword: false, mfaSetupRequired: false, name: user.name, email: user.email,
      teamId: user.teamId, assignments, workspaceId: null, accessibleWorkspaceIds: accessibleWorkspaceIds(assignments, workspaces.map((w) => w.id)),
      permissions: resolvePermissions(assignments, { workspaceId: null, features }), features,
    };
  }));
}
