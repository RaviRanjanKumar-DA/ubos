import type { Tx } from '@ubos/database';
import { auth, tenantId } from './context';

/** Creates in-app notifications for active users of this organization (never for the person acting). */
export async function notify(tx: Tx, userIds: string[], n: { type: string; title: string; body?: string | null; link?: string | null }) {
  const me = (() => { try { return auth().userId; } catch { return null; } })();
  const ids = [...new Set(userIds)].filter((id) => id && id !== me);
  if (!ids.length) return [];
  const users = await tx.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
  if (!users.length) return [];
  await tx.notification.createMany({ data: users.map((u) => ({ tenantId: tenantId(), userId: u.id, type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null })) });
  return users.map((u) => u.id);
}

/** Mentioned people must be active users of this organization. */
export async function validMentions(tx: Tx, ids: string[] | undefined) {
  if (!ids?.length) return [];
  const users = await tx.user.findMany({ where: { id: { in: [...new Set(ids)] }, isActive: true }, select: { id: true } });
  return users.map((u) => u.id);
}
