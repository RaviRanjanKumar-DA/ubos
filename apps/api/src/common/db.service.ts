import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { appendAudit, AuditEntry, PrismaClient, Tx, withTenant } from '@ubos/database';
import { ctx, tenantId } from './context';

/**
 * Two connections, two database roles:
 *  - app:      ubos_app, row-level security on; every tenant query must go through `tenant()`.
 *  - platform: ubos_platform, bypasses RLS; used only by the Platform Console API.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly app = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL });
  readonly platform = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL });

  /** Runs `fn` inside a transaction scoped to the current request's tenant. */
  tenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.app, tenantId(), fn);
  }

  /** Audit helper that fills actor, IP and workspace from the request context. */
  audit(tx: Tx, e: Omit<AuditEntry, 'tenantId' | 'actorType' | 'actorId' | 'ip'> & Partial<AuditEntry>) {
    const c = ctx();
    return appendAudit(tx, {
      tenantId: c.tenant?.id ?? null,
      actorType: c.auth ? 'tenant_user' : c.platformUserId ? 'platform_user' : 'system',
      actorId: c.auth?.userId ?? c.platformUserId ?? null,
      ip: c.ip,
      workspaceId: c.auth?.workspaceId ?? null,
      ...e,
    });
  }

  async onModuleDestroy() {
    await Promise.all([this.app.$disconnect(), this.platform.$disconnect()]);
  }
}
