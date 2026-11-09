'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { inr } from '@/lib/money';

interface Row { at: string; kind: string; ref: string | null; id: string; debitPaise: number; creditPaise: number; note: string; balancePaise: number }
interface Ledger { customer: { id: string; name: string; code: string }; rows: Row[]; balancePaise: number; billedPaise: number; receivedPaise: number }

/** Every invoice and payment for one customer, with a running balance. */
export default function LedgerPage() {
  const { id } = useParams<{ id: string }>();
  const [l, setL] = useState<Ledger | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Ledger>(`/api/v1/customers/${id}/ledger`).then(setL).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load the ledger')); }, [id]);
  if (err) return <div className="error">{err}</div>;
  if (!l) return <div className="muted">Loading…</div>;
  const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link href={`/app/customers/${l.customer.id}`}>{l.customer.name}</Link> / Ledger</div>
          <h1>Ledger</h1>
        </div>
        <button className="btn outline no-print" onClick={() => window.print()}>Print</button>
      </div>
      <div className="grid cols-3 inv-sum">
        <div className="card kpi"><div className="label">Billed</div><div className="value">{inr(l.billedPaise)}</div></div>
        <div className="card kpi"><div className="label">Received</div><div className="value">{inr(l.receivedPaise)}</div></div>
        <div className="card kpi"><div className="label">{l.balancePaise < 0 ? 'Paid in advance' : 'Balance due'}</div><div className="value">{inr(Math.abs(l.balancePaise))}</div></div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Details</th><th>Reference</th><th style={{ textAlign: 'right' }}>Billed</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
            <tbody>
              {l.rows.map((r) => (
                <tr key={r.kind + r.id}>
                  <td className="small">{day(r.at)}</td>
                  <td>{r.note}</td>
                  <td className="small">{r.kind === 'invoice' ? <Link href={`/app/invoices/${r.id}`}>{r.ref}</Link> : r.ref ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{r.debitPaise ? inr(r.debitPaise, 2) : ''}</td>
                  <td style={{ textAlign: 'right' }}>{r.creditPaise ? inr(r.creditPaise, 2) : ''}</td>
                  <td style={{ textAlign: 'right' }}><b>{inr(r.balancePaise, 2)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!l.rows.length && <div className="empty">Nothing yet.</div>}
        </div>
      </div>
    </>
  );
}
