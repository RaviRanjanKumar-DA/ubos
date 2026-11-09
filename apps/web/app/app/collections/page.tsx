'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { inr } from '@/lib/money';

interface Row { id: string; number: string; customerId: string; customerName: string; dueAt: string | null; totalPaise: number; duePaise: number; bucket: string; daysPast: number | null; lastReminderAt: string | null }
interface Data { rows: Row[]; ageing: Record<string, number>; totalPaise: number; byCustomer: { customerId: string; name: string; duePaise: number; invoices: number }[]; canWork: boolean }

const BUCKETS: [string, string][] = [['notDue', 'Not yet due'], ['d1to30', '1 to 30 days'], ['d31to60', '31 to 60 days'], ['d61to90', '61 to 90 days'], ['d90plus', 'Over 90 days']];
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** Money still to come in, oldest first. */
export default function CollectionsPage() {
  const { version } = useShell();
  const [data, setData] = useState<Data | null>(null);
  const [bucket, setBucket] = useState('');
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api<Data>('/api/v1/collections').then(setData).catch((e) => setMsg({ type: 'error', text: e.message })), []);
  useEffect(() => { load(); }, [load, version]);
  const remind = async (r: Row) => { setBusy(r.id); setMsg(null); try { await api(`/api/v1/invoices/${r.id}/remind`, { method: 'POST' }); setMsg({ type: 'notice', text: `Reminder emailed to ${r.customerName}.` }); await load(); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } setBusy(''); };
  const download = async () => { try { const b = await api<Blob>('/api/v1/collections.csv'); const u = URL.createObjectURL(new Blob([b], { type: 'text/csv' })); const a = document.createElement('a'); a.href = u; a.download = 'money-due.csv'; a.click(); URL.revokeObjectURL(u); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } };
  const rows = data?.rows.filter((r) => !bucket || r.bucket === bucket) ?? [];
  return (
    <>
      <div className="page-head">
        <div><h1>Collections</h1><div className="muted small">Money still to come in, most overdue first.{data ? ` ${inr(data.totalPaise)} in total.` : ''}</div></div>
        <button className="btn outline" onClick={download}>Download</button>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="age-grid">
        {BUCKETS.map(([k, l]) => (
          <button key={k} type="button" className={`card age-card${bucket === k ? ' on' : ''}${k !== 'notDue' && (data?.ageing[k] ?? 0) > 0 ? ' late' : ''}`} aria-pressed={bucket === k} onClick={() => setBucket(bucket === k ? '' : k)}>
            <span className="small muted">{l}</span>
            <b>{inr(data?.ageing[k] ?? 0)}</b>
          </button>
        ))}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Due date</th><th>Overdue</th><th style={{ textAlign: 'right' }}>Due</th><th>Last reminder</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/app/invoices/${r.id}`}><b>{r.number}</b></Link></td>
                  <td><Link href={`/app/customers/${r.customerId}/ledger`}>{r.customerName}</Link></td>
                  <td className="small">{day(r.dueAt)}</td>
                  <td>{r.daysPast !== null && r.daysPast > 0 ? <span className="badge bad">{r.daysPast} {r.daysPast === 1 ? 'day' : 'days'}</span> : <span className="small muted">Not yet</span>}</td>
                  <td style={{ textAlign: 'right' }}><b>{inr(r.duePaise, 2)}</b></td>
                  <td className="small">{day(r.lastReminderAt)}</td>
                  <td style={{ textAlign: 'right' }}>{data?.canWork && <button className="btn sm outline" disabled={busy === r.id} onClick={() => remind(r)}>{busy === r.id ? 'Sending…' : 'Remind'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !rows.length && <div className="empty">Nothing due here.</div>}
        </div>
      </div>
    </>
  );
}
