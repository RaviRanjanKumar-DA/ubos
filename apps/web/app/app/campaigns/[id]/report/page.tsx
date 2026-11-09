'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, API_URL, session } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { dur } from '@/components/calls/Player';

interface Report {
  name: string; status: string; maxAttempts: number; retryAfterMin: number;
  totals: { leads: number; pending: number; active: number; done: number; closed: number; calls: number; connected: number; talkSec: number; connectRate: number };
  byAgent: { userId: string | null; name: string; calls: number; connected: number; talkSec: number }[];
  byOutcome: { value: string; label: string; count: number }[];
  open: { id: string; customerName: string; agentName: string; claimedAt: string | null; dialedAt: string | null }[];
}
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Results of one campaign: progress, connection rate, each caller's numbers, outcomes and calls left open. */
export default function CampaignReport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can, version } = useShell();
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api<Report>(`/api/v1/call-campaigns/${id}/report`).then(setR).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load the report')), [id]);
  useEffect(() => { load(); }, [load, version]);

  const release = async (itemId: string) => {
    if (!confirm('Put this lead back in the queue? The caller will not need to save an outcome.')) return;
    try { await api(`/api/v1/call-campaigns/items/${itemId}/release`, { method: 'POST' }); load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  };
  const download = async () => {
    const s = session.get();
    const res = await fetch(`${API_URL}/api/v1/call-campaigns/${id}/export`, { credentials: 'include', headers: { ...(s?.tenant ? { 'X-Tenant': s.tenant } : {}), ...(s?.workspaceId ? { 'X-Workspace': s.workspaceId } : {}) } });
    if (!res.ok) { setErr('Could not export this list'); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `${r?.name ?? 'campaign'}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (!r) return <><div className="page-head"><h1>Campaign report</h1></div><div className={err ? 'error' : 'card muted'}>{err || 'Loading…'}</div></>;
  const t = r.totals;
  const KPIS: [string, string][] = [['Leads finished', `${t.done + t.closed} of ${t.leads}`], ['Calls made', String(t.calls)], ['Connected', `${t.connected} (${t.connectRate}%)`], ['Talk time', dur(t.talkSec)]];
  return (
    <>
      <div className="page-head">
        <div><h1>{r.name}</h1><p className="muted small page-note"><Link href="/app/campaigns">Back to campaigns</Link> · {t.pending} waiting · up to {r.maxAttempts} tries, {r.retryAfterMin} minutes apart</p></div>
        {can('crm.lead.export') && <button className="btn outline" onClick={download}>Export CSV</button>}
      </div>
      {err && <div className="error">{err}</div>}
      <div className="camp-kpis">{KPIS.map(([l, v]) => <div className="card kpi" key={l}><div className="label">{l}</div><div className="value">{v}</div></div>)}</div>
      <div className="camp-report">
        <div className="card">
          <h2 className="form-head">By caller</h2>
          {!r.byAgent.length ? <p className="small muted">No calls yet.</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Caller</th><th>Calls</th><th>Connected</th><th>Rate</th><th>Talk time</th></tr></thead>
              <tbody>{r.byAgent.map((a) => <tr key={a.userId ?? a.name}><td><b>{a.name}</b></td><td>{a.calls}</td><td>{a.connected}</td><td>{a.calls ? Math.round((a.connected / a.calls) * 100) : 0}%</td><td>{dur(a.talkSec)}</td></tr>)}</tbody>
            </table></div>
          )}
        </div>
        <div className="card">
          <h2 className="form-head">Outcomes</h2>
          {!r.byOutcome.length ? <p className="small muted">No outcomes yet.</p> : (
            <ul className="camp-bars">
              {r.byOutcome.map((o) => <li key={o.value}><span className="small">{o.label}</span><span className="small muted">{o.count}</span><div className="progress"><span style={{ width: `${Math.round((o.count / t.calls) * 100)}%` }} /></div></li>)}
            </ul>
          )}
        </div>
      </div>
      {r.open.length > 0 && (
        <div className="card">
          <h2 className="form-head">Open calls</h2>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Lead</th><th>Caller</th><th>Opened</th><th>Dialed</th><th /></tr></thead>
            <tbody>{r.open.map((o) => <tr key={o.id}><td><b>{o.customerName}</b></td><td>{o.agentName}</td><td className="small">{when(o.claimedAt)}</td><td className="small">{when(o.dialedAt)}</td><td><button className="btn sm ghost" onClick={() => release(o.id)}>Release</button></td></tr>)}</tbody>
          </table></div>
        </div>
      )}
    </>
  );
}
