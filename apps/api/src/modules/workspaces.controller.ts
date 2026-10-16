import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { createWorkspace } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';

const CreateWorkspace = z.object({
  name: z.string().trim().min(2).max(60),
  template: z.string().max(40).optional(),
  pipelines: z.array(z.object({ name: z.string().trim().min(2).max(60) })).max(10).optional(),
});

@Controller('api/v1/workspaces')
export class WorkspacesController {
  constructor(private db: DbService) {}

  @Get()
  @RequirePermission('org.workspace.view')
  list() {
    const a = auth();
    return this.db.tenant(async (tx) => {
      const workspaces = await tx.workspace.findMany({
        where: { id: { in: a.accessibleWorkspaceIds }, isArchived: false },
        orderBy: { name: 'asc' },
        include: { pipelines: { include: { stages: { orderBy: { position: 'asc' } } } } },
      });
      const counts = await tx.lead.groupBy({ by: ['workspaceId'], _count: true, where: { workspaceId: { in: a.accessibleWorkspaceIds } } });
      const byWs = new Map(counts.map((c) => [c.workspaceId, c._count]));
      return workspaces.map((w) => ({ ...w, leadCount: byWs.get(w.id) ?? 0 }));
    });
  }

  /** Creates a business line. Needs organization-wide manage permission and room in the plan. */
  @Post()
  @RequirePermission('org.workspace.manage', 'ORGANIZATION')
  create(@Body() body: unknown) {
    const input = parse(CreateWorkspace, body);
    return this.db.tenant(async (tx) => {
      const sub = await tx.subscription.findFirst({ include: { plan: true }, orderBy: { currentPeriodEnd: 'desc' } });
      const used = await tx.workspace.count({ where: { isArchived: false } });
      const max = sub?.plan.maxWorkspaces;
      if (max !== null && max !== undefined && used >= max) {
        throw new ForbiddenException({
          code: 'PLAN_LIMIT_REACHED',
          message: `Your ${sub!.plan.name} plan allows ${max} workspace(s). Upgrade to add more business lines.`,
        });
      }
      const ws = await createWorkspace(tx, tenantId(), input);
      await this.db.audit(tx, { entity: 'workspace', entityId: ws.id, action: 'workspace.created', newValue: input });
      return ws;
    });
  }
}
