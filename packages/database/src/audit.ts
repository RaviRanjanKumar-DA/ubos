import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import type { Tx } from './tenant-context';

export interface AuditEntry {
  tenantId: string | null;
  workspaceId?: string | null;
  actorType: 'tenant_user' | 'platform_user' | 'system' | 'api_key';
  actorId?: string | null;
  ip?: string | null;
  entity: string;
  entityId: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}

/** JSON with object keys sorted recursively, so values hash the same after a jsonb round-trip. */
function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface AuditHashInput {
  prevHash: string | null;
  tenantId: string | null;
  workspaceId: string | null;
  actorType: string;
  actorId: string | null;
  entity: string;
  entityId: string;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  createdAt: Date;
}

/** Hash of one audit row; used both when writing and when verifying the chain. */
export function computeAuditHash(r: AuditHashInput): string {
  const payload = canonical([
    r.prevHash, r.tenantId, r.workspaceId, r.actorType, r.actorId, r.entity, r.entityId, r.action,
    r.oldValue ?? null, r.newValue ?? null, r.createdAt.toISOString(),
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Appends a hash-chained audit row (who / when / what / old value / new value).
 * Each row's hash covers the previous row's hash for the same tenant, so any later edit breaks the chain.
 * The table itself rejects UPDATE/DELETE (database trigger).
 */
export async function appendAudit(tx: Tx, e: AuditEntry) {
  // Serialise writers per tenant so the chain stays linear.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'audit:' + (e.tenantId ?? 'platform')}))`;
  const prev = await tx.auditLog.findFirst({
    where: { tenantId: e.tenantId },
    orderBy: { id: 'desc' },
    select: { hash: true },
  });
  const createdAt = new Date();
  const hash = computeAuditHash({
    prevHash: prev?.hash ?? null, tenantId: e.tenantId, workspaceId: e.workspaceId ?? null,
    actorType: e.actorType, actorId: e.actorId ?? null, entity: e.entity, entityId: e.entityId,
    action: e.action, oldValue: e.oldValue, newValue: e.newValue, createdAt,
  });
  const json = (v: unknown) => (v === undefined || v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));
  return tx.auditLog.create({
    data: {
      tenantId: e.tenantId,
      workspaceId: e.workspaceId ?? null,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      ip: e.ip ?? null,
      entity: e.entity,
      entityId: e.entityId,
      action: e.action,
      oldValue: json(e.oldValue),
      newValue: json(e.newValue),
      reason: e.reason ?? null,
      prevHash: prev?.hash ?? null,
      hash,
      createdAt,
    },
  });
}
