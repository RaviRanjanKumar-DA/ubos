import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { tenantId } from '../common/context';
import { parse } from '../common/errors';

const Name = z.object({ name: z.string().trim().min(2).max(60) });
const NewDepartment = Name.extend({ branchId: z.string().uuid() });
const NewTeam = Name.extend({ departmentId: z.string().uuid(), workspaceId: z.string().uuid().nullable().optional() });
const EditTeam = z.object({ name: z.string().trim().min(2).max(60).optional(), workspaceId: z.string().uuid().nullable().optional() });

/** Branches → Departments → Teams. Used for TEAM / DEPARTMENT / BRANCH data scopes and reporting. */
@Controller('api/v1/org')
export class OrgController {
  constructor(private db: DbService) {}

  @Get('structure')
  @RequirePermission('org.user.view')
  structure() {
    return this.db.tenant(async (tx) => {
      const branches = await tx.branch.findMany({
        orderBy: { name: 'asc' },
        include: {
          departments: {
            orderBy: { name: 'asc' },
            include: { teams: { orderBy: { name: 'asc' }, include: { _count: { select: { members: true } } } } },
          },
        },
      });
      const unassigned = await tx.user.count({ where: { teamId: null, isActive: true } });
      return {
        unassignedUsers: unassigned,
        branches: branches.map((b) => ({
          id: b.id, name: b.name,
          departments: b.departments.map((d) => ({
            id: d.id, name: d.name,
            teams: d.teams.map((t) => ({ id: t.id, name: t.name, workspaceId: t.workspaceId, members: t._count.members })),
          })),
        })),
      };
    });
  }

  @Post('branches')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  createBranch(@Body() body: unknown) {
    const { name } = parse(Name, body);
    return this.db.tenant(async (tx) => {
      const b = await tx.branch.create({ data: { tenantId: tenantId(), name } });
      await this.db.audit(tx, { entity: 'branch', entityId: b.id, action: 'org.branch_created', newValue: { name } });
      return { id: b.id };
    });
  }

  @Patch('branches/:id')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  renameBranch(@Param('id') id: string, @Body() body: unknown) {
    const { name } = parse(Name, body);
    return this.db.tenant(async (tx) => {
      const old = await tx.branch.findUnique({ where: { id } });
      if (!old) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found' });
      await tx.branch.update({ where: { id }, data: { name } });
      await this.db.audit(tx, { entity: 'branch', entityId: id, action: 'org.branch_renamed', oldValue: { name: old.name }, newValue: { name } });
      return { id };
    });
  }

  @Delete('branches/:id')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  deleteBranch(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const b = await tx.branch.findUnique({ where: { id }, include: { _count: { select: { departments: true } } } });
      if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found' });
      if (b._count.departments) throw new ConflictException({ code: 'NOT_EMPTY', message: 'Remove its departments first' });
      await tx.branch.delete({ where: { id } });
      await this.db.audit(tx, { entity: 'branch', entityId: id, action: 'org.branch_deleted', oldValue: { name: b.name } });
      return { ok: true };
    });
  }

  @Post('departments')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  createDepartment(@Body() body: unknown) {
    const { name, branchId } = parse(NewDepartment, body);
    return this.db.tenant(async (tx) => {
      if (!(await tx.branch.findUnique({ where: { id: branchId } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found' });
      const d = await tx.department.create({ data: { tenantId: tenantId(), branchId, name } });
      await this.db.audit(tx, { entity: 'department', entityId: d.id, action: 'org.department_created', newValue: { name, branchId } });
      return { id: d.id };
    });
  }

  @Patch('departments/:id')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  renameDepartment(@Param('id') id: string, @Body() body: unknown) {
    const { name } = parse(Name, body);
    return this.db.tenant(async (tx) => {
      const old = await tx.department.findUnique({ where: { id } });
      if (!old) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Department not found' });
      await tx.department.update({ where: { id }, data: { name } });
      await this.db.audit(tx, { entity: 'department', entityId: id, action: 'org.department_renamed', oldValue: { name: old.name }, newValue: { name } });
      return { id };
    });
  }

  @Delete('departments/:id')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  deleteDepartment(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const d = await tx.department.findUnique({ where: { id }, include: { _count: { select: { teams: true } } } });
      if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Department not found' });
      if (d._count.teams) throw new ConflictException({ code: 'NOT_EMPTY', message: 'Remove its teams first' });
      await tx.department.delete({ where: { id } });
      await this.db.audit(tx, { entity: 'department', entityId: id, action: 'org.department_deleted', oldValue: { name: d.name } });
      return { ok: true };
    });
  }

  @Post('teams')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  createTeam(@Body() body: unknown) {
    const { name, departmentId, workspaceId } = parse(NewTeam, body);
    return this.db.tenant(async (tx) => {
      if (!(await tx.department.findUnique({ where: { id: departmentId } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Department not found' });
      if (workspaceId && !(await tx.workspace.findUnique({ where: { id: workspaceId } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Workspace not found' });
      const t = await tx.team.create({ data: { tenantId: tenantId(), departmentId, name, workspaceId: workspaceId ?? null } });
      await this.db.audit(tx, { entity: 'team', entityId: t.id, action: 'org.team_created', newValue: { name, departmentId, workspaceId } });
      return { id: t.id };
    });
  }

  @Patch('teams/:id')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  editTeam(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(EditTeam, body);
    return this.db.tenant(async (tx) => {
      const old = await tx.team.findUnique({ where: { id } });
      if (!old) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Team not found' });
      if (input.workspaceId && !(await tx.workspace.findUnique({ where: { id: input.workspaceId } }))) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      await tx.team.update({ where: { id }, data: input });
      await this.db.audit(tx, { entity: 'team', entityId: id, action: 'org.team_updated', oldValue: { name: old.name, workspaceId: old.workspaceId }, newValue: input });
      return { id };
    });
  }

  @Delete('teams/:id')
  @RequirePermission('org.structure.manage', 'ORGANIZATION')
  deleteTeam(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const t = await tx.team.findUnique({ where: { id }, include: { _count: { select: { members: true } } } });
      if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Team not found' });
      if (t._count.members) throw new ConflictException({ code: 'NOT_EMPTY', message: `Move its ${t._count.members} member(s) to another team first` });
      await tx.team.delete({ where: { id } });
      await this.db.audit(tx, { entity: 'team', entityId: id, action: 'org.team_deleted', oldValue: { name: t.name } });
      return { ok: true };
    });
  }
}
