import type { Tx } from '@ubos/database';
import type { WebhookEvent } from '@ubos/shared';

/**
 * Queues an outgoing webhook for every active subscription to this event (and business line).
 * Written in the same transaction as the change, so a rolled-back change never notifies anyone;
 * the WebhookDispatcher sends the queued deliveries right after.
 */
export async function emitEvent(tx: Tx, tenantId: string, workspaceId: string | null, event: WebhookEvent, data: Record<string, unknown>) {
  const subs = await tx.webhookSubscription.findMany({
    where: { isActive: true, events: { has: event }, ...(workspaceId ? { OR: [{ workspaceId: null }, { workspaceId }] } : { workspaceId: null }) },
    select: { id: true },
  });
  if (!subs.length) return 0;
  const payload = { event, occurredAt: new Date().toISOString(), workspaceId, data };
  await tx.webhookDelivery.createMany({ data: subs.map((s) => ({ tenantId, subscriptionId: s.id, event, payload: payload as object })) });
  return subs.length;
}
