'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { inr, toPaise } from '@/lib/money';

interface Link { id: string; url: string; amountPaise: number; status: string; expiresAt: string | null; paidAt: string | null; createdAt: string }
const TONE: Record<string, { label: string; tone: string }> = { created: { label: 'Open', tone: 'warn' }, paid: { label: 'Paid', tone: 'ok' }, cancelled: { label: 'Cancelled', tone: 'grey' }, expired: { label: 'Expired', tone: 'grey' } };

/** Sends the customer a link to pay this invoice online. */
export function PaymentLinks({ invoiceId, duePaise, canEdit, mobile, number, onPaid }: { invoiceId: string; duePaise: number; canEdit: boolean; mobile: string | null; number: string; onPaid: () => void }) {
  const [data, setData] = useState<{ connected: boolean; links: Link[] } | null>(null);
  const [form, setForm] = useState<{ amount: string; notify: boolean } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<NonNullable<typeof data>>(`/api/v1/invoices/${invoiceId}/payment-links`).then((d) => { setData(d); if (d.links.some((l) => l.status === 'paid')) onPaid(); }).catch(() => setData(null)), [invoiceId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  if (!data) return null;
  const run = async (fn: () => Promise<unknown>, text: string) => { setBusy(true); setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); setForm(null); await load(); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } setBusy(false); };
  const copy = async (u: string) => { try { await navigator.clipboard.writeText(u); setMsg({ type: 'notice', text: 'Link copied.' }); } catch { setMsg({ type: 'notice', text: u }); } };
  const wa = (l: Link) => `https://wa.me/${(mobile ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(`Please pay ${inr(l.amountPaise, 2)} for invoice ${number}: ${l.url}`)}`;
  const shown = data.links.slice(0, 5);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="org-head"><h2 style={{ margin: 0 }}>Pay online</h2>{canEdit && duePaise > 0 && data.connected && !form && <button className="btn sm" onClick={() => setForm({ amount: String(duePaise / 100), notify: false })}>Create payment link</button>}</div>
      {msg && <div className={msg.type} style={{ marginTop: 10 }}>{msg.text}</div>}
      {!data.connected && <p className="small muted" style={{ marginBottom: 0 }}>Connect Razorpay in Integrations to send payment links.</p>}
      {form && (
        <form className="run-card" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); run(() => api(`/api/v1/invoices/${invoiceId}/payment-link`, { method: 'POST', body: { amountPaise: toPaise(form.amount), notifyCustomer: form.notify } }), 'Payment link created.'); }}>
          <div className="field" style={{ maxWidth: 220 }}><label htmlFor="pl-a">Amount ₹</label><input id="pl-a" className="input" required inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
          <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} /> Razorpay also sends it to the customer by SMS and email</label>
          <div className="row"><button className="btn sm" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button><button type="button" className="btn sm ghost" onClick={() => setForm(null)}>Go back</button></div>
        </form>
      )}
      {shown.map((l) => (
        <div key={l.id} className="org-head" style={{ padding: '8px 0', borderTop: '1px solid var(--line)', marginTop: 8 }}>
          <span><b>{inr(l.amountPaise, 2)}</b> <span className={`badge ${TONE[l.status]?.tone ?? 'grey'}`}>{TONE[l.status]?.label ?? l.status}</span></span>
          {l.status === 'created' && (
            <span className="row">
              <button className="btn sm outline" onClick={() => copy(l.url)}>Copy link</button>
              {mobile && <a className="btn sm outline" href={wa(l)} target="_blank" rel="noreferrer">WhatsApp</a>}
              {canEdit && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api(`/api/v1/payment-links/${l.id}/cancel`, { method: 'POST' }), 'Link cancelled.')}>Cancel</button>}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
