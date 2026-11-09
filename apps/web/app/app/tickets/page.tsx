'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Menu } from '@/components/Menu';
import { SlaBadge, PRIORITY, PRIORITY_TONE, STATUS, when, type TicketRow } from '@/components/support/ticket-ui';

type Opt = { value: string; label: string };
interface Options { canManage: boolean; canAssign: boolean; canWork: boolean; me: string; users: Opt[]; categories: string[] }
interface Summary { open: number; waiting: number; unassigned: number; overdue: number; resolved30d: number; slaMetPct: number | null }
interface Policy { priority: string; firstResponseMin: number; resolutionMin: number }
const VIEWS: [string, string][] = [['open', 'All open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['overdue', 'Past target'], ['all', 'Everything']];

/** The support queue: counts, views, and raising a new ticket. */
export default function TicketsPage() {
  const { me, can, version } = useShell();
  const router = useRouter();
  const [rows, setRows] = useState<TicketRow[] | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [view, setView] = useState('open');
  const [q, setQ] = useState('');
  const [priority, setPriority] = useState('');
  const [creating, setCreating] = useState<{ id: string; name: string } | true | null>(null);
  const [slaOpen, setSlaOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    const p = new URLSearchParams({ view, ...(q ? { q } : {}), ...(priority ? { priority } : {}) });
    api<TicketRow[]>(`/api/v1/tickets?${p}`).then(setRows).catch(() => setRows([]));
    api<Summary>('/api/v1/tickets/summary').then(setSum).catch(() => setSum(null));
  }, [view, q, priority]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, version]);
  useEffect(() => { api<Options>('/api/v1/tickets/options').then(setOpts).catch(() => setOpts(null)); }, [version]);
  // Customer 360 links here to raise a ticket for that customer.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const id = p.get('customer');
    if (id) setCreating({ id, name: p.get('name') ?? 'Customer' });
  }, []);

  const ws = me.currentWorkspaceId;
  const KPI: [string, string, boolean?][] = sum ? [['Open', String(sum.open)], ['Past target', String(sum.overdue), sum.overdue > 0], ['Unassigned', String(sum.unassigned)], ['Waiting on customer', String(sum.waiting)], ['Met target (30 days)', sum.slaMetPct === null ? '—' : `${sum.slaMetPct}%`]] : [];
  return (
    <>
      <div className="page-head">
        <div><h1>Tickets</h1><p className="muted small page-note">Customer problems and requests, each with a target time.</p></div>
        <div className="row">
          {can('support.ticket.work') && ws && <button className="btn" onClick={() => setCreating(true)}>+ New ticket</button>}
          <Menu items={[{ label: 'Target times (SLA)', icon: 'clock', onClick: () => setSlaOpen(true), hidden: !ws }]} />
        </div>
      </div>
      {notice && <div className="notice">{notice}</div>}
      {!ws && <div className="notice">Select a business line at the top to raise tickets and change target times.</div>}
      {sum && <div className="ticket-kpis">{KPI.map(([l, v, bad]) => <div className="card kpi" key={l}><div className="label">{l}</div><div className={`value ${bad ? 'kpi-bad' : ''}`}>{v}</div></div>)}</div>}
      <div className="card lead-bar">
        <div className="chips chips-scroll">{VIEWS.map(([k, l]) => <button key={k} className={`chip ${view === k ? 'on' : ''}`} onClick={() => setView(k)}>{l}</button>)}</div>
        <div className="ticket-filters">
          <input className="input" placeholder="Search subject, customer or #number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tickets" />
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority"><option value="">Any priority</option>{Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
      </div>
      <div className="card ticket-table">
        {!rows ? <div className="muted">Loading…</div> : !rows.length ? <div className="empty">No tickets here.</div> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Ticket</th><th>Customer</th><th>Priority</th><th>Status</th><th>Owner</th><th>Target</th><th>Raised</th></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => router.push(`/app/tickets/${t.id}`)}>
                <td><b>#{t.number} {t.subject}</b>{t.category && <div className="small muted">{t.category}</div>}</td>
                <td>{t.customerName}</td>
                <td><span className={`badge ${PRIORITY_TONE[t.priority]}`}>{PRIORITY[t.priority]}</span></td>
                <td className="small">{STATUS[t.status]}</td>
                <td className="small">{t.assignee ?? <span className="muted">Unassigned</span>}</td>
                <td><SlaBadge sla={t.sla} status={t.status} /></td>
                <td className="small">{when(t.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {creating && opts && <NewTicket opts={opts} preset={creating === true ? null : creating} onClose={() => setCreating(null)} onDone={(id) => router.push(`/app/tickets/${id}`)} />}
      {slaOpen && <SlaDialog canManage={!!opts?.canManage} onClose={() => setSlaOpen(false)} onDone={() => { setSlaOpen(false); setNotice('Target times saved. They apply to new tickets.'); }} />}
    </>
  );
}

function NewTicket({ opts, preset, onClose, onDone }: { opts: Options; preset: { id: string; name: string } | null; onClose: () => void; onDone: (id: string) => void }) {
  const [customer, setCustomer] = useState(preset);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<{ id: string; name: string; mobile: string | null; code: string }[]>([]);
  const [f, setF] = useState({ subject: '', description: '', priority: 'normal', category: '', assigneeId: '', source: 'manual' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (customer || search.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => api<typeof hits>(`/api/v1/customers?q=${encodeURIComponent(search)}`).then((r) => setHits(r.slice(0, 6))).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [search, customer]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!customer) return;
    setBusy(true); setErr('');
    try { const r = await api<{ id: string }>('/api/v1/tickets', { method: 'POST', body: { customerId: customer.id, subject: f.subject, description: f.description || undefined, priority: f.priority, category: f.category || undefined, source: f.source, assigneeId: f.assigneeId || undefined } }); onDone(r.id); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); setBusy(false); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>New ticket</h2>
        {err && <div className="error">{err}</div>}
        <div className="field">
          <label htmlFor="t-cust">Customer</label>
          {customer ? <div className="row"><b>{customer.name}</b>{!preset && <button type="button" className="link-btn small" onClick={() => setCustomer(null)}>Change</button>}</div> : <input id="t-cust" className="input" autoFocus placeholder="Name, mobile or customer ID" value={search} onChange={(e) => setSearch(e.target.value)} />}
          {hits.map((h) => <button type="button" key={h.id} className="link-btn small ticket-hit" onClick={() => setCustomer({ id: h.id, name: h.name })}>{h.name} · {h.code}{h.mobile ? ` · ${h.mobile}` : ''}</button>)}
        </div>
        <div className="field"><label htmlFor="t-sub">Subject</label><input id="t-sub" className="input" required minLength={3} maxLength={160} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></div>
        <div className="field"><label htmlFor="t-desc">What happened</label><textarea id="t-desc" className="input" rows={3} maxLength={5000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div className="form-two">
          <div className="field"><label htmlFor="t-pri">Priority</label><select id="t-pri" className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div className="field"><label htmlFor="t-cat">Category</label><input id="t-cat" className="input" list="t-cats" maxLength={60} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /><datalist id="t-cats">{opts.categories.map((c) => <option key={c} value={c} />)}</datalist></div>
          <div className="field"><label htmlFor="t-src">Came in by</label><select id="t-src" className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="manual">Entered here</option><option value="call">Phone call</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="walk_in">Walk-in</option></select></div>
          <div className="field"><label htmlFor="t-own">Owner</label><select id="t-own" className="input" value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}><option value="">Unassigned</option>{opts.users.filter((u) => opts.canAssign || u.value === opts.me).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></div>
        </div>
        <div className="row modal-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !customer}>{busy ? 'Saving…' : 'Create ticket'}</button></div>
      </form>
    </div>
  );
}

function SlaDialog({ canManage, onClose, onDone }: { canManage: boolean; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Policy[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Policy[]>('/api/v1/tickets/sla').then(setRows).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load')); }, []);
  const set = (i: number, k: 'firstResponseMin' | 'resolutionMin', hours: string) => setRows(rows!.map((r, j) => (j === i ? { ...r, [k]: Math.round(Number(hours) * 60) } : r)));
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('/api/v1/tickets/sla', { method: 'PUT', body: { policies: rows } }); onDone(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Target times</h2>
        <p className="small muted">In hours, counted around the clock. The clock stops while a ticket is waiting on the customer.</p>
        {err && <div className="error">{err}</div>}
        {!rows ? <div className="muted">Loading…</div> : (
          <div className="sla-grid">
            <span className="small muted">Priority</span><span className="small muted">First response</span><span className="small muted">Resolution</span>
            {rows.map((r, i) => (
              <div className="sla-row" key={r.priority}>
                <b>{PRIORITY[r.priority]}</b>
                <input className="input" type="number" min={0.05} step="any" disabled={!canManage} aria-label={`${PRIORITY[r.priority]} first response in hours`} value={+(r.firstResponseMin / 60).toFixed(2)} onChange={(e) => set(i, 'firstResponseMin', e.target.value)} />
                <input className="input" type="number" min={0.05} step="any" disabled={!canManage} aria-label={`${PRIORITY[r.priority]} resolution in hours`} value={+(r.resolutionMin / 60).toFixed(2)} onChange={(e) => set(i, 'resolutionMin', e.target.value)} />
              </div>
            ))}
          </div>
        )}
        <div className="row modal-actions"><button type="button" className="btn ghost" onClick={onClose}>Close</button>{canManage && <button className="btn" disabled={!rows}>Save</button>}</div>
      </form>
    </div>
  );
}
