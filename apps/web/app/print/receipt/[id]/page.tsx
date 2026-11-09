'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { inr } from '@/lib/money';

interface Receipt { receiptNumber: string; amountPaise: number; words: string; mode: string; reference: string | null; receivedAt: string; isVoided: boolean; voidReason: string | null; invoice: { id: string; number: string; totalPaise: number }; customerName: string; seller: { legalName: string; address: string; gstin: string | null } | null }
const MODES: Record<string, string> = { upi: 'UPI', bank: 'Bank transfer', card: 'Card', cash: 'Cash', cheque: 'Cheque', online: 'Online' };

/** Printable payment receipt. */
export default function ReceiptPrint() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<Receipt | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Receipt>(`/api/v1/payments/${id}/receipt`).then(setR).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load the receipt')); }, [id]);
  if (err) return <div className="error" style={{ margin: 24 }}>{err}</div>;
  if (!r) return <div className="muted" style={{ margin: 24 }}>Loading…</div>;
  return (
    <div style={{ padding: 24, background: 'var(--bg, #f6f5fa)', minHeight: '100vh' }}>
      <div className="row no-print" style={{ maxWidth: 820, margin: '0 auto 12px', justifyContent: 'space-between' }}>
        <a className="btn ghost sm" href={`/app/invoices/${r.invoice.id}`}>Back to the invoice</a>
        <button className="btn sm" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
      <div className="print-sheet">
        {r.isVoided && <div style={{ color: 'var(--bad)', fontWeight: 700, textAlign: 'right' }}>VOID{r.voidReason ? `: ${r.voidReason}` : ''}</div>}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>{r.seller?.legalName}</h1>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.seller?.address}</div>
            {r.seller?.gstin && <div className="small"><b>GSTIN:</b> {r.seller.gstin}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>RECEIPT</div>
            <div><b>{r.receiptNumber}</b></div>
            <div className="small">Date: {new Date(r.receivedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}</div>
          </div>
        </div>
        <p style={{ marginTop: 28 }}>Received from <b>{r.customerName}</b> the sum of <b>{inr(r.amountPaise, 2)}</b>.</p>
        <p className="small"><b>Amount in words:</b> {r.words}</p>
        <p className="small"><b>Paid by:</b> {MODES[r.mode] ?? r.mode}{r.reference ? ` (${r.reference})` : ''}</p>
        <p className="small"><b>Against invoice:</b> {r.invoice.number}</p>
        <p className="small" style={{ textAlign: 'right', marginTop: 32 }}>For {r.seller?.legalName}<br /><br />Authorised signatory</p>
      </div>
    </div>
  );
}
