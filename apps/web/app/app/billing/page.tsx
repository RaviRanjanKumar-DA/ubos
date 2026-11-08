'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, rupees } from '@/lib/api';
import { useShell } from '@/components/AppShell';

type Cycle = 'quarterly' | 'annual';
interface LicenceProduct { code: string; name: string; description: string | null; planCode: string; monthlyPaise: number; quarterlyPaise: number; annualPaise: number; annualDiscountPct: number; features: string[]; recordingRetentionDays: number }
interface Service { code: string; name: string; description: string | null; pricePaise: number }
interface Catalog {
  gstPct: number; licences: LicenceProduct[]; services: Service[];
  subscription: { plan: string; planCode: string; status: string; licences: number; used: number; expiresAt: string; trialEndsAt: string | null } | null;
}
interface OrderItem { productCode: string; name: string; kind: string; quantity: number; unitPaise: number; amountPaise: number }
interface Order {
  id: string; number: string; cycle: string; items: OrderItem[]; subtotalPaise: number; gstPaise: number; totalPaise: number;
  status: 'pending' | 'paid' | 'cancelled'; createdAt: string; paidAt: string | null; paymentRef: string | null; note: string | null;
}
const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const STATUS_BADGE: Record<Order['status'], string> = { pending: 'warn', paid: 'ok', cancelled: 'grey' };

