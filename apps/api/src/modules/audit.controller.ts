import { Controller, Get } from '@nestjs/common';
import { computeAuditHash } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';

@Controller('api/v1/audit-logs')
export class AuditController {
  constructor(private db: DbService) {}

  @Get()
  @RequirePermission('audit.view')
  async list() {
    return this.db.tenant(async (tx) => {
      const logs = await tx.auditLog.findMany({ orderBy: { id: 'desc' }, take: 200 });
      const actorIds = [...new Set(logs.map((l) => l.actorId).filter(Boolean) as string[])];
      const users = await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
      const name = new Map(users.map((u) => [u.id, u.name]));
      return logs.map((l) => ({
        id: l.id.toString(), action: l.action, entity: l.entity, entityId: l.entityId,
        actor: l.actorId ? name.get(l.actorId) ?? l.actorType : l.actorType, ip: l.ip,
        oldValue: l.oldValue, newValue: l.newValue, createdAt: l.createdAt,
      }));
    });
  }

  /** Recomputes the hash chain for this organization; any edited or removed row breaks it. */
  @Get('verify')
  @RequirePermission('audit.view')
  verify() {
    return this.db.tenant(async (tx) => {
      const logs = await tx.auditLog.findMany({ orderBy: { id: 'asc' } });
      let prev: string | null = null;
      for (const l of logs) {
        const hash = computeAuditHash({ ...l, prevHash: prev });
        if (l.prevHash !== prev || l.hash !== hash) return { valid: false, brokenAt: l.id.toString(), checked: logs.length };
        prev = l.hash;
      }
      return { valid: true, checked: logs.length };
    });
  }
}
