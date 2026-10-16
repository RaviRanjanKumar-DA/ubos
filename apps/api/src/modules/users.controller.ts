import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { DataScope, normalizeMobile } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { auth, ctx, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { activeAdminCount, assertCanGrant, lastAdminError } from '../common/role-guards';
import { randomToken } from '../auth/crypto';
import { Mailer } from '../auth/mailer';

const RoleAssignment = z.object({
  roleId: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  validFrom: z.coerce.date().nullable().optional(),
  validTo: z.coerce.date().nullable().optional(),
  isPrimary: z.boolean().optional(),
});
const Profile = {
  name: z.string().trim().min(2).max(80),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, '3–30 letters, numbers, dot, dash or underscore').nullable().optional(),
  mobile: z.string().trim().max(20).nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  reportsToId: z.string().uuid().nullable().optional(),
};
const CreateUser = z.object({
  ...Profile,
  email: z.string().trim().toLowerCase().email(),
  roles: z.array(RoleAssignment).min(1, 'Give the user at least one role').max(20),
  sendInvite: z.boolean().default(true),
});
const UpdateUser = z.object({ ...Profile, name: Profile.name.optional(), isActive: z.boolean().optional() });
const SetRoles = z.object({ roles: z.array(RoleAssignment).max(20) });

type Assignment = z.infer<typeof RoleAssignment>;

@Controller('api/v1/users')
export class UsersController {
  constructor(private db: DbService, private mailer: Mailer) {}

  /** Organization-wide viewers see everyone; workspace-level viewers see people working in their workspace. */
  @Get()
  @RequirePermission('org.user.view')
  list() {
    const a = auth();
    return this.db.tenant(async (tx) => {
      const orgWide = a.permissions['org.user.view'] === 'ORGANIZATION';
      const users = await tx.user.findMany({
        where: orgWide ? {} : { OR: [{ roles: { some: { workspaceId: a.workspaceId ?? '__none__' } } }, { team: { workspaceId: a.workspaceId ?? '__none__' } }] },
        orderBy: { name: 'asc' },
        include: {
          team: { select: { id: true, name: true } },
          reportsTo: { select: { id: true, name: true } },
          roles: { include: { role: { select: { name: true } } } },
        },
      });
      const [workspaces, lastSeen] = await Promise.all([
        tx.workspace.findMany({ select: { id: true, name: true } }),
        tx.session.groupBy({ by: ['userId'], _max: { lastUsedAt: true }, where: { userId: { in: users.map((u) => u.id) } } }),
      ]);
      const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
      const seen = new Map(lastSeen.map((s) => [s.userId, s._max.lastUsedAt]));
      return users.map((u) => ({
        id: u.id, name: u.name, email: u.email, username: u.username, mobile: u.mobile, isActive: u.isActive,
        totpEnabled: u.totpEnabled, locked: !!u.lockedUntil && u.lockedUntil > new Date(), mustChangePassword: u.mustChangePassword,
        team: u.team, reportsTo: u.reportsTo, lastActiveAt: seen.get(u.id) ?? null, createdAt: u.createdAt,
        roles: u.roles.map((r) => ({
          roleId: r.roleId, role: r.role.name, workspaceId: r.workspaceId,
          workspace: r.workspaceId ? wsName.get(r.workspaceId) ?? '?' : null,
          validFrom: r.validFrom, validTo: r.validTo, isPrimary: r.isPrimary,
        })),
      }));
    });
  }

