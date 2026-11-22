'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { GST_STATES } from '@ubos/shared';
import { api, ApiError, platformApi } from '@/lib/api';
import { inr } from '@/lib/money';

interface Party { name: string; gstin: string | null; stateCode: string | null; address: string | null; email?: string | null }
interface Item { productCode: string; name: string; quantity: number; unitPaise: number; amountPaise: number }
interface Inv { id: string; number: string; issuedAt: string; seller: Party; buyer: Party; items: Item[]; placeOfSupply: string | null; placeOfSupplyName: string | null; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; gstPaise: number; totalPaise: number; gstPct: number; paymentRef: string | null; words: string }

const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
/** SAC 998314: IT design and development services, including software as a service. */
const SAC = '998314';

function Sheet() {
  const { id } = useParams<{ id: string }>();
  const fromConsole = useSearchParams().get('console') === '1';
  const [v, setV] = useState<Inv | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    (fromConsole ? platformApi<Inv>(`/platform/v1/invoices/${id}`) : api<Inv>(`/api/v1/billing/invoices/${id}`, { noWorkspace: true })).then(setV).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load the invoice'));
  }, [id, fromConsole]);
  if (err) return <div className="error" style={{ margin: 24 }}>{err}</div>;
  if (!v) return <div className="muted" style={{ margin: 24 }}>Loading…</div>;
  const s = v.seller, b = v.buyer;
  return (
    <div style={{ padding: 24, background: 'var(--bg, #f6f5fa)', minHeight: '100vh' }}>
      <div className="row no-print" style={{ maxWidth: 820, margin: '0 auto 12px', justifyContent: 'space-between' }}>
        <a className="btn ghost sm" href={fromConsole ? '/console' : '/app/billing'}>Back</a>
        <button className="btn sm" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
      <div className="print-sheet">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>{s.name}</h1>
            {s.address && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{s.address}</div>}
            {s.email && <div className="small">{s.email}</div>}
            {s.gstin && <div className="small"><b>GSTIN:</b> {s.gstin}</div>}
            {s.stateCode && <div className="small"><b>State:</b> {GST_STATES[s.stateCode]} ({s.stateCode})</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>{s.gstin ? 'TAX INVOICE' : 'INVOICE'}</div>
            <div><b>{v.number}</b></div>
            <div className="small">Date: {day(v.issuedAt)}</div>
            <div className="small" style={{ color: 'var(--ok)', fontWeight: 700 }}>PAID</div>
          </div>
        </div>
        <div className="print-parties">
          <div>
            <div className="small muted">Billed to</div>
            <b>{b.name}</b>
            {b.address && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{b.address}</div>}
            {b.gstin && <div className="small"><b>GSTIN:</b> {b.gstin}</div>}
          </div>
          {v.placeOfSupply && <div style={{ textAlign: 'right' }}><div className="small muted">Place of supply</div><b>{v.placeOfSupplyName} ({v.placeOfSupply})</b></div>}
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Description</th><th>SAC</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {v.items.map((i, n) => (
              <tr key={`${i.productCode}${n}`}><td>{n + 1}</td><td>{i.name}</td><td>{SAC}</td><td className="num">{i.quantity}</td><td className="num">{inr(i.unitPaise, 2)}</td><td className="num">{inr(i.amountPaise, 2)}</td></tr>
            ))}
          </tbody>
        </table></div>
        <div className="quote-totals" style={{ marginTop: 12 }}>
          <div><span>Taxable value</span><b>{inr(v.taxablePaise, 2)}</b></div>
          {v.igstPaise > 0 ? <div><span>IGST {v.gstPct}%</span><b>{inr(v.igstPaise, 2)}</b></div> : <><div><span>CGST {v.gstPct / 2}%</span><b>{inr(v.cgstPaise, 2)}</b></div><div><span>SGST {v.gstPct / 2}%</span><b>{inr(v.sgstPaise, 2)}</b></div></>}
          <div className="grand"><span>Total</span><b>{inr(v.totalPaise, 2)}</b></div>
        </div>
        <p className="small"><b>Amount in words:</b> {v.words}</p>
        {v.paymentRef && <p className="small">Paid · reference {v.paymentRef}</p>}
        <p className="small" style={{ textAlign: 'right', marginTop: 28 }}>For {s.name}<br /><br />Authorised signatory</p>
      </div>
    </div>
  );
}

/** UBOS's tax invoice to a customer organization; the browser's "Save as PDF" makes the PDF. */
export default function UbosInvoicePrint() {
  return <Suspense fallback={null}><Sheet /></Suspense>;
}
