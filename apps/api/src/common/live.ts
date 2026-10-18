import { EventEmitter } from 'events';

/**
 * Live updates for open browsers (server-sent events). Events carry ids only; each browser re-reads what changed
 * through the normal API, so permissions and field rules always apply. In-memory for one API instance; Redis pub/sub
 * replaces it when UBOS runs on several servers.
 */
export interface LiveEvent { type: 'call.logged' | 'call.updated' | 'dial.requested' | 'lead.created'; leadId?: string | null; userId?: string | null; callId?: string }

const bus = new EventEmitter();
bus.setMaxListeners(0);

export const live = {
  publish(tenantId: string, e: LiveEvent) { bus.emit(tenantId, e); },
  subscribe(tenantId: string, fn: (e: LiveEvent) => void) {
    bus.on(tenantId, fn);
    return () => bus.off(tenantId, fn);
  },
};
