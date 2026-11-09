import type { Tx } from '@ubos/database';
import type { WebhookEvent } from '@ubos/shared';
import { contextStore } from './context';

const MAX_RULE_CHAIN = 3;

/**
 * Queues what should happen because of this event: an outgoing webhook per subscription, and an event for automation
 * rules. Written in the same transaction as the change, so a rolled-back change never notifies anyone or fires a rule;
 * the WebhookDispatcher and the automation worker pick them up right after.
 */
export async function emitEvent(tx: Tx, tenantId: string, workspaceId: string | null, event: WebhookEvent, data: Record<string, unknown>) {
  const depth = contextStore.getStore()?.automationDepth ?? 0;
  const scored = event.startsWith('lead.') && !!workspaceId && (await tx.scoreRule.count({ where: { workspaceId, isActive: true, isArchived: false } })) > 0;
  if (depth < MAX_RULE_CHAIN && (scored || (await tx.automationRule.count({ where: { trigger: event, isActive: true, isArchived: false } })))) {
    await tx.automationEvent.create({ data: { tenantId, workspaceId, event, data: JSON.parse(JSON.stringify(data)), depth } });
  }
  const subs = await tx.webhookSubscription.findMany({
    where: { isActive: true, events: { has: event }, ...(workspaceId ? { OR: [{ workspaceId: null }, { workspaceId }] } : { workspaceId: null }) },
    select: { id: true },
  });
  if (!subs.length) return 0;
  const payload = { event, occurredAt: new Date().toISOString(), workspaceId, data };
  await tx.webhookDelivery.createMany({ data: subs.map((s) => ({ tenantId, subscriptionId: s.id, event, payload: payload as object })) });
  return subs.length;
}
