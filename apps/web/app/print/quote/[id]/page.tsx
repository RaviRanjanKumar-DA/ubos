'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { inr, QUOTE_STATUS } from '@/lib/money';

interface QuoteFull {
  id: string; number: string; status: string; createdAt: string; validUntil: string | null; notes: string | null; terms: string | null;
  subtotalPaise: number; discountPaise: number; taxPaise: number; totalPaise: number;
  items: { id: string; name: string; qty: number; listPricePaise: number; pricePaise: number; gstRate: number }[];
  customer: { name: string; code: string; email: string | null; mobile: string | null; city: string | null };
  workspace: { name: string; gstin: string | null }; organization: string; createdBy: { name: string; email: string } | null; lead: { id: string };
}

/** Printable quote: the browser's "Save as PDF" makes the PDF (no server-side PDF service needed). */
export default function QuotePrint() {
  const { id } = useParams<{ id: string }>();
  const [q, setQ] = useState<QuoteFull | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<QuoteFull>(`/api/v1/quotes/${id}`).then(setQ).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load the quote')); }, [id]);
  if (err) return <div className="error" style={{ margin: 24 }}>{err}</div>;
  if (!q) return <div className="muted" style={{ margin: 24 }}>Loading…</div>;
  const st = QUOTE_STATUS[q.status];
  const draft = ['draft', 'pending_approval'].includes(q.status);
  return (
    <div style={{ padding: 24, background: 'var(--bg, #f6f5fa)', minHeight: '100vh' }}>
      <div className="row no-print" style={{ maxWidth: 820, margin: '0 auto 12px', justifyContent: 'space-between' }}>
        <a className="btn ghost sm" href={`/app/leads/${q.lead.id}?tab=quotes`}>← Back to the lead</a>
        <div className="row" style={{ gap: 8 }}>
          {st && <span className={`badge ${st.tone}`}>{st.label}</span>}
          <button className="btn sm" onClick={() => window.print()}>Print / Save as PDF</button>
        </div>
      </div>
      <div className="print-sheet">
        {draft && <div className="small" style={{ color: 'var(--warn)', textAlign: 'right' }}>DRAFT — not yet approved for sending</div>}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ margin: 0 }}>{q.organization}</h1>
            <div className="small muted">{q.workspace.name}{q.workspace.gstin ? ` · GSTIN ${q.workspace.gstin}` : ''}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>QUOTATION</div>
            <div><b>{q.number}</b></div>
            <div className="small">Date: {new Date(q.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
            {q.validUntil && <div className="small">Valid until: {new Date(q.validUntil).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>}
          </div>
        </div>
        <div style={{ margin: '22px 0 16px' }}>
          <div className="small muted">Prepared for</div>
          <b>{q.customer.name}</b> <span className="small muted">({q.customer.code})</span>
          <div className="small">{[q.customer.mobile, q.customer.email, q.customer.city].filter(Boolean).join(' · ')}</div>
        </div>
        <table>
          <thead><tr><th>#</th><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">GST</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {q.items.map((i, n) => (
              <tr key={i.id}>
                <td>{n + 1}</td>
                <td>{i.name}{i.pricePaise < i.listPricePaise && <div className="small muted">List {inr(i.listPricePaise)}</div>}</td>
                <td className="num">{i.qty}</td>
                <td className="num">{inr(i.pricePaise, 2)}</td>
                <td className="num">{i.gstRate}%</td>
                <td className="num">{inr(i.pricePaise * i.qty, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="quote-totals" style={{ marginTop: 12 }}>
          {q.discountPaise > 0 && <div><span>List value</span><b>{inr(q.subtotalPaise, 2)}</b></div>}
          {q.discountPaise > 0 && <div><span>Discount</span><b>−{inr(q.discountPaise, 2)}</b></div>}
          <div><span>Taxable value</span><b>{inr(q.subtotalPaise - q.discountPaise, 2)}</b></div>
          <div><span>GST</span><b>{inr(q.taxPaise, 2)}</b></div>
          <div className="grand"><span>Total</span><b>{inr(q.totalPaise, 2)}</b></div>
        </div>
        {q.notes && <><h3 style={{ fontSize: 14, marginBottom: 4 }}>Notes</h3><p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{q.notes}</p></>}
        {q.terms && <><h3 style={{ fontSize: 14, marginBottom: 4 }}>Terms</h3><p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{q.terms}</p></>}
        {q.createdBy && <p className="small muted" style={{ marginTop: 24 }}>Prepared by {q.createdBy.name} · {q.createdBy.email}</p>}
      </div>
    </div>
  );
}