  @Post()
  @RequirePermission('org.user.manage', 'ORGANIZATION')
  async create(@Body() body: unknown) {
    const input = parse(CreateUser, body);
    const org = ctx().tenant!;
    const result = await this.db.tenant(async (tx) => {
      await this.assertLicence(tx);
      const mobile = this.mobile(input.mobile);
      await this.assertUnique(tx, { email: input.email, username: input.username ?? null, mobile });
      await this.assertRefs(tx, input.teamId, input.reportsToId);
      await this.validateAssignments(tx, input.roles);

      const temporaryPassword = `Ub${randomToken(9)}9`;
      const user = await tx.user.create({
        data: {
          tenantId: tenantId(), name: input.name, email: input.email, username: input.username ?? null, mobile,
          teamId: input.teamId ?? null, reportsToId: input.reportsToId ?? null,
          passwordHash: await bcrypt.hash(temporaryPassword, 10), mustChangePassword: true,
        },
      });
      await this.writeAssignments(tx, user.id, input.roles);
      await this.db.audit(tx, {
        entity: 'user', entityId: user.id, action: 'user.created',
        newValue: { name: user.name, email: user.email, roles: input.roles.length },
      });
      return { user, temporaryPassword };
    });

    let inviteSent = false;
    if (input.sendInvite) {
      const web = (process.env.WEB_ORIGIN ?? 'http://localhost:3030').split(',')[0];
      await this.mailer
        .send(
          result.user.email,
          `You have been added to ${org.name} on UBOS`,
          `Hello ${result.user.name},\n\n${auth().name} added you to ${org.name} on UBOS.\n\n` +
            `Sign in: ${web}/login?org=${org.slug}\nOrganization code: ${org.slug}\nEmail: ${result.user.email}\n\n` +
            `Use "Email me a sign-in code", or the temporary password your administrator gives you. ` +
            `You will be asked to choose your own password.`,
        )
        .then(() => (inviteSent = true))
        .catch(() => undefined);
    }
    // The temporary password is shown once to the admin and never stored in readable form.
    return { id: result.user.id, temporaryPassword: result.temporaryPassword, inviteSent };
  }

