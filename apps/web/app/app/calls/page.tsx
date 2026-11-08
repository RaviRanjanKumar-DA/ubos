'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { istDay, istDayStart } from '@/lib/ist';
import { useShell } from '@/components/AppShell';
import { useLive } from '@/lib/live';
import { CHANNEL, dur, RecordingPlayer } from '@/components/calls/Player';

interface CallRow {
  id: string; channel: string; provider: string | null; direction: string; phone: string | null; startedAt: string; ringSec: number; talkSec: number; answered: boolean;
  disposition: string | null; dispositionLabel: string | null; remark: string | null; leadId: string | null; customerName: string | null; userId: string | null; userName: string | null;
  recording: string; canListen: boolean;
}
interface Device { id: string; userId: string; userName: string; name: string; platform: string; appVersion: string | null; lastSeenAt: string | null; lastSyncAt: string | null; pendingCalls: number; revokedAt: string | null; createdAt: string }
type Tab = 'log' | 'unmatched' | 'phones';
const RANGES: Record<string, () => { from?: string }> = {
  today: () => ({ from: istDayStart(istDay(new Date())).toISOString() }),
  '7d': () => ({ from: new Date(Date.now() - 7 * 86_400_000).toISOString() }),
  '30d': () => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
  all: () => ({}),
};
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Every call — phone app, cloud calling and calls logged by hand — with recordings, unmatched calls and paired phones. */
export default function CallsPage() {
  const { can, version } = useShell();
  const [tab, setTab] = useState<Tab>('log');
  const [rows, setRows] = useState<CallRow[] | null>(null);
  const [f, setF] = useState({ range: '7d', channel: '', direction: '', answered: '', userId: '' });
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [fresh, setFresh] = useState(0);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: tab === 'unmatched' ? 'unmatched' : 'all', ...RANGES[f.range](), ...(f.channel ? { channel: f.channel } : {}), ...(f.direction ? { direction: f.direction } : {}), ...(f.answered ? { answered: f.answered } : {}), ...(f.userId ? { userId: f.userId } : {}) });
    setRows(await api<CallRow[]>(`/api/v1/calls?${p}`).catch(() => []));
  }, [tab, f]);
  useEffect(() => { if (tab !== 'phones') load(); }, [load, tab, version]);
  useEffect(() => { api<{ id: string; name: string }[]>('/api/v1/users').then((u) => setPeople(u.map((x) => ({ id: x.id, name: x.name })))).catch(() => setPeople([])); }, []);
  // New calls appear by themselves (refresh at most every 2 seconds).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLive((e) => {
    if (!e.type.startsWith('call.') || tab === 'phones') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { load(); setFresh((n) => n + 1); }, 2000);
  });

  const totals = rows ? { n: rows.length, connected: rows.filter((r) => r.answered).length, talk: rows.reduce((s, r) => s + r.talkSec, 0) } : null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calls</h1>
          <p className="muted small" style={{ margin: 0 }}>Every call in one place — from the phone app (SIM), cloud calling and calls logged by hand. New calls appear here on their own.</p>
        </div>
        {fresh > 0 && <span className="badge ok" title="The list refreshed with new calls">● Live</span>}
      </div>
      <div className="dash-tabs" role="tablist">
        {([['log', 'Call log'], ['unmatched', 'Unknown numbers'], ['phones', 'Phones']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`dash-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {tab !== 'phones' && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <select className="input" style={{ maxWidth: 140 }} value={f.range} onChange={(e) => setF({ ...f, range: e.target.value })} aria-label="Period"><option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option></select>
            <select className="input" style={{ maxWidth: 160 }} value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} aria-label="Person"><option value="">Everyone I can see</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select className="input" style={{ maxWidth: 130 }} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} aria-label="Channel"><option value="">All channels</option><option value="sim">SIM (phone)</option><option value="cloud">Cloud</option><option value="manual">Logged by hand</option></select>
            <select className="input" style={{ maxWidth: 130 }} value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} aria-label="Direction"><option value="">In & out</option><option value="outbound">Outgoing</option><option value="inbound">Incoming</option></select>
            <select className="input" style={{ maxWidth: 140 }} value={f.answered} onChange={(e) => setF({ ...f, answered: e.target.value })} aria-label="Answered"><option value="">Answered or not</option><option value="true">Connected</option><option value="false">Not connected</option></select>
            {totals && <span className="small muted">{totals.n} call(s) · {totals.connected} connected · {dur(totals.talk)} talk time</span>}
          </div>
          <div className="card">
            {!rows ? <div className="muted">Loading…</div> : !rows.length ? <p className="small muted" style={{ margin: 0 }}>{tab === 'unmatched' ? 'No calls from unknown numbers.' : 'No calls in this period.'}</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>When</th><th>Customer</th><th>By</th><th>Channel</th><th>Talk</th><th>Outcome</th><th>Recording</th>{tab === 'unmatched' && <th />}</tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="small" style={{ whiteSpace: 'nowrap' }}><span title={r.direction === 'outbound' ? 'Outgoing' : 'Incoming'}>{r.direction === 'outbound' ? '↗' : '↙'}</span> {when(r.startedAt)}</td>
                        <td>{r.leadId ? <Link href={`/app/leads/${r.leadId}`}><b>{r.customerName ?? 'Lead'}</b></Link> : <b>{r.phone}</b>}<div className="small muted">{r.leadId ? r.phone : 'Not in UBOS yet'}</div></td>
                        <td className="small">{r.userName ?? '—'}</td>
                        <td className="small">{CHANNEL[r.channel] ?? r.channel}{r.provider ? ` · ${r.provider}` : ''}</td>
                        <td className="small">{r.answered ? dur(r.talkSec) : <span style={{ color: 'var(--bad)' }}>Missed / no answer</span>}</td>
                        <td className="small">{r.dispositionLabel ?? '—'}{r.remark && <div className="muted" style={{ maxWidth: 260 }}>{r.remark}</div>}</td>
                        <td>{r.canListen ? <RecordingPlayer callId={r.id} /> : <span className="small muted">{r.recording === 'uploading' ? 'Uploading…' : r.recording === 'deleted' ? 'Deleted (retention)' : r.recording === 'none' ? '—' : 'No access'}</span>}</td>
                        {tab === 'unmatched' && <td><LinkCall call={r} onDone={(t) => { setMsg({ type: 'notice', text: t }); load(); }} onError={(t) => setMsg({ type: 'error', text: t })} /></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {tab === 'phones' && <Phones all={can('org.user.manage')} />}
    </>
  );
}

/** Puts a call from an unknown number on a lead (search by name or mobile). */
function LinkCall({ call, onDone, onError }: { call: CallRow; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; name: string; mobile: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => api<{ id: string; name: string; mobile: string | null }[]>(`/api/v1/leads?q=${encodeURIComponent(q)}`).then((r) => setHits(r.slice(0, 8))).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q, open]);
  if (!open) return <button className="btn sm outline" onClick={() => setOpen(true)}>Put on a lead</button>;
  return (
    <div style={{ minWidth: 220 }}>
      <input className="input" autoFocus placeholder="Name or mobile" value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.map((h) => (
        <button key={h.id} className="link-btn small" style={{ display: 'block', padding: '4px 0' }} onClick={async () => {
          try { await api(`/api/v1/calls/${call.id}/link`, { method: 'POST', body: { leadId: h.id } }); onDone(`Call put on ${h.name}.`); } catch (e) { onError(e instanceof ApiError ? e.message : 'Failed'); }
        }}>{h.name} {h.mobile ? `· ${h.mobile}` : ''}</button>
      ))}
    </div>
  );
}

function Phones({ all }: { all: boolean }) {
  const [rows, setRows] = useState<Device[] | null>(null);
  const load = useCallback(() => api<Device[]>(`/api/v1/devices${all ? '?all=true' : ''}`, { noWorkspace: true }).then(setRows).catch(() => setRows([])), [all]);
  useEffect(() => { load(); }, [load]);
  const stale = (d: Device) => !d.revokedAt && (!d.lastSyncAt || Date.now() - new Date(d.lastSyncAt).getTime() > 24 * 3_600_000);
  return (
    <div className="card">
      <p className="small muted" style={{ marginTop: 0 }}>{all ? 'Every paired phone in the organization. A phone that has not synced for a day may be switched off or logged out.' : 'Your paired phone. Pair or replace it from My Security → My phone.'}</p>
      {!rows ? <div className="muted">Loading…</div> : !rows.length ? <p className="small muted">No phone paired yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th>Phone</th><th>App</th><th>Last sync</th><th>Waiting to sync</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} style={d.revokedAt ? { opacity: 0.5 } : undefined}>
                  <td><b>{d.userName}</b></td>
                  <td className="small">{d.name} · {d.platform}<div className="muted">Paired {when(d.createdAt)}</div></td>
                  <td className="small">{d.appVersion ?? '—'}</td>
                  <td className="small">{when(d.lastSyncAt)} {stale(d) && <span className="badge warn">Not syncing</span>}</td>
                  <td className="small">{d.pendingCalls ? <span className="badge warn">{d.pendingCalls} call(s)</span> : '0'}</td>
                  <td>{d.revokedAt ? <span className="badge grey">Unpaired</span> : <button className="btn sm ghost" onClick={async () => { if (confirm(`Unpair ${d.name}? It stops syncing at once.`)) { await api(`/api/v1/devices/${d.id}/revoke`, { method: 'POST', noWorkspace: true }).catch(() => undefined); load(); } }}>Unpair</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
