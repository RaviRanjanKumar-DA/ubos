'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface Event { id: string; receivedAt: string; status: string; outcome: string | null; leadId: string | null; error: string | null; externalId: string | null; attempts: number; body: string }

const TONE: Record<string, string> = { processed: 'ok', duplicate: 'grey', skipped: 'grey', failed: 'bad', received: 'warn' };
const OUTCOME: Record<string, string> = {
  created: 'New lead', linked: 'New lead (known customer)', add_remark: 'Added to open lead', update_blank: 'Filled empty fields', overwrite: 'Updated lead', skip: 'Skipped (open lead)', rejected: 'Rejected',
};

/** What came in from an integration recently, what UBOS did with it, and replay for failed records. */
export function IntegrationEvents({ integrationKey, canManage }: { integrationKey: string; canManage: boolean }) {
  const [data, setData] = useState<{ last7Days: Record<string, number>; items: Event[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ last7Days: Record<string, number>; items: Event[] }>(`/api/v1/integrations/${integrationKey}/events`, { noWorkspace: true }).then(setData).catch(() => setData(null)), [integrationKey]);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<string>) {
    setBusy(true); setMsg(null);
    try { setMsg({ type: 'notice', text: await fn() }); await load(); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">Last 7 days: {data ? Object.entries(data.last7Days).map(([k, v]) => `${v} ${k}`).join(' · ') || 'nothing yet' : '…'}</span>
        <span className="row" style={{ gap: 6 }}>
          {integrationKey === 'google_sheets' && canManage && (
            <button className="btn sm" disabled={busy} onClick={() => run(async () => {
              const r = await api<{ rows: number; created: number; linked: number; updated: number; skipped: number; failed: number; seen: number }>('/api/v1/integrations/google_sheets/sync', { method: 'POST', noWorkspace: true });
              return `Read ${r.rows} row(s): ${r.created + r.linked} new lead(s), ${r.updated} added to open leads, ${r.failed} with problems, ${r.seen} already read before.`;
            })}>⟳ Sync now</button>
          )}
          <button className="btn sm ghost" onClick={load}>Refresh</button>
        </span>
      </div>
      {msg && <div className={msg.type} style={{ marginTop: 8 }}>{msg.text}</div>}
      {data && !data.items.length && <p className="small muted">Nothing received yet. Send a test from the other service — each record shows here with what UBOS did with it.</p>}
      {data?.items.map((e) => (
        <div key={e.id} className="event-row">
          <button className="event-head" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
            <span className={`badge ${TONE[e.status] ?? 'grey'}`}>{e.status}</span>
            <span className="small">{e.outcome ? OUTCOME[e.outcome] ?? e.outcome : ''}</span>
            {e.error && <span className="small event-err" style={{ color: 'var(--bad)' }} title={e.error}>{e.error}</span>}
            <span className="small muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{new Date(e.receivedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}</span>
          </button>
          {open === e.id && (
            <div className="event-body">
              <pre>{(() => { try { return JSON.stringify(JSON.parse(e.body), null, 2); } catch { return e.body; } })()}</pre>
              <div className="row" style={{ gap: 6 }}>
                {e.externalId && <span className="small muted">Sender id: {e.externalId.length > 40 ? `${e.externalId.slice(0, 12)}…` : e.externalId}</span>}
                {e.leadId && <Link className="btn sm ghost" href={`/app/leads/${e.leadId}`}>Open lead</Link>}
                {canManage && e.status === 'failed' && <button className="btn sm outline" disabled={busy} onClick={() => run(async () => {
                  const r = await api<{ outcome: string; errors: string[] }>(`/api/v1/integrations/${integrationKey}/events/${e.id}/replay`, { method: 'POST', noWorkspace: true });
                  return r.outcome === 'rejected' ? `Still rejected: ${r.errors.join('; ')}` : `Done — ${OUTCOME[r.outcome] ?? r.outcome}.`;
                })}>↻ Process again</button>}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