  @Patch(':id')
  @RequirePermission('org.user.manage', 'ORGANIZATION')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(UpdateUser, body);
    return this.db.tenant(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
      const mobile = input.mobile === undefined ? undefined : this.mobile(input.mobile);
      await this.assertUnique(tx, { username: input.username, mobile }, id);
      await this.assertRefs(tx, input.teamId, input.reportsToId, id);

      if (input.isActive === false && user.isActive) {
        if (id === auth().userId) throw new ForbiddenException({ code: 'CANNOT_DEACTIVATE_SELF', message: 'You cannot deactivate your own account' });
        if ((await activeAdminCount(tx, id)) === 0) throw lastAdminError();
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'user_deactivated' } });
      }
      if (input.isActive === true && !user.isActive) await this.assertLicence(tx);

      const data = {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.username !== undefined && { username: input.username }),
        ...(mobile !== undefined && { mobile }),
        ...(input.teamId !== undefined && { teamId: input.teamId }),
        ...(input.reportsToId !== undefined && { reportsToId: input.reportsToId }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      };
      const updated = await tx.user.update({ where: { id }, data });
      const changed = Object.keys(data) as (keyof typeof data)[];
      await this.db.audit(tx, {
        entity: 'user', entityId: id,
        action: input.isActive === false ? 'user.deactivated' : input.isActive === true && !user.isActive ? 'user.reactivated' : 'user.updated',
        oldValue: Object.fromEntries(changed.map((k) => [k, user[k as keyof typeof user]])),
        newValue: data,
      });
      return { id: updated.id };
    });
  }

  /** Replaces all of a user's role assignments (each for one workspace or the whole organization). */
  @Put(':id/roles')
  @RequirePermission('org.user.manage', 'ORGANIZATION')
  setRoles(@Param('id') id: string, @Body() body: unknown) {
    const { roles } = parse(SetRoles, body);
    return this.db.tenant(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
      await this.validateAssignments(tx, roles);
      await tx.userRole.deleteMany({ where: { userId: id } });
      await this.writeAssignments(tx, id, roles);
      if (user.isActive && (await activeAdminCount(tx)) === 0) throw lastAdminError(); // rolls back
      const names = new Map((await tx.role.findMany({ select: { id: true, name: true } })).map((r) => [r.id, r.name]));
      await this.db.audit(tx, {
        entity: 'user', entityId: id, action: 'user.roles_changed',
        oldValue: user.roles.map((r) => ({ role: r.role.name, workspaceId: r.workspaceId })),
        newValue: roles.map((r) => ({ role: names.get(r.roleId), workspaceId: r.workspaceId })),
      });
      return { ok: true };
    });
  }

  // ── helpers ──

  private mobile(v: string | null | undefined) {
    if (!v) return null;
    const m = normalizeMobile(v);
    if (!m) throw new BadRequestException({ code: 'INVALID_MOBILE', message: 'Enter a valid mobile number' });
    return m;
  }

  /** Paid licences: active users can never exceed the number bought in the subscription. */
  private async assertLicence(tx: Tx) {
    const sub = await tx.subscription.findFirst({ where: { status: { in: ['active', 'trialing'] } }, orderBy: { currentPeriodEnd: 'desc' } });
    const active = await tx.user.count({ where: { isActive: true } });
    if (sub && active >= sub.licences) {
      throw new ForbiddenException({
        code: 'LICENCE_LIMIT_REACHED',
        message: `All ${sub.licences} user licences are in use. Buy more licences or deactivate a user first.`,
      });
    }
  }

  private async assertUnique(tx: Tx, f: { email?: string; username?: string | null; mobile?: string | null }, exceptId?: string) {
    const not = exceptId ? { id: { not: exceptId } } : {};
    if (f.email && (await tx.user.findFirst({ where: { email: f.email, ...not } }))) {
      throw new ConflictException({ code: 'EMAIL_TAKEN', message: 'A user with this email already exists' });
    }
    if (f.username && (await tx.user.findFirst({ where: { username: f.username, ...not } }))) {
      throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'This username is already taken' });
    }
    if (f.mobile && (await tx.user.findFirst({ where: { mobile: f.mobile, ...not } }))) {
      throw new ConflictException({ code: 'MOBILE_TAKEN', message: 'Another user already has this mobile number' });
    }
  }

  private async assertRefs(tx: Tx, teamId?: string | null, reportsToId?: string | null, selfId?: string) {
    if (teamId && !(await tx.team.findUnique({ where: { id: teamId } }))) {
      throw new BadRequestException({ code: 'TEAM_NOT_FOUND', message: 'Team not found' });
    }
    if (!reportsToId) return;
    if (reportsToId === selfId) throw new BadRequestException({ code: 'INVALID_MANAGER', message: 'A user cannot report to themselves' });
    // Walk up the chain to stop loops (A → B → A).
    let cursor: string | null = reportsToId;
    for (let depth = 0; cursor && depth < 50; depth++) {
      const u: { id: string; reportsToId: string | null } | null = await tx.user.findUnique({ where: { id: cursor }, select: { id: true, reportsToId: true } });
      if (!u) throw new BadRequestException({ code: 'INVALID_MANAGER', message: 'Manager not found' });
      if (selfId && u.reportsToId === selfId) throw new BadRequestException({ code: 'INVALID_MANAGER', message: 'This would create a reporting loop' });
      cursor = u.reportsToId;
    }
  }

  private async validateAssignments(tx: Tx, roles: Assignment[]) {
    const roleIds = [...new Set(roles.map((r) => r.roleId))];
    const found = await tx.role.findMany({
      where: { id: { in: roleIds } },
      include: { permissions: { include: { permission: true } } },
    });
    if (found.length !== roleIds.length) throw new BadRequestException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
    const wsIds = [...new Set(roles.map((r) => r.workspaceId).filter(Boolean) as string[])];
    if (wsIds.length && (await tx.workspace.count({ where: { id: { in: wsIds } } })) !== wsIds.length) {
      throw new BadRequestException({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' });
    }
    for (const r of roles) {
      if (r.validFrom && r.validTo && r.validTo <= r.validFrom) {
        throw new BadRequestException({ code: 'INVALID_DATES', message: 'Role end date must be after the start date' });
      }
      const role = found.find((f) => f.id === r.roleId)!;
      // A workspace-limited assignment is capped at WORKSPACE scope, so check at that level.
      assertCanGrant(
        role.permissions.map((p) => ({
          key: p.permission.key,
          scope: (r.workspaceId && p.scope === 'ORGANIZATION' ? 'WORKSPACE' : p.scope) as DataScope,
          isDeny: p.isDeny,
        })),
        role.name,
      );
    }
    const seen = new Set<string>();
    for (const r of roles) {
      const k = `${r.roleId}:${r.workspaceId}`;
      if (seen.has(k)) throw new BadRequestException({ code: 'DUPLICATE_ROLE', message: 'The same role is assigned twice for the same workspace' });
      seen.add(k);
    }
  }

  private async writeAssignments(tx: Tx, userId: string, roles: Assignment[]) {
    const primary = roles.findIndex((r) => r.isPrimary);
    await tx.userRole.createMany({
      data: roles.map((r, i) => ({
        tenantId: tenantId(), userId, roleId: r.roleId, workspaceId: r.workspaceId,
        validFrom: r.validFrom ?? null, validTo: r.validTo ?? null, isPrimary: primary === -1 ? i === 0 : i === primary,
      })),
    });
  }
}
