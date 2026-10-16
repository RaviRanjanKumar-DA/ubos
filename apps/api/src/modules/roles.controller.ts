import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { ADMIN_ROLE, DATA_SCOPES, PERMISSION_GROUPS, PERMISSION_KEYS, PERMISSIONS } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { tenantId } from '../common/context';
import { parse } from '../common/errors';
import { assertCanGrant } from '../common/role-guards';

const Grant = z.object({
  key: z.enum(PERMISSION_KEYS as [string, ...string[]]),
  scope: z.enum(DATA_SCOPES),
  isDeny: z.boolean().optional(),
});
const RoleBody = z.object({
  name: z.string().trim().min(2).max(60),
  grants: z.array(Grant).max(PERMISSION_KEYS.length * 2),
});
const CloneBody = z.object({ name: z.string().trim().min(2).max(60) });

@Controller('api/v1')
export class RolesController {
  constructor(private db: DbService) {}

  /** Permission catalogue for the role editor. */
  @Get('permissions')
  @RequirePermission('org.user.view')
  catalogue() {
    return {
      scopes: DATA_SCOPES,
      groups: PERMISSION_GROUPS.map((g) => ({
        label: g.label,
        permissions: PERMISSION_KEYS.filter((k) => k.startsWith(g.prefix)).map((key) => ({ key, description: PERMISSIONS[key] })),
      })),
    };
  }

  @Get('roles')
  @RequirePermission('org.user.view')
  list() {
    return this.db.tenant(async (tx) => {
      const roles = await tx.role.findMany({
        orderBy: { name: 'asc' },
        include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
      });
      return roles.map((r) => ({
        id: r.id, name: r.name, isTemplate: r.isTemplate, isProtected: r.name === ADMIN_ROLE, userCount: r._count.users,
        grants: r.permissions.map((p) => ({ key: p.permission.key, scope: p.scope, isDeny: p.isDeny })),
      }));
    });
  }

  @Post('roles')
  @RequirePermission('org.role.manage', 'ORGANIZATION')
  create(@Body() body: unknown) {
    const input = parse(RoleBody, body);
    assertCanGrant(input.grants);
    return this.db.tenant(async (tx) => {
      await this.assertNameFree(tx, input.name);
      const role = await tx.role.create({ data: { tenantId: tenantId(), name: input.name } });
      await this.writeGrants(tx, role.id, input.grants);
      await this.db.audit(tx, { entity: 'role', entityId: role.id, action: 'role.created', newValue: input });
      return { id: role.id };
    });
  }

  @Put('roles/:id')
  @RequirePermission('org.role.manage', 'ORGANIZATION')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(RoleBody, body);
    assertCanGrant(input.grants);
    return this.db.tenant(async (tx) => {
      const role = await this.editable(tx, id);
      if (input.name !== role.name) await this.assertNameFree(tx, input.name, id);
      const old = role.permissions.map((p) => ({ key: p.permission.key, scope: p.scope, isDeny: p.isDeny }));
      await tx.role.update({ where: { id }, data: { name: input.name } });
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await this.writeGrants(tx, id, input.grants);
      if (input.name !== role.name) {
        // Keep the "2FA required for roles" policy pointing at the renamed role.
        const s = await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() } });
        if (s?.require2faRoles.includes(role.name)) {
          await tx.organizationSetting.update({
            where: { tenantId: tenantId() },
            data: { require2faRoles: s.require2faRoles.map((n) => (n === role.name ? input.name : n)) },
          });
        }
      }
      await this.db.audit(tx, {
        entity: 'role', entityId: id, action: 'role.updated',
        oldValue: { name: role.name, grants: old }, newValue: input,
      });
      return { id };
    });
  }

  @Post('roles/:id/clone')
  @RequirePermission('org.role.manage', 'ORGANIZATION')
  clone(@Param('id') id: string, @Body() body: unknown) {
    const { name } = parse(CloneBody, body);
    return this.db.tenant(async (tx) => {
      const src = await tx.role.findUnique({ where: { id }, include: { permissions: { include: { permission: true } } } });
      if (!src) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
      const grants = src.permissions.map((p) => ({ key: p.permission.key, scope: p.scope, isDeny: p.isDeny }));
      assertCanGrant(grants);
      await this.assertNameFree(tx, name);
      const role = await tx.role.create({ data: { tenantId: tenantId(), name } });
      await this.writeGrants(tx, role.id, grants);
      await this.db.audit(tx, { entity: 'role', entityId: role.id, action: 'role.cloned', newValue: { from: src.name, name } });
      return { id: role.id };
    });
  }

  @Delete('roles/:id')
  @RequirePermission('org.role.manage', 'ORGANIZATION')
  remove(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const role = await this.editable(tx, id);
      const inUse = await tx.userRole.count({ where: { roleId: id } });
      if (inUse) throw new ConflictException({ code: 'ROLE_IN_USE', message: `This role is assigned to ${inUse} user(s). Remove it from them first.` });
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.fieldRule.deleteMany({ where: { roleId: id } });
      await tx.role.delete({ where: { id } });
      await this.db.audit(tx, { entity: 'role', entityId: id, action: 'role.deleted', oldValue: { name: role.name } });
      return { ok: true };
    });
  }

  private async editable(tx: Tx, id: string) {
    const role = await tx.role.findUnique({ where: { id }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
    if (role.name === ADMIN_ROLE) {
      throw new ForbiddenException({ code: 'ROLE_PROTECTED', message: `${ADMIN_ROLE} always has full access and cannot be changed` });
    }
    return role;
  }

  private async assertNameFree(tx: Tx, name: string, exceptId?: string) {
    if (name.toLowerCase() === ADMIN_ROLE.toLowerCase()) {
      throw new BadRequestException({ code: 'ROLE_NAME_RESERVED', message: `"${ADMIN_ROLE}" is a reserved name` });
    }
    const clash = await tx.role.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw new ConflictException({ code: 'ROLE_NAME_TAKEN', message: 'A role with this name already exists' });
  }

  private async writeGrants(tx: Tx, roleId: string, grants: z.infer<typeof Grant>[]) {
    const keys = [...new Set(grants.map((g) => g.key))];
    if (keys.length !== grants.length) throw new BadRequestException({ code: 'DUPLICATE_PERMISSION', message: 'Each permission can appear only once' });
    const perms = await tx.permission.findMany({ where: { key: { in: keys } } });
    const id = new Map(perms.map((p) => [p.key, p.id]));
    await tx.rolePermission.createMany({
      data: grants.map((g) => ({ roleId, permissionId: id.get(g.key)!, scope: g.scope, isDeny: g.isDeny ?? false })),
    });
  }
}
