import { DATA_SCOPES, DataScope, FeatureKey, PERMISSION_FEATURE, PermissionKey } from './permissions';

export interface Grant {
  key: string;
  scope: DataScope;
  isDeny?: boolean;
}

export interface RoleAssignment {
  roleName: string;
  /** null = the role applies to the whole organization (all workspaces). */
  workspaceId: string | null;
  validFrom?: Date | null;
  validTo?: Date | null;
  grants: Grant[];
}

export type EffectivePermissions = Partial<Record<PermissionKey, DataScope>>;

const rank = (s: DataScope) => DATA_SCOPES.indexOf(s);

/**
 * Combines all of a user's role assignments into effective permissions for one workspace
 * (or for the organization view when workspaceId is null).
 *
 * Rules (blueprint section 18):
 *  1. Union of permissions across roles.
 *  2. Widest scope wins.
 *  3. An explicit deny overrides any grant.
 *  4. Assignments outside their validity window are ignored.
 *  5. A workspace-limited assignment only applies inside that workspace, and its scope is
 *     capped at WORKSPACE (it can never see other business lines).
 *  6. Permissions whose feature is not in the tenant's plan are removed.
 */
export function resolvePermissions(
  assignments: RoleAssignment[],
  opts: { workspaceId: string | null; features?: Set<FeatureKey> | null; now?: Date },
): EffectivePermissions {
  const now = opts.now ?? new Date();
  const granted = new Map<string, DataScope>();
  const denied = new Set<string>();

  for (const a of assignments) {
    if (a.validFrom && a.validFrom > now) continue;
    if (a.validTo && a.validTo < now) continue;
    if (a.workspaceId !== null && a.workspaceId !== opts.workspaceId) continue;

    for (const g of a.grants) {
      if (g.isDeny) {
        denied.add(g.key);
        continue;
      }
      let scope = g.scope;
      if (a.workspaceId !== null && rank(scope) > rank('WORKSPACE')) scope = 'WORKSPACE';
      const current = granted.get(g.key);
      if (!current || rank(scope) > rank(current)) granted.set(g.key, scope);
    }
  }

  const result: EffectivePermissions = {};
  for (const [key, scope] of granted) {
    if (denied.has(key)) continue;
    const feature = PERMISSION_FEATURE[key as PermissionKey];
    if (feature && opts.features && !opts.features.has(feature)) continue;
    result[key as PermissionKey] = scope;
  }
  return result;
}

/** Workspaces a user may enter: all of them with any org-wide role, otherwise only those assigned. */
export function accessibleWorkspaceIds(assignments: RoleAssignment[], allWorkspaceIds: string[], now = new Date()) {
  const valid = assignments.filter(
    (a) => !(a.validFrom && a.validFrom > now) && !(a.validTo && a.validTo < now),
  );
  if (valid.some((a) => a.workspaceId === null)) return allWorkspaceIds;
  const ids = new Set(valid.map((a) => a.workspaceId as string));
  return allWorkspaceIds.filter((id) => ids.has(id));
}
