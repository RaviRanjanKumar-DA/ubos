import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

/**
 * Runs `fn` in a transaction where PostgreSQL row-level security sees only `tenantId`.
 * Must be used with the ubos_app connection: every tenant-table query outside this helper returns no rows.
 */
export async function withTenant<T>(client: PrismaClient, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error('withTenant: tenantId is required');
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
