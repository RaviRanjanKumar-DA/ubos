import { AsyncLocalStorage } from 'async_hooks';
import type { DataScope, EffectivePermissions, FeatureKey, RoleAssignment } from '@ubos/shared';

export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export interface AuthInfo {
  userId: string;
  sessionId: string;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  /** The user's role requires 2FA (organization policy) but it is not set up yet. */
  mfaSetupRequired: boolean;
  name: string;
  email: string;
  teamId: string | null;
  assignments: RoleAssignment[];
  /** Workspace selected via X-Workspace; null = organization view. */
  workspaceId: string | null;
  accessibleWorkspaceIds: string[];
  permissions: EffectivePermissions;
  features: Set<FeatureKey>;
}

export interface RequestContext {
  traceId: string;
  ip: string | null;
  tenant?: TenantInfo;
  auth?: AuthInfo;
  platformUserId?: string;
  /** Set while automation runs: how many rules led here (stops endless chains). */
  automationDepth?: number;
}

export const contextStore = new AsyncLocalStorage<RequestContext>();

export function ctx(): RequestContext {
  const c = contextStore.getStore();
  if (!c) throw new Error('No request context');
  return c;
}

export function tenantId(): string {
  const t = ctx().tenant;
  if (!t) throw new Error('No tenant resolved for this request');
  return t.id;
}

export function auth(): AuthInfo {
  const a = ctx().auth;
  if (!a) throw new Error('Not authenticated');
  return a;
}

export type { DataScope };
