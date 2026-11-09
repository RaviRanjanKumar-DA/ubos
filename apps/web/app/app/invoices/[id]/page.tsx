'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { computeInvoice } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { askConfirm, askText } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';
import { fromIstInput, toIstInput } from '@/lib/ist';
import { inr, toPaise } from '@/lib/money';

interface Item { description: string; hsnSac: string | null; qty: number; unitPaise: number; discountPaise: number; gstBp: number }
interface Pay { id: string; amountPaise: number; mode: string; reference: string | null; receivedAt: string; isVoided: boolean; voidReason: string | null }
interface Inv {
  id: string; number: string | null; status: string; leadId: string; dueAt: string | null; placeOfSupply: string; customerName: string; customerGstin: string | null; customerAddress: string | null; notes: string | null; terms: string | null;
  subtotalPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number; paidPaise: number; cancelReason: string | null;
  items: Item[]; payments: Pay[]; sellerNow: { stateCode: string; gstin: string | null; legalName: string } | null; states: Record<string, string>; rates: number[]; canEdit: boolean; canIssue: boolean;
}
type Line = { description: string; hsnSac: string; qty: string; unit: string; discount: string; gstBp: number };
const when = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });
const toLine = (i: Item): Line => ({ description: i.description, hsnSac: i.hsnSac ?? '', qty: String(i.qty), unit: String(i.unitPaise / 100), discount: i.discountPaise ? String(i.discountPaise / 100) : '', gstBp: i.gstBp });

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [inv, setInv] = useState<Inv | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [f, setF] = useState({ place: '', gstin: '', address: '', due: '', notes: '', terms: '' });
  const [pay, setPay] = useState<{ amount: string; mode: string; reference: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Inv>(`/api/v1/invoices/${id}`).then((d) => {
    setInv(d); setLines(d.items.map(toLine));
    setF({ place: d.placeOfSupply, gstin: d.customerGstin ?? '', address: d.customerAddress ?? '', due: d.dueAt ? toIstInput(new Date(d.dueAt)).slice(0, 10) : '', notes: d.notes ?? '', terms: d.terms ?? '' });
  }).catch((e) => setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Could not load the invoice' })), [id]);
  useEffect(() => { load(); }, [load]);
  if (!inv) return msg ? <div className={msg.type}>{msg.text}</div> : <div className="muted">Loading…</div>;

  const draft = inv.status === 'draft' && inv.canEdit;
  const num = (s: string) => Number(s) || 0;
  const parsed = lines.map((l) => ({ description: l.description, hsnSac: l.hsnSac.trim() || null, qty: Math.max(0, Math.floor(num(l.qty))), unitPaise: toPaise(l.unit) ?? 0, discountPaise: toPaise(l.discount || '0') ?? 0, gstBp: l.gstBp }));
  const seller = inv.sellerNow;
  const live = draft ? computeInvoice(parsed, { intraState: f.place === seller?.stateCode, registered: !!seller?.gstin }) : inv;
  const set = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const due = inv.totalPaise - inv.paidPaise;
  const payload = () => ({ items: parsed, placeOfSupply: f.place, customerGstin: f.gstin.trim().toUpperCase() || null, customerAddress: f.address.trim() || null, dueAt: f.due ? fromIstInput(`${f.due}T23:59`).toISOString() : null, notes: f.notes.trim() || null, terms: f.terms.trim() || null });
  const run = async (fn: () => Promise<unknown>, text: string) => { setBusy(true); setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; } finally { setBusy(false); } };
  const save = () => run(() => api(`/api/v1/invoices/${id}`, { method: 'PUT', body: payload() }), 'Draft saved.');
  const issue = async () => { if (!(await askConfirm('Issue this invoice? It gets its number and can no longer be changed.', 'Issue'))) return; run(async () => { await api(`/api/v1/invoices/${id}`, { method: 'PUT', body: payload() }); await api(`/api/v1/invoices/${id}/issue`, { method: 'POST' }); }, 'Invoice issued.'); };
  const cancel = async () => { const reason = await askText('Why is this invoice being cancelled?'); if (reason) run(() => api(`/api/v1/invoices/${id}/cancel`, { method: 'POST', body: { reason } }), 'Invoice cancelled.'); };
  const record = async (e: React.FormEvent) => { e.preventDefault(); if (!pay) return; if (await run(() => api(`/api/v1/invoices/${id}/payments`, { method: 'POST', body: { amountPaise: toPaise(pay.amount), mode: pay.mode, reference: pay.reference.trim() || null } }), 'Payment recorded.')) setPay(null); };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link href="/app/invoices">Invoices</Link> / <Link href={`/app/leads/${inv.leadId}`}>{inv.customerName}</Link></div>
          <h1>{inv.number ?? 'Draft invoice'}</h1>
          {inv.cancelReason && <div className="small muted">Cancelled: {inv.cancelReason}</div>}
        </div>
        <div className="row">
          {inv.status !== 'draft' && <Link className="btn outline" href={`/print/invoice/${id}`} target="_blank">Print / PDF</Link>}
          {draft && <button className="btn outline" disabled={busy} onClick={save}>Save draft</button>}
          {draft && inv.canIssue && <button className="btn" disabled={busy} onClick={issue}>Issue invoice</button>}
          {inv.status === 'issued' && inv.canEdit && due > 0 && <button className="btn" onClick={() => setPay({ amount: String(due / 100), mode: 'upi', reference: '' })}>Record payment</button>}
          {inv.status !== 'cancelled' && inv.canIssue && inv.paidPaise === 0 && <button className="btn ghost" disabled={busy} onClick={cancel}>Cancel invoice</button>}
        </div>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {draft && !seller && <div className="error">Add your billing details first (Invoices → Billing details).</div>}
      <div className="inv-grid">
        <div className="card">
          <h2>Items</h2>
          <div className="table-wrap">
            <table className="inv-items">
              <thead><tr><th>Description</th><th>HSN / SAC</th><th>Qty</th><th>Rate ₹</th><th>Discount ₹</th><th>GST</th>{draft && <th />}</tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ minWidth: 180 }}><input className="input" aria-label="Description" disabled={!draft} value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                    <td style={{ width: 100 }}><input className="input" aria-label="HSN or SAC" disabled={!draft} inputMode="numeric" maxLength={8} value={l.hsnSac} onChange={(e) => set(i, { hsnSac: e.target.value.replace(/\D/g, '') })} /></td>
                    <td style={{ width: 70 }}><input className="input" aria-label="Quantity" disabled={!draft} inputMode="numeric" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
                    <td style={{ width: 110 }}><input className="input" aria-label="Rate" disabled={!draft} inputMode="decimal" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} /></td>
                    <td style={{ width: 100 }}><input className="input" aria-label="Discount" disabled={!draft} inputMode="decimal" value={l.discount} onChange={(e) => set(i, { discount: e.target.value })} /></td>
                    <td style={{ width: 90 }}><select className="input" aria-label="GST rate" disabled={!draft} value={l.gstBp} onChange={(e) => set(i, { gstBp: Number(e.target.value) })}>{inv.rates.map((r) => <option key={r} value={r}>{r / 100}%</option>)}</select></td>
                    {draft && <td><button type="button" className="btn sm ghost" aria-label="Remove item" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="close" className="ic" /></button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {draft && <button type="button" className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setLines([...lines, { description: '', hsnSac: '', qty: '1', unit: '', discount: '', gstBp: lines.at(-1)?.gstBp ?? 1800 }])}><Icon name="plus" className="ic" />Item</button>}
          <div className="inv-totals">
            {live.discountPaise > 0 && <div><span>Discount</span><span>−{inr(live.discountPaise, 2)}</span></div>}
            <div><span>Taxable value</span><span>{inr(live.taxablePaise, 2)}</span></div>
            {live.igstPaise > 0 ? <div><span>IGST</span><span>{inr(live.igstPaise, 2)}</span></div> : <><div><span>CGST</span><span>{inr(live.cgstPaise, 2)}</span></div><div><span>SGST</span><span>{inr(live.sgstPaise, 2)}</span></div></>}
            {live.roundOffPaise !== 0 && <div><span>Round off</span><span>{inr(live.roundOffPaise, 2)}</span></div>}
            <div className="grand"><span>Total</span><span>{inr(live.totalPaise, 2)}</span></div>
            {inv.status === 'issued' && <><div><span>Paid</span><span>{inr(inv.paidPaise, 2)}</span></div><div><b>Due</b><b>{inr(due, 2)}</b></div></>}
          </div>
        </div>
        <div className="card">
          <h2>Billed to</h2>
          <div className="small"><b>{inv.customerName}</b></div>
          <div className="field" style={{ marginTop: 10 }}><label htmlFor="i-g">Customer GSTIN (optional)</label><input id="i-g" className="input" disabled={!draft} maxLength={15} style={{ textTransform: 'uppercase' }} value={f.gstin} onChange={(e) => { const g = e.target.value.toUpperCase(); setF({ ...f, gstin: g, place: inv.states[g.slice(0, 2)] && g.length >= 2 ? g.slice(0, 2) : f.place }); }} /></div>
          <div className="field"><label htmlFor="i-a">Address</label><textarea id="i-a" className="input" rows={2} disabled={!draft} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
          <div className="field"><label htmlFor="i-p">Place of supply</label><select id="i-p" className="input" disabled={!draft} value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })}>{Object.entries(inv.states).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></div>
          <div className="field"><label htmlFor="i-d">Due date</label><input id="i-d" className="input" type="date" disabled={!draft} value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></div>
          <div className="field"><label htmlFor="i-n">Notes</label><textarea id="i-n" className="input" rows={2} disabled={!draft} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label htmlFor="i-t">Terms</label><textarea id="i-t" className="input" rows={2} disabled={!draft} value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} /></div>
        </div>
      </div>
      {inv.payments.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Payments</h2>
          {inv.payments.map((p) => (
            <div key={p.id} className="org-head" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)', opacity: p.isVoided ? 0.55 : 1 }}>
              <span><b>{inr(p.amountPaise, 2)}</b> <span className="small muted">{p.mode}{p.reference ? ` · ${p.reference}` : ''} · {when(p.receivedAt)}{p.isVoided ? ` · voided: ${p.voidReason}` : ''}</span></span>
              {!p.isVoided && inv.canEdit && <button className="btn sm ghost" onClick={async () => { const reason = await askText('Why is this payment being voided?'); if (reason) run(() => api(`/api/v1/payments/${p.id}/void`, { method: 'POST', body: { reason } }), 'Payment voided.'); }}>Void</button>}
            </div>
          ))}
        </div>
      )}
      {pay && (
        <div className="modal-bg">
          <form className="modal" onSubmit={record}>
            <h2>Record payment</h2>
            <p className="small muted">{inr(due, 2)} is due.</p>
            <div className="field"><label htmlFor="p-a">Amount ₹</label><input id="p-a" className="input" required inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></div>
            <div className="field"><label htmlFor="p-m">Mode</label><select id="p-m" className="input" value={pay.mode} onChange={(e) => setPay({ ...pay, mode: e.target.value })}>{[['upi', 'UPI'], ['bank', 'Bank transfer'], ['card', 'Card'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['online', 'Online']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div className="field"><label htmlFor="p-r">Reference (optional)</label><input id="p-r" className="input" maxLength={80} value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setPay(null)}>Go back</button><button className="btn" disabled={busy}>Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