export default function BillingPage() {
  const { can } = useShell();
  const [tab, setTab] = useState<'buy' | 'history'>('buy');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadCatalog = useCallback(() => api<Catalog>('/api/v1/billing/catalog', { noWorkspace: true }).then(setCatalog).catch((e) => setError(e.message)), []);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  if (!can('org.billing.manage')) return <div className="notice">Only people with billing access can buy licences or see transactions.</div>;
  const sub = catalog?.subscription;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Billing &amp; licences</h1>
          {sub && (
            <div className="small muted">
              {sub.plan} · {sub.used} of {sub.licences} licences used · {sub.status === 'trialing' ? `trial ends ${fmt(sub.trialEndsAt ?? sub.expiresAt)}` : `valid till ${fmt(sub.expiresAt)}`}
            </div>
          )}
        </div>
      </div>
      <div className="row" style={{ gap: 2, marginBottom: 14, borderBottom: '1px solid var(--line)' }}>
        {([['buy', 'Buy licences'], ['history', 'Transaction history']] as const).map(([k, l]) => (
          <button key={k} className="btn ghost" onClick={() => { setTab(k); setNotice(''); }}
            style={{ borderRadius: 0, borderBottom: tab === k ? '2px solid var(--brand)' : '2px solid transparent', color: tab === k ? 'var(--brand)' : undefined }}>{l}</button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {tab === 'buy' && catalog && <Buy catalog={catalog} onOrdered={(n) => { setNotice(`Order ${n} placed. It becomes active as soon as the payment is confirmed — see Transaction history.`); setTab('history'); loadCatalog(); }} />}
      {tab === 'history' && <History />}
    </>
  );
}

function Buy({ catalog, onOrdered }: { catalog: Catalog; onOrdered: (number: string) => void }) {
  const [cycle, setCycle] = useState<Cycle>('annual');
  const [plan, setPlan] = useState(catalog.licences.find((l) => l.planCode === catalog.subscription?.planCode)?.code ?? catalog.licences[0]?.code ?? '');
  const [qty, setQty] = useState(Math.max(1, catalog.subscription?.status === 'trialing' ? catalog.subscription.used : 1));
  const [services, setServices] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const months = cycle === 'annual' ? 12 : 3;
  const lic = catalog.licences.find((l) => l.code === plan);
  const unit = lic ? (cycle === 'annual' ? lic.annualPaise : lic.quarterlyPaise) : 0;
  const lines = [
    ...(lic && qty > 0 ? [{ code: lic.code, name: `${lic.name} · ${qty} user(s) × ${months} months`, amount: unit * qty, quantity: qty }] : []),
    ...catalog.services.filter((s) => services[s.code]).map((s) => ({ code: s.code, name: `${s.name}${services[s.code] > 1 ? ` × ${services[s.code]}` : ''}`, amount: s.pricePaise * services[s.code], quantity: services[s.code] })),
  ];
  const subtotal = lines.reduce((n, l) => n + l.amount, 0);
  const gst = Math.round((subtotal * catalog.gstPct) / 100);

  async function place() {
    setBusy(true); setError('');
    try {
      const o = await api<Order>('/api/v1/billing/orders', { method: 'POST', noWorkspace: true, body: { cycle, items: lines.map((l) => ({ productCode: l.code, quantity: l.quantity })) } });
      onOrdered(o.number);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); setBusy(false); }
  }

  return (
    <div className="billing-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 14, alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>User licences</h2>
            <div className="row" style={{ gap: 0, border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
              {(['quarterly', 'annual'] as Cycle[]).map((c) => (
                <button key={c} className={`btn sm ${cycle === c ? '' : 'ghost'}`} style={{ borderRadius: 0 }} onClick={() => setCycle(c)}>
                  {c === 'annual' ? 'Annually' : 'Quarterly'}
                </button>
              ))}
            </div>
          </div>
          <p className="small muted">One licence per active user. Prices are per user, before {catalog.gstPct}% GST.</p>
          <div className="grid cols-2">
            {catalog.licences.map((l) => {
              const price = cycle === 'annual' ? l.annualPaise : l.quarterlyPaise;
              return (
                <label key={l.code} className="card" style={{ cursor: 'pointer', borderColor: plan === l.code ? 'var(--brand)' : undefined, borderWidth: plan === l.code ? 2 : 1, padding: 14 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <b>{l.name}</b>
                    <input type="radio" name="plan" checked={plan === l.code} onChange={() => setPlan(l.code)} />
                  </div>
                  {l.description && <div className="small muted" style={{ margin: '4px 0' }}>{l.description}</div>}
                  <div className="small" style={{ margin: '4px 0' }}>
                    <span style={{ opacity: l.features.includes('module.telephony') ? 1 : 0.4 }}>{l.features.includes('module.telephony') ? '✓' : '✕'} 📞 Cloud calling</span>{'  '}
                    <span style={{ opacity: l.features.includes('module.sim_calling') ? 1 : 0.4 }}>{l.features.includes('module.sim_calling') ? '✓' : '✕'} 📱 SIM calling</span>
                    {l.recordingRetentionDays > 0 && <div className="muted">Call recordings kept {l.recordingRetentionDays} days</div>}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{rupees(Math.round(price / months))}<span className="small muted" style={{ fontWeight: 500 }}> / user / month</span></div>
                  <div className="small muted">{rupees(price)} per user every {cycle === 'annual' ? 'year' : 'quarter'}{cycle === 'annual' && l.annualDiscountPct ? <> · <span style={{ color: 'var(--ok)' }}>save {l.annualDiscountPct}%</span></> : ''}</div>
                </label>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <span>Number of users</span>
            <button className="btn sm outline" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Fewer">−</button>
            <input className="input" style={{ width: 80, textAlign: 'center' }} type="number" min={1} max={10000} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(10000, Number(e.target.value) || 1)))} aria-label="Number of users" />
            <button className="btn sm outline" onClick={() => setQty(qty + 1)} aria-label="More">+</button>
            {catalog.subscription && <span className="small muted">You have {catalog.subscription.licences} today ({catalog.subscription.used} in use).</span>}
          </div>
        </div>

        {catalog.services.length > 0 && (
          <div className="card">
            <h2>Services</h2>
            <p className="small muted" style={{ marginTop: -6 }}>One-time help from our team. Add them to the same order.</p>
            {catalog.services.map((s) => (
              <div key={s.code} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)', flexWrap: 'nowrap' }}>
                <div style={{ minWidth: 0 }}><b>{s.name}</b>{s.description && <div className="small muted">{s.description}</div>}</div>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <span style={{ whiteSpace: 'nowrap' }}>{rupees(s.pricePaise)}</span>
                  {services[s.code]
                    ? <button className="btn sm outline" onClick={() => { const n = { ...services }; delete n[s.code]; setServices(n); }}>Remove</button>
                    : <button className="btn sm" onClick={() => setServices({ ...services, [s.code]: 1 })}>Add</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ position: 'sticky', top: 74 }}>
        <h2>Order summary</h2>
        {error && <div className="error">{error}</div>}
        {!lines.length && <p className="small muted">Choose licences or services.</p>}
        {lines.map((l) => (
          <div key={l.code} className="row small" style={{ justifyContent: 'space-between', padding: '4px 0', flexWrap: 'nowrap' }}>
            <span>{l.name}</span><span style={{ whiteSpace: 'nowrap' }}>{rupees(l.amount)}</span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid var(--line)', margin: '8px 0', paddingTop: 8 }}>
          <div className="row small" style={{ justifyContent: 'space-between' }}><span>Subtotal</span><span>{rupees(subtotal)}</span></div>
          <div className="row small" style={{ justifyContent: 'space-between' }}><span>GST ({catalog.gstPct}%)</span><span>{rupees(gst)}</span></div>
          <div className="row" style={{ justifyContent: 'space-between', fontWeight: 700, fontSize: 16, marginTop: 6 }}><span>Total</span><span>{rupees(subtotal + gst)}</span></div>
        </div>
        <button className="btn" style={{ width: '100%' }} disabled={!lines.length || busy} onClick={place}>{busy ? 'Placing…' : 'Place order'}</button>
        <p className="small muted" style={{ marginTop: 8 }}>Online payment is not connected yet. After you place the order, pay by bank transfer / UPI; licences are added as soon as the payment is confirmed.</p>
      </div>
      <style>{`@media (max-width: 900px) { .billing-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function History() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [f, setF] = useState({ status: '', cycle: '', from: '', to: '' });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    api<Order[]>(`/api/v1/billing/orders${qs ? `?${qs}` : ''}`, { noWorkspace: true }).then(setOrders).catch((e) => setError(e.message));
  }, [f]);
  useEffect(() => { load(); }, [load]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function cancel(o: Order) {
    if (!confirm(`Cancel order ${o.number}?`)) return;
    try { await api(`/api/v1/billing/orders/${o.id}/cancel`, { method: 'POST', noWorkspace: true }); load(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
  }

  return (
    <>
      <div className="card row" style={{ padding: 12, marginBottom: 12, gap: 8 }}>
        <select className="input" style={{ width: 'auto' }} value={f.status} onChange={set('status')} aria-label="Status">
          <option value="">All statuses</option><option value="pending">Pending payment</option><option value="paid">Paid</option><option value="cancelled">Cancelled</option>
        </select>
        <select className="input" style={{ width: 'auto' }} value={f.cycle} onChange={set('cycle')} aria-label="Billing cycle">
          <option value="">Any cycle</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option><option value="one_time">Services only</option>
        </select>
        <label className="row small" style={{ gap: 4 }}>From <input className="input" type="date" value={f.from} onChange={set('from')} /></label>
        <label className="row small" style={{ gap: 4 }}>To <input className="input" type="date" value={f.to} onChange={set('to')} /></label>
        {Object.values(f).some(Boolean) && <button className="btn sm ghost" onClick={() => setF({ status: '', cycle: '', from: '', to: '' })}>Clear</button>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 720 }}>
            <thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Cycle</th><th>Total (incl. GST)</th><th>Status</th><th /></tr></thead>
            <tbody>
              {orders?.map((o) => [
                <tr key={o.id} className="clickable" onClick={() => setOpen(open === o.id ? null : o.id)}>
                  <td><b>{o.number}</b></td>
                  <td className="small">{fmt(o.createdAt)}</td>
                  <td className="small">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</td>
                  <td className="small">{o.cycle === 'one_time' ? 'One-time' : o.cycle === 'annual' ? 'Annual' : 'Quarterly'}</td>
                  <td>{rupees(o.totalPaise)}</td>
                  <td><span className={`badge ${STATUS_BADGE[o.status]}`}>{o.status === 'pending' ? 'Pending payment' : o.status === 'paid' ? 'Paid' : 'Cancelled'}</span>
                    {o.paidAt && <div className="small muted">{fmt(o.paidAt)}</div>}</td>
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>{o.status === 'pending' && <button className="btn sm ghost" onClick={() => cancel(o)}>Cancel</button>}</td>
                </tr>,
                open === o.id && (
                  <tr key={`${o.id}-d`}>
                    <td colSpan={7} style={{ background: '#faf9fd' }}>
                      {o.items.map((i) => (
                        <div key={i.productCode} className="row small" style={{ justifyContent: 'space-between', maxWidth: 520 }}>
                          <span>{i.quantity} × {i.name} @ {rupees(i.unitPaise)}</span><span>{rupees(i.amountPaise)}</span>
                        </div>
                      ))}
                      <div className="row small" style={{ justifyContent: 'space-between', maxWidth: 520, marginTop: 4 }}><span>Subtotal · GST</span><span>{rupees(o.subtotalPaise)} · {rupees(o.gstPaise)}</span></div>
                      {o.paymentRef && <div className="small muted">Payment reference: {o.paymentRef}</div>}
                      {o.note && <div className="small muted">Note: {o.note}</div>}
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
          {orders && !orders.length && <div className="empty">No transactions yet.</div>}
          {!orders && !error && <div className="empty">Loading…</div>}
        </div>
      </div>
    </>
  );
}
