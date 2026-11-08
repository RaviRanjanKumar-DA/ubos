'use client';

import { useEffect, useRef } from 'react';
import { API_URL, session } from './api';

export interface LiveEvent { type: string; leadId?: string | null; userId?: string | null; callId?: string; conversationId?: string }

/**
 * Live updates from the API (server-sent events). One shared connection per tab; pages get ids only and re-read
 * through the normal API, so everyone keeps seeing just what they are allowed to see.
 */
let source: EventSource | null = null;
const handlers = new Set<(e: LiveEvent) => void>();
const TYPES = ['call.logged', 'call.updated', 'dial.requested', 'lead.created', 'message.received', 'message.updated'];

function connect() {
  const t = session.get()?.tenant;
  if (source || !t || typeof EventSource === 'undefined') return;
  source = new EventSource(`${API_URL}/api/v1/stream?tenant=${encodeURIComponent(t)}`, { withCredentials: true });
  for (const type of TYPES) source.addEventListener(type, (m) => { try { const e = JSON.parse((m as MessageEvent).data) as LiveEvent; handlers.forEach((h) => h(e)); } catch { /* ignore */ } });
  source.onerror = () => { source?.close(); source = null; if (handlers.size) setTimeout(connect, 5_000); };
}

/** Calls `fn` for every live event while the component is mounted (debounce in the caller if needed). */
export function useLive(fn: (e: LiveEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (e: LiveEvent) => ref.current(e);
    handlers.add(h);
    connect();
    return () => { handlers.delete(h); if (!handlers.size) { source?.close(); source = null; } };
  }, []);
}

/** Fetches a call recording as a playable object URL (or the provider's link). */
export async function recordingUrl(callId: string, workspaceId?: string | null): Promise<string> {
  const t = session.get();
  const res = await fetch(`${API_URL}/api/v1/calls/${callId}/recording?as=json`, { credentials: 'include', headers: { 'X-Tenant': t?.tenant ?? '', ...((workspaceId ?? t?.workspaceId) ? { 'X-Workspace': (workspaceId ?? t?.workspaceId)! } : {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Recording not available');
  if (res.headers.get('content-type')?.includes('application/json')) return (await res.json()).url;
  return URL.createObjectURL(await res.blob());
}
