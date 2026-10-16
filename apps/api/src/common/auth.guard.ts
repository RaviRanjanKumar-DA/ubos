import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  accessibleWorkspaceIds, DataScope, FeatureKey, PermissionKey, resolvePermissions, RoleAssignment,
} from '@ubos/shared';
import { DbService } from './db.service';
import { SessionService } from '../auth/sessions';
import { DEFAULT_SETTINGS } from '../auth/login.service';
import { ipAllowed, normalizeIp } from '../auth/ip';
import { ctx } from './context';

export const IS_PUBLIC = 'isPublic';
export const PERMISSION = 'permission';
export const FEATURE = 'feature';
export const MIN_SCOPE = 'minScope';

/** Route needs no login (still tenant-scoped). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route needs this permission in the current workspace / organization view. */
export const RequirePermission = (key: PermissionKey, minScope?: DataScope) =>
  (target: object, key2?: string | symbol, desc?: PropertyDescriptor) => {
    SetMetadata(PERMISSION, key)(target, key2!, desc!);
    if (minScope) SetMetadata(MIN_SCOPE, minScope)(target, key2!, desc!);
  };
/** Route needs this module in the tenant's plan. */
export const RequireFeature = (key: FeatureKey) => SetMetadata(FEATURE, key);

const SCOPE_ORDER: DataScope[] = ['OWN', 'TEAM', 'DEPARTMENT', 'BRANCH', 'WORKSPACE', 'ORGANIZATION'];

/**
 * Tenant API guard. Checks, in order: valid token for THIS tenant → plan entitlement → role permission.
 * Loads the user's role assignments and resolves effective permissions for the selected workspace.
 */
@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private sessions: SessionService, private db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.path.startsWith('/api/v1')) return true; // platform & health routes have their own rules
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = this.sessions.tokenFrom(req, 'tenant');
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Login required' });
    const payload = await this.sessions.verifyAccess('tenant', token);
    const c = ctx();
    // A token issued for one organization can never be used against another.
    if (payload.typ !== 'tenant' || payload.tid !== c.tenant?.id) {
      throw new UnauthorizedException({ code: 'TOKEN_TENANT_MISMATCH', message: 'Token does not belong to this organization' });
    }

    const requestedWs = (req.headers['x-workspace'] as string) || null;
    const data = await this.db.tenant(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: payload.sub },
        include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
      });
      const workspaces = await tx.workspace.findMany({ where: { isArchived: false }, select: { id: true } });
      const sub = await tx.subscription.findFirst({
        where: { status: { in: ['active', 'trialing'] } },
        include: { plan: { include: { features: true } } },
        orderBy: { currentPeriodEnd: 'desc' },
      });
      const overrides = await tx.tenantEntitlement.findMany();
      const session = await tx.session.findUnique({ where: { id: payload.sid } });
      const settings = (await tx.organizationSetting.findUnique({ where: { tenantId: payload.tid! } })) ?? DEFAULT_SETTINGS;
      return { user, workspaces, sub, overrides, session, settings };
    });
    if (!data.user || !data.user.isActive) throw new UnauthorizedException({ code: 'USER_INACTIVE', message: 'User is inactive' });
    // Logout, remote logout and password changes take effect immediately, not when the access token expires.
    if (!data.session || data.session.revokedAt || data.session.userId !== data.user.id) {
      throw new UnauthorizedException({ code: 'SESSION_REVOKED', message: 'You were signed out, please log in again' });
    }
    if (!ipAllowed(normalizeIp(req.ip), data.settings.ipAllowlist)) {
      throw new ForbiddenException({ code: 'IP_NOT_ALLOWED', message: 'Access is not allowed from this network' });
    }

    const features = new Set<FeatureKey>((data.sub?.plan.features ?? []).map((f) => f.featureKey as FeatureKey));
    for (const o of data.overrides) {
      if (o.enabled) features.add(o.featureKey as FeatureKey);
      else features.delete(o.featureKey as FeatureKey);
    }

    const assignments: RoleAssignment[] = data.user.roles.map((r) => ({
      roleName: r.role.name,
      workspaceId: r.workspaceId,
      validFrom: r.validFrom,
      validTo: r.validTo,
      grants: r.role.permissions.map((p) => ({ key: p.permission.key, scope: p.scope as DataScope, isDeny: p.isDeny })),
    }));
    const accessible = accessibleWorkspaceIds(assignments, data.workspaces.map((w) => w.id));
    if (requestedWs && !accessible.includes(requestedWs)) {
      throw new ForbiddenException({ code: 'WORKSPACE_FORBIDDEN', message: 'You do not have access to this workspace' });
    }

    const mfaSetupRequired = !data.user.totpEnabled && assignments.some((r) => data.settings.require2faRoles.includes(r.roleName));
    c.auth = {
      userId: data.user.id,
      sessionId: data.session.id,
      totpEnabled: data.user.totpEnabled,
      mustChangePassword: data.user.mustChangePassword,
      mfaSetupRequired,
      name: data.user.name,
      email: data.user.email,
      teamId: data.user.teamId,
      assignments,
      workspaceId: requestedWs,
      accessibleWorkspaceIds: accessible,
      permissions: resolvePermissions(assignments, { workspaceId: requestedWs, features }),
      features,
    };

    // Until the password is changed / 2FA is set up, only the account endpoints (me, password, 2fa, logout) work.
    if (!req.path.startsWith('/api/v1/auth/')) {
      if (c.auth.mustChangePassword) throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'Please set a new password first' });
      if (mfaSetupRequired) throw new ForbiddenException({ code: 'MFA_SETUP_REQUIRED', message: 'Your organization requires two-factor authentication. Please set it up first.' });
    }

    const feature = this.reflector.getAllAndOverride<FeatureKey>(FEATURE, targets);
    if (feature && !features.has(feature)) {
      throw new ForbiddenException({ code: 'PLAN_UPGRADE_REQUIRED', message: `Your plan does not include ${feature}` });
    }
    const perm = this.reflector.getAllAndOverride<PermissionKey>(PERMISSION, targets);
    if (perm) {
      const scope = c.auth.permissions[perm];
      const min = this.reflector.getAllAndOverride<DataScope>(MIN_SCOPE, targets);
      if (!scope || (min && SCOPE_ORDER.indexOf(scope) < SCOPE_ORDER.indexOf(min))) {
        throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `Missing permission ${perm}` });
      }
    }
    return true;
  }
}
