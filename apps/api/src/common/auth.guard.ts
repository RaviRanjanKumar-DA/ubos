import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import {
  accessibleWorkspaceIds, DataScope, FeatureKey, PermissionKey, resolvePermissions, RoleAssignment,
} from '@ubos/shared';
import { DbService } from './db.service';
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
  constructor(private reflector: Reflector, private jwt: JwtService, private db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.path.startsWith('/api/v1')) return true; // platform & health routes have their own rules
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Login required' });
    let payload: { sub: string; tid: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: process.env.JWT_ACCESS_SECRET });
    } catch {
      throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Session expired, please log in again' });
    }
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
      return { user, workspaces, sub, overrides };
    });
    if (!data.user || !data.user.isActive) throw new UnauthorizedException({ code: 'USER_INACTIVE', message: 'User is inactive' });

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

    c.auth = {
      userId: data.user.id,
      name: data.user.name,
      email: data.user.email,
      teamId: data.user.teamId,
      assignments,
      workspaceId: requestedWs,
      accessibleWorkspaceIds: accessible,
      permissions: resolvePermissions(assignments, { workspaceId: requestedWs, features }),
      features,
    };

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
