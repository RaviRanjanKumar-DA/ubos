import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { ADMIN_ROLE, DataScope, normalizeMobile, toCsv } from '@ubos/shared';
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
const BulkUsers = z.object({
  dryRun: z.boolean().default(true),
  sendInvite: z.boolean().default(true),
  rows: z.array(z.record(z.string().max(200))).min(1).max(500),
});

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
  /** Licence usage for the Users page: bought, used, free, plan and expiry. */
  @Get('licences')
  @RequirePermission('org.user.view')
  licences() {
    return this.db.tenant(async (tx) => {
      const sub = await tx.subscription.findFirst({ where: { status: { in: ['active', 'trialing'] } }, include: { plan: true }, orderBy: { currentPeriodEnd: 'desc' } });
      const used = await tx.user.count({ where: { isActive: true } });
      return {
        plan: sub?.plan.name ?? null, status: sub?.status ?? null, licences: sub?.licences ?? 0, used,
        available: Math.max(0, (sub?.licences ?? 0) - used), expiresAt: sub?.currentPeriodEnd ?? null, trialEndsAt: sub?.trialEndsAt ?? null,
      };
    });
  }

  /** CSV of the users the viewer can see. */
  @Get('export')
  @RequirePermission('org.user.view', 'ORGANIZATION')
  async export(@Res() res: Response) {
    const rows = await this.db.tenant(async (tx) => {
      const users = await tx.user.findMany({
        orderBy: { name: 'asc' },
        include: { team: { select: { name: true } }, roles: { include: { role: { select: { name: true } } } } },
      });
      const workspaces = new Map((await tx.workspace.findMany({ select: { id: true, name: true } })).map((w) => [w.id, w.name]));
      const sub = await tx.subscription.findFirst({ include: { plan: true }, orderBy: { currentPeriodEnd: 'desc' } });
      await this.db.audit(tx, { entity: 'user', entityId: 'export', action: 'user.exported', newValue: { rows: users.length } });
      return [
        ['Name', 'Email', 'Username', 'Mobile', 'Roles', 'Team', 'Status', '2FA', 'Licence', 'Licence expiry'],
        ...users.map((u) => [
          u.name, u.email, u.username ?? '', u.mobile ?? '',
          u.roles.map((r) => `${r.role.name} (${r.workspaceId ? workspaces.get(r.workspaceId) ?? '?' : 'All workspaces'})`).join('; '),
          u.team?.name ?? '', !u.isActive ? 'Inactive' : u.lockedUntil && u.lockedUntil > new Date() ? 'Locked' : 'Active', u.totpEnabled ? 'On' : 'Off',
          u.isActive ? sub?.plan.name ?? '' : '', u.isActive && sub ? sub.currentPeriodEnd.toISOString().slice(0, 10) : '',
        ]),
      ];
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send('\uFEFF' + toCsv(rows));
  }

  /**
   * Bulk add users from Excel / CSV rows: name, email, mobile, username, role, workspace ("All" = organization-wide).
   * dryRun=true only checks; dryRun=false creates the valid rows. Invitations replace temporary passwords here:
   * people sign in with "Email me a code" and set their password.
   */
  @Post('bulk')
  @HttpCode(200)
  @RequirePermission('org.user.manage', 'ORGANIZATION')
  bulk(@Body() body: unknown) {
    const input = parse(BulkUsers, body);
    const org = ctx().tenant!;
    return this.db.tenant(async (tx) => {
      const roles = await tx.role.findMany({ include: { permissions: { include: { permission: true } } } });
      const workspaces = await tx.workspace.findMany({ where: { isArchived: false } });
      const sub = await tx.subscription.findFirst({ where: { status: { in: ['active', 'trialing'] } }, orderBy: { currentPeriodEnd: 'desc' } });
      let free = Math.max(0, (sub?.licences ?? 0) - (await tx.user.count({ where: { isActive: true } })));
      const seenEmail = new Set<string>();
      const results: { row: number; status: 'ok' | 'error'; message?: string; name?: string; email?: string }[] = [];
      const toInvite: { name: string; email: string }[] = [];

      for (const [i, raw] of input.rows.entries()) {
        const row = i + 2;
        const name = (raw.name ?? '').trim();
        const email = (raw.email ?? '').trim().toLowerCase();
        const fail = (message: string) => results.push({ row, status: 'error', message, name, email });
        if (name.length < 2) { fail('Name is missing'); continue; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { fail('Valid email is required'); continue; }
        if (seenEmail.has(email)) { fail('Same email appears earlier in this file'); continue; }
        seenEmail.add(email);
        const roleName = (raw.role ?? '').trim();
        const role = roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
        if (!role) { fail(`Unknown role "${roleName}"`); continue; }
        const wsName = (raw.workspace ?? '').trim();
        const ws = !wsName || /^all( workspaces)?$/i.test(wsName) ? null : workspaces.find((w) => w.name.toLowerCase() === wsName.toLowerCase());
        if (ws === undefined) { fail(`Unknown workspace "${wsName}"`); continue; }
        let mobile: string | null = null;
        if (raw.mobile?.trim()) {
          mobile = normalizeMobile(raw.mobile);
          if (!mobile) { fail(`"${raw.mobile}" is not a valid mobile number`); continue; }
        }
        const username = raw.username?.trim().toLowerCase() || null;
        if (username && !/^[a-z0-9._-]{3,30}$/.test(username)) { fail('Username: 3–30 letters, numbers, dot, dash or underscore'); continue; }
        try {
          await this.assertUnique(tx, { email, username, mobile });
          if (role.name === ADMIN_ROLE && !auth().assignments.some((r) => r.roleName === ADMIN_ROLE && r.workspaceId === null)) throw new ForbiddenException({ message: `Only an ${ADMIN_ROLE} can assign that role` });
          await this.validateAssignments(tx, [{ roleId: role.id, workspaceId: ws?.id ?? null }]);
        } catch (e) {
          fail((e as { response?: { message?: string } }).response?.message ?? 'Not allowed');
          continue;
        }
        if (free <= 0) { fail('No free user licence — buy more licences first'); continue; }
        free--;
        if (!input.dryRun) {
          const user = await tx.user.create({
            data: { tenantId: tenantId(), name, email, username, mobile, passwordHash: await bcrypt.hash(`Ub${randomToken(12)}9`, 10), mustChangePassword: true },
          });
          await this.writeAssignments(tx, user.id, [{ roleId: role.id, workspaceId: ws?.id ?? null }]);
          toInvite.push({ name, email });
        }
        results.push({ row, status: 'ok', name, email });
      }
      if (!input.dryRun) {
        await this.db.audit(tx, { entity: 'user', entityId: 'bulk', action: 'user.bulk_created', newValue: { created: toInvite.length, failed: results.filter((r) => r.status === 'error').length } });
      }
      return { dryRun: input.dryRun, ok: results.filter((r) => r.status === 'ok').length, errors: results.filter((r) => r.status === 'error').length, results, toInvite };
    }, { timeoutMs: 120_000 }).then(async (r) => {
      if (!r.dryRun && input.sendInvite) {
        const web = (process.env.WEB_ORIGIN ?? 'http://localhost:3030').split(',')[0];
        for (const u of r.toInvite) {
          await this.mailer.send(u.email, `You have been added to ${org.name} on UBOS`,
            `Hello ${u.name},\n\nYou have been added to ${org.name} on UBOS.\nSign in: ${web}/login?org=${org.slug} (organization code ${org.slug})\n\nChoose "Email me a sign-in code" with this email, then set your own password.`).catch(() => undefined);
        }
      }
      const { toInvite: _t, ...rest } = r;
      return rest;
    });
  }

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
