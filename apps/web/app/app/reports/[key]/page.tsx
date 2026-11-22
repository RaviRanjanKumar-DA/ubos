'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReportColumn, ReportResult } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { inr } from '@/lib/money';

interface Opt { id: string; name: string }
const RANGES: [string, string][] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'], ['this_month', 'This month'], ['last_month', 'Last month'], ['this_quarter', 'This quarter'], ['this_year', 'This year'], ['custom', 'Choose dates']];
const LEAD_LINK = ['leads', 'call_log', 'duplicates', 'facebook', 'sales', 'tasks'];

const cell = (v: unknown, c: ReportColumn) => {
  if (v === null || v === undefined || v === '') return '—';
  if (c.format === 'currency') return inr(Number(v));
  if (c.format === 'percent') return `${v}%`;
  if (c.format === 'datetime') return new Date(String(v)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (c.format === 'date') return new Date(String(v)).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  if (c.format === 'count' || c.format === 'number' || c.format === 'minutes') return Number(v).toLocaleString('en-IN');
  return String(v);
};

export default function ReportPage() {
  const { key } = useParams<{ key: string }>();
  const { me, can, version } = useShell();
  const [f, setF] = useState({ range: 'this_month', from: '', to: '', workspaceId: '', ownerId: '', source: '' });
  const [people, setPeople] = useState<Opt[]>([]);
  const [r, setR] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const restorable = key === 'deleted' && can('crm.lead.delete');
  const restore = async () => { try { const x = await api<{ restored: number }>('/api/v1/leads/restore', { method: 'POST', body: { leadIds: [...picked] } }); setPicked(new Set()); setErr(''); await load(); setNote(`${x.restored} lead(s) restored.`); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); } };
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const qs = useCallback(() => new URLSearchParams(Object.entries(f).filter(([k, v]) => v && (f.range === 'custom' || (k !== 'from' && k !== 'to')))).toString(), [f]);
  const load = useCallback(async () => {
    if (f.range === 'custom' && (!f.from || !f.to)) return;
    setBusy(true); setErr('');
    try { setR(await api<ReportResult>(`/api/v1/reports/${key}?${qs()}`)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
    setBusy(false);
  }, [key, qs, f.range, f.from, f.to]);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    const ws = f.workspaceId;
    (ws ? api<Opt[]>(`/api/v1/workspaces/${ws}/assignees`, { workspace: ws }) : can('org.user.view') ? api<(Opt & { isActive: boolean })[]>('/api/v1/users', { noWorkspace: true }).then((u) => u.filter((x) => x.isActive)) : Promise.resolve([]))
      .then((p) => setPeople(p.map((x) => ({ id: x.id, name: x.name })))).catch(() => setPeople([]));
  }, [f.workspaceId, can]);
  const download = async () => {
    setErr('');
    try {
      const b = await api<Blob>(`/api/v1/reports/${key}/download?${qs()}`);
      const u = URL.createObjectURL(new Blob([b], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = u; a.download = `${key}-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.csv`; a.click(); URL.revokeObjectURL(u);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <div className="page-head">
        <div><div className="small"><Link href="/app/reports">Reports</Link></div><h1>{r?.title ?? 'Report'}</h1>{r && <div className="muted small">{r.period.label} · {r.rows.length.toLocaleString('en-IN')} {r.rows.length === 1 ? 'row' : 'rows'}{r.truncated ? ' shown (download for all)' : ''}</div>}</div>
        <button className="btn" onClick={download} disabled={!r}><Icon name="download" className="ic" />Download for Excel</button>
      </div>
      <div className="card report-filters">
        <select className="input" aria-label="Period" value={f.range} onChange={set('range')}>{RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {f.range === 'custom' && <><input className="input" type="date" aria-label="From" value={f.from} onChange={set('from')} /><input className="input" type="date" aria-label="To" value={f.to} onChange={set('to')} /></>}
        {me.workspaces.length > 1 && <select className="input" aria-label="Business line" value={f.workspaceId} onChange={(e) => setF({ ...f, workspaceId: e.target.value, ownerId: '' })}><option value="">All business lines</option>{me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}
        {people.length > 0 && <select className="input" aria-label="Person" value={f.ownerId} onChange={set('ownerId')}><option value="">Everyone</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <input className="input" aria-label="Source" placeholder="Source (e.g. website)" value={f.source} onChange={set('source')} style={{ maxWidth: 180 }} />
        {busy && <span className="small muted">Loading…</span>}
      </div>
      {err && <div className="error">{err}</div>}
      {note && <div className="notice">{note}</div>}
      {restorable && picked.size > 0 && <div className="bulkbar"><b>{picked.size} selected</b><span style={{ flex: 1 }} /><button className="btn sm" onClick={restore}>Restore</button><button className="btn sm" onClick={() => setPicked(new Set())}>Clear</button></div>}
      {r && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="table report-table">
              <thead><tr>{restorable && <th style={{ width: 34 }} />}{r.columns.map((c) => <th key={c.key} className={['count', 'number', 'percent', 'currency', 'minutes'].includes(c.format ?? '') ? 'num' : ''}>{c.label}</th>)}</tr></thead>
              <tbody>
                {r.rows.map((row, i) => (
                  <tr key={i}>
                    {restorable && <td><input type="checkbox" aria-label={`Select ${String(row.name)}`} checked={picked.has(String(row.leadId))} onChange={() => { const s = new Set(picked); if (s.has(String(row.leadId))) s.delete(String(row.leadId)); else s.add(String(row.leadId)); setPicked(s); }} /></td>}
                    {r.columns.map((c, j) => {
                      const v = cell(row[c.key], c);
                      const num = ['count', 'number', 'percent', 'currency', 'minutes'].includes(c.format ?? '');
                      return <td key={c.key} className={num ? 'num' : ''}>{j === 0 && LEAD_LINK.includes(key) && key !== 'deleted' && row.leadId ? <Link href={`/app/leads/${row.leadId}`}>{v}</Link> : v}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
              {r.totals && r.rows.length > 0 && <tfoot><tr>{restorable && <td />}{r.columns.map((c) => <td key={c.key} className={['count', 'number', 'currency', 'minutes'].includes(c.format ?? '') ? 'num' : ''}><b>{r.totals![c.key] !== undefined ? cell(r.totals![c.key], c) : ''}</b></td>)}</tr></tfoot>}
            </table>
            {!r.rows.length && <div className="empty">Nothing in this period.</div>}
          </div>
        </div>
      )}
    </>
  );
}
