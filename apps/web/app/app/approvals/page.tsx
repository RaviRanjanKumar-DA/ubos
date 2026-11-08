'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Approval { id: string; kind: string; title: string; status: string; leadId: string | null; customerName: string | null; requestedByName: string | null; decidedByName: string | null; decisionNote: string | null; createdAt: string; isMine: boolean }

/** Quote discounts and process sign-offs waiting for a decision. */
export default function ApprovalsPage() {
  const { version } = useShell();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const [data, setData] = useState<{ canDecide: boolean; items: Approval[] } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(() => api<{ canDecide: boolean; items: Approval[] }>(`/api/v1/approvals?status=${status}`).then(setData).catch(() => setData(null)), [status]);
  useEffect(() => { load(); }, [load, version]);
  const decide = async (a: Approval, decision: 'approve' | 'reject') => {
    setMsg(null);
    try { await api(`/api/v1/approvals/${a.id}/decide`, { method: 'POST', body: { decision, note: notes[a.id] || null } }); setMsg({ type: 'notice', text: decision === 'approve' ? 'Approved.' : 'Rejected.' }); load(); }
    catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  };
  return (
    <>
      <div className="page-head">
        <div><h1>Approvals</h1><p className="muted small" style={{ margin: 0 }}>Discounts beyond the limit and process steps that need sign-off.</p></div>
        <select className="input" style={{ maxWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value as 'pending' | 'all')} aria-label="Status"><option value="pending">Waiting</option><option value="all">All</option></select>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="card">
        {!data?.items.length ? <p className="small muted" style={{ margin: 0 }}>Nothing waiting.</p> : data.items.map((a) => (
          <div key={a.id} className="run-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <b>{a.title}</b> <span className={`badge ${a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'bad' : a.status === 'pending' ? 'warn' : 'grey'}`}>{a.status}</span>
                <div className="small muted">{a.kind === 'quote_discount' ? 'Quote discount' : 'Process sign-off'} · {a.customerName ?? ''} · asked by {a.requestedByName} · {new Date(a.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}
                  {a.decidedByName ? ` · ${a.status} by ${a.decidedByName}${a.decisionNote ? `: ${a.decisionNote}` : ''}` : ''}</div>
                {a.leadId && <Link className="small" href={`/app/leads/${a.leadId}?tab=${a.kind === 'quote_discount' ? 'quotes' : 'process'}`}>Open the lead →</Link>}
              </div>
              {data.canDecide && a.status === 'pending' && (
                <div className="row" style={{ gap: 6 }}>
                  <input className="input" style={{ width: 220 }} placeholder="Note (needed to reject)" value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                  <button className="btn sm ghost" onClick={() => decide(a, 'reject')}>Reject</button>
                  <button className="btn sm" onClick={() => decide(a, 'approve')}>Approve</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
