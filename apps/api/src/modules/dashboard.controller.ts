import { Controller, Get } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { auth } from '../common/context';
import { scopeFilter } from '../common/scope';

@Controller('api/v1/dashboard')
export class DashboardController {
  constructor(private db: DbService) {}

  /** Lead KPIs within the user's scope, for the selected workspace or the whole organization. */
  @Get()
  @RequirePermission('dashboard.view')
  summary() {
    const a = auth();
    return this.db.tenant(async (tx) => {
      // Dashboard follows lead visibility; users without lead access get empty tiles.
      const where = a.permissions['crm.lead.view'] ? await scopeFilter(tx, 'crm.lead.view') : { id: '__none__' };
      const [total, byStage, bySource, byWorkspace, stages, workspaces] = await Promise.all([
        tx.lead.count({ where }),
        tx.lead.groupBy({ by: ['stageId'], _count: true, where }),
        tx.lead.groupBy({ by: ['source'], _count: true, where }),
        tx.lead.groupBy({ by: ['workspaceId'], _count: true, where }),
        tx.leadStage.findMany(),
        tx.workspace.findMany({ select: { id: true, name: true } }),
      ]);
      const stage = new Map(stages.map((s) => [s.id, s]));
      const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
      const stageTotals = new Map<string, number>();
      let won = 0;
      for (const s of byStage) {
        const st = stage.get(s.stageId);
        if (st?.isWon) won += s._count;
        stageTotals.set(st?.name ?? '?', (stageTotals.get(st?.name ?? '?') ?? 0) + s._count);
      }
      return {
        view: a.workspaceId ? 'workspace' : 'organization',
        totalLeads: total,
        wonLeads: won,
        conversionRate: total ? Math.round((won / total) * 1000) / 10 : 0,
        byStage: [...stageTotals].map(([name, count]) => ({ name, count })),
        bySource: bySource.map((s) => ({ name: s.source, count: s._count })).sort((x, y) => y.count - x.count),
        byWorkspace: byWorkspace.map((w) => ({ name: wsName.get(w.workspaceId) ?? '?', count: w._count })),
      };
    });
  }
}
