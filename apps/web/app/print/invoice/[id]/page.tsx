'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { amountInWords, GST_STATES } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { inr } from '@/lib/money';

interface Item { id: string; description: string; hsnSac: string | null; qty: number; unitPaise: number; discountPaise: number; gstBp: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }
interface Seller { legalName: string; gstin: string | null; stateCode: string; address: string; email: string | null; phone: string | null; bankDetails: string | null }
interface Inv { id: string; number: string | null; status: string; issuedAt: string | null; dueAt: string | null; placeOfSupply: string; seller: Seller | null; customerName: string; customerGstin: string | null; customerAddress: string | null; taxablePaise: number; discountPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number; paidPaise: number; notes: string | null; terms: string | null; items: Item[]; customer: { code: string; mobile: string | null; email: string | null } }

const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

/** Printable invoice: the browser's "Save as PDF" makes the PDF. */
export default function InvoicePrint() {
  const { id } = useParams<{ id: string }>();
  const [v, setV] = useState<Inv | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Inv>(`/api/v1/invoices/${id}`).then(setV).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load the invoice')); }, [id]);
  if (err) return <div className="error" style={{ margin: 24 }}>{err}</div>;
  if (!v) return <div className="muted" style={{ margin: 24 }}>Loading…</div>;
  if (!v.seller || !v.number) return <div className="error" style={{ margin: 24 }}>Issue this invoice before printing it.</div>;
  const s = v.seller;
  const igst = v.igstPaise > 0;
  return (
    <div style={{ padding: 24, background: 'var(--bg, #f6f5fa)', minHeight: '100vh' }}>
      <div className="row no-print" style={{ maxWidth: 820, margin: '0 auto 12px', justifyContent: 'space-between' }}>
        <a className="btn ghost sm" href={`/app/invoices/${v.id}`}>Back to the invoice</a>
        <button className="btn sm" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
      <div className="print-sheet">
        {v.status === 'cancelled' && <div style={{ color: 'var(--bad)', fontWeight: 700, textAlign: 'right' }}>CANCELLED</div>}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>{s.legalName}</h1>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{s.address}</div>
            <div className="small">{[s.phone, s.email].filter(Boolean).join(' · ')}</div>
            {s.gstin && <div className="small"><b>GSTIN:</b> {s.gstin}</div>}
            <div className="small"><b>State:</b> {GST_STATES[s.stateCode]} ({s.stateCode})</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>{s.gstin ? 'TAX INVOICE' : 'INVOICE'}</div>
            <div><b>{v.number}</b></div>
            <div className="small">Date: {v.issuedAt ? day(v.issuedAt) : ''}</div>
            {v.dueAt && <div className="small">Due: {day(v.dueAt)}</div>}
          </div>
        </div>
        <div className="print-parties">
          <div>
            <div className="small muted">Billed to</div>
            <b>{v.customerName}</b> <span className="small muted">({v.customer.code})</span>
            {v.customerAddress && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{v.customerAddress}</div>}
            <div className="small">{[v.customer.mobile, v.customer.email].filter(Boolean).join(' · ')}</div>
            {v.customerGstin && <div className="small"><b>GSTIN:</b> {v.customerGstin}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="small muted">Place of supply</div>
            <b>{GST_STATES[v.placeOfSupply]} ({v.placeOfSupply})</b>
          </div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Description</th><th>HSN / SAC</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th></tr></thead>
          <tbody>
            {v.items.map((i, n) => (
              <tr key={i.id}>
                <td>{n + 1}</td>
                <td>{i.description}{i.discountPaise > 0 && <div className="small muted">Discount {inr(i.discountPaise, 2)}</div>}</td>
                <td>{i.hsnSac ?? ''}</td>
                <td className="num">{i.qty}</td>
                <td className="num">{inr(i.unitPaise, 2)}</td>
                <td className="num">{inr(i.taxablePaise, 2)}</td>
                <td className="num">{s.gstin ? `${i.gstBp / 100}%` : '—'}</td>
                <td className="num">{inr(i.totalPaise, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="quote-totals" style={{ marginTop: 12 }}>
          <div><span>Taxable value</span><b>{inr(v.taxablePaise, 2)}</b></div>
          {s.gstin && (igst ? <div><span>IGST</span><b>{inr(v.igstPaise, 2)}</b></div> : <><div><span>CGST</span><b>{inr(v.cgstPaise, 2)}</b></div><div><span>SGST</span><b>{inr(v.sgstPaise, 2)}</b></div></>)}
          {v.roundOffPaise !== 0 && <div><span>Round off</span><b>{inr(v.roundOffPaise, 2)}</b></div>}
          <div className="grand"><span>Total</span><b>{inr(v.totalPaise, 2)}</b></div>
        </div>
        <p className="small"><b>Amount in words:</b> {amountInWords(v.totalPaise)}</p>
        {!s.gstin && <p className="small muted">Seller not registered under GST.</p>}
        {s.bankDetails && <><h3 style={{ fontSize: 14, marginBottom: 4 }}>Bank details</h3><p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{s.bankDetails}</p></>}
        {v.notes && <><h3 style={{ fontSize: 14, marginBottom: 4 }}>Notes</h3><p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{v.notes}</p></>}
        {v.terms && <><h3 style={{ fontSize: 14, marginBottom: 4 }}>Terms</h3><p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{v.terms}</p></>}
        <p className="small" style={{ textAlign: 'right', marginTop: 28 }}>For {s.legalName}<br /><br />Authorised signatory</p>
      </div>
    </div>
  );
}
