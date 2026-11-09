'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { istDay } from '@/lib/ist';
import { inr } from '@/lib/money';

interface Row { incomePaise: number; expensePaise: number; profitPaise: number }
interface Pnl extends Row { basis: string; marginPct: number | null; months: (Row & { month: string })[]; businessLines: (Row & { id: string | null; name: string })[]; categories: { name: string; paise: number }[] }

const monthName = (m: string) => new Date(`${m}-15T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', year: 'numeric' });
function fyStart(today: string) { const [y, m] = today.split('-').map(Number); return `${m >= 4 ? y : y - 1}-04-01`; }

export default function PnlPage() {
  const { version } = useShell();
  const today = istDay(new Date());
  const [from, setFrom] = useState(fyStart(today));
  const [to, setTo] = useState(today);
  const [basis, setBasis] = useState<'invoiced' | 'received'>('invoiced');
  const [p, setP] = useState<Pnl | null>(null);
  const [err, setErr] = useState('');
  const qs = `from=${from}&to=${to}&basis=${basis}`;
  const load = useCallback(() => { if (from && to) { setErr(''); api<Pnl>(`/api/v1/pnl?${qs}`).then(setP).catch((e) => setErr(e instanceof ApiError ? e.message : 'Failed')); } }, [from, to, qs]);
  useEffect(() => { load(); }, [load, version]);
  const download = async () => { try { const b = await api<Blob>(`/api/v1/pnl.csv?${qs}`); const u = URL.createObjectURL(new Blob([b], { type: 'text/csv' })); const a = document.createElement('a'); a.href = u; a.download = `profit-and-loss-${from}-to-${to}.csv`; a.click(); URL.revokeObjectURL(u); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); } };
  const tone = (n: number) => (n < 0 ? { color: 'var(--bad)' } : undefined);
  const table = (first: string, rows: (Row & { key: string; label: string })[]) => (
    <div className="table-wrap"><table className="table"><thead><tr><th>{first}</th><th style={{ textAlign: 'right' }}>Income</th><th style={{ textAlign: 'right' }}>Expenses</th><th style={{ textAlign: 'right' }}>Profit</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.key}><td>{r.label}</td><td style={{ textAlign: 'right' }}>{inr(r.incomePaise)}</td><td style={{ textAlign: 'right' }}>{inr(r.expensePaise)}</td><td style={{ textAlign: 'right', ...tone(r.profitPaise) }}><b>{inr(r.profitPaise)}</b></td></tr>)}</tbody></table>
      {!rows.length && <div className="empty">Nothing in this period.</div>}</div>
  );
  return (
    <>
      <div className="page-head">
        <div><h1>Profit &amp; loss</h1><div className="muted small">{basis === 'invoiced' ? 'Income is issued invoices before GST.' : 'Income is money received, including any GST in it.'} Expenses are before claimable GST. A guide for running the business, not your statutory accounts.</div></div>
        <button className="btn outline" onClick={download}>Download</button>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="card exp-filters">
        <input className="input" type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        <select className="input" aria-label="Income basis" value={basis} onChange={(e) => setBasis(e.target.value as 'invoiced' | 'received')}><option value="invoiced">Income: invoiced</option><option value="received">Income: money received</option></select>
      </div>
      {p && (
        <>
          <div className="grid cols-3 inv-sum">
            <div className="card kpi"><div className="label">Income</div><div className="value">{inr(p.incomePaise)}</div></div>
            <div className="card kpi"><div className="label">Expenses</div><div className="value">{inr(p.expensePaise)}</div></div>
            <div className="card kpi"><div className="label">Profit</div><div className="value" style={tone(p.profitPaise)}>{inr(p.profitPaise)}</div>{p.marginPct !== null && <div className="small muted">{p.marginPct}% margin</div>}</div>
          </div>
          <div className="inv-grid">
            <div>
              <div className="card" style={{ padding: 0, marginBottom: 16 }}><h2 className="pnl-h">By month</h2>{table('Month', p.months.map((m) => ({ ...m, key: m.month, label: monthName(m.month) })))}</div>
              <div className="card" style={{ padding: 0 }}><h2 className="pnl-h">By business line</h2>{table('Business line', p.businessLines.map((l) => ({ ...l, key: l.id ?? 'org', label: l.name })))}</div>
            </div>
            <div className="card">
              <h2>Where the money went</h2>
              {!p.categories.length && <p className="small muted" style={{ margin: 0 }}>No expenses in this period.</p>}
              {p.categories.map((c) => (
                <div key={c.name} className="pnl-cat">
                  <div className="org-head small"><span>{c.name}</span><b>{inr(c.paise)}</b></div>
                  <div className="bar"><span style={{ width: `${p.expensePaise > 0 ? Math.round((c.paise / p.expensePaise) * 100) : 0}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
