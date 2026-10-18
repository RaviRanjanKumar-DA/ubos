'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { relTime } from '@/lib/workspace';

interface Notice { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }
const ICON: Record<string, string> = { mention: '@', reminder: '⏰', assignment: '👤', digest: '☀' };

/** Notification bell: mentions, reminders, assignments and the daily summary. Checks every minute. */
export function Bell({ version }: { version: number }) {
  const router = useRouter();
  const [data, setData] = useState<{ unread: number; items: Notice[] } | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api<{ unread: number; items: Notice[] }>('/api/v1/notifications').then(setData).catch(() => undefined), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load, version]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function openItem(n: Notice) {
    if (!n.readAt) await api('/api/v1/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => undefined);
    setOpen(false);
    load();
    if (n.link) router.push(n.link);
  }

  return (
    <div className="bell" ref={box}>
      <button className="btn ghost sm" aria-label={`Notifications${data?.unread ? ` (${data.unread} unread)` : ''}`} onClick={() => setOpen(!open)}>
        <span aria-hidden="true" style={{ fontSize: 17 }}>🔔</span>
        {!!data?.unread && <span className="bell-count">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="card bell-panel">
          <div className="row" style={{ justifyContent: 'space-between', padding: '4px 4px 8px' }}>
            <b>Notifications</b>
            {!!data?.unread && <button className="btn sm ghost" onClick={() => api('/api/v1/notifications/read', { method: 'POST', body: { all: true } }).then(load)}>Mark all read</button>}
          </div>
          {!data?.items.length && <div className="small muted" style={{ padding: 10 }}>Nothing yet. Mentions, reminders and new tasks show up here.</div>}
          {data?.items.map((n) => (
            <button key={n.id} className={`bell-item ${n.readAt ? '' : 'unread'}`} onClick={() => openItem(n)}>
              <span className="bell-icon" aria-hidden="true">{ICON[n.type] ?? '•'}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="bell-title">{n.title}</span>
                {n.body && <span className="small muted bell-body">{n.body.length > 90 ? `${n.body.slice(0, 90)}…` : n.body}</span>}
                <span className="small muted">{relTime(n.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
