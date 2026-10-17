'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, platformApi, rupees } from '@/lib/api';
import { Icon } from '@/components/Icon';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  industry: string | null;
  isInternal: boolean;
  plan: string;
  planCode: string;
  licences: number;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  users: number;
  workspaces: number;
  mrrPaise: number;
}
interface Metrics { mrrPaise: number; arrPaise: number; tenants: number; paying: number; trials: number; suspended: number; users: number }
interface Plan { code: string; name: string; pricePerUserPaise: number; maxWorkspaces: number | null }

export default function ConsolePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<'tenants' | 'orders'>('tenants');

  const load = useCallback(async () => {
    try {
      const meRes = await platformApi<{ name: string }>('/platform/v1/auth/me');
      setName(meRes.name);
      const [t, m, p] = await Promise.all([
        platformApi<Tenant[]>('/platform/v1/tenants'),
        platformApi<Metrics>('/platform/v1/metrics'),
        platformApi<Plan[]>('/platform/v1/plans'),
      ]);
      setTenants(t);
      setMetrics(m);
      setPlans(p);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        return router.replace('/console/login');
      }
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function setStatus(t: Tenant, status: 'active' | 'suspended') {
    if (status === 'suspended' && !confirm(`Suspend ${t.name}? Their users will be locked out until you reactivate.`)) return;
    try {
      await platformApi(`/platform/v1/tenants/${t.id}/status`, { method: 'PATCH', body: { status } });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  const statusBadge = (t: Tenant) =>
    t.status === 'suspended' ? <span className="badge bad">Suspended</span>
    : t.subscriptionStatus === 'trialing' ? <span className="badge warn">Trial</span>
    : <span className="badge ok"><span className="dot" />Active</span>;

  return (
    <div style={{ minHeight: '100vh' }}>
      <header className="topbar">
        <div className="brand" style={{ padding: 0 }}><span className="logo">U</span> Platform Console</div>
        <div className="spacer" />
        <span className="small muted hide-sm">{name}</span>
        <button className="btn ghost sm" title="Sign out" onClick={async () => { await platformApi('/platform/v1/auth/logout', { method: 'POST' }).catch(() => undefined); router.replace('/console/login'); }}>
          <Icon name="logout" />
        </button>
      </header>
      <div className="content" style={{ margin: '0 auto' }}>
        <div className="page-head">
          <div>
            <h1>{view === 'orders' ? 'Orders & payments' : 'Organizations'}</h1>
            <div className="muted small">{view === 'orders' ? 'Licence and service orders from every organization. Confirm a payment to apply it.' : 'Every company using UBOS, including your own (Tenant #1).'}</div>
          </div>
          <button className="btn" onClick={() => setAdding(true)}>+ Onboard company</button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ gap: 2, marginBottom: 14, borderBottom: '1px solid var(--line)' }}>
          {([['tenants', 'Organizations'], ['orders', 'Orders & payments']] as const).map(([k, l]) => (
            <button key={k} className="btn ghost" onClick={() => setView(k)}
              style={{ borderRadius: 0, borderBottom: view === k ? '2px solid var(--brand)' : '2px solid transparent', color: view === k ? 'var(--brand)' : undefined }}>{l}</button>
          ))}
        </div>
        {view === 'orders' && <Orders onChanged={load} />}
        {view === 'tenants' && <>
        {metrics && (
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div className="card kpi"><div className="label">MRR</div><div className="value">{rupees(metrics.mrrPaise)}</div></div>
            <div className="card kpi"><div className="label">ARR</div><div className="value">{rupees(metrics.arrPaise)}</div></div>
            <div className="card kpi"><div className="label">Organizations</div><div className="value">{metrics.tenants}</div><div className="small muted">{metrics.paying} paying · {metrics.trials} on trial</div></div>
            <div className="card kpi"><div className="label">Users across tenants</div><div className="value">{metrics.users}</div></div>
          </div>
        )}
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Organization</th><th>Plan</th><th>Status</th><th>Workspaces</th><th>Users</th><th>MRR</th><th /></tr></thead>
              <tbody>
                {tenants?.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <b>{t.name}</b> {t.isInternal && <span className="badge" style={{ marginLeft: 4 }}>Tenant #1 · yours</span>}
                      <div className="small muted">{t.slug}.ubos.app · {t.industry ?? '—'}</div>
                    </td>
                    <td>{t.plan}</td>
                    <td>
                      {statusBadge(t)}
                      {t.trialEndsAt && t.subscriptionStatus === 'trialing' && (
                        <div className="small muted">ends {new Date(t.trialEndsAt).toLocaleDateString('en-IN')}</div>
                      )}
                    </td>
                    <td>{t.workspaces}</td>
                    <td>{t.users}</td>
                    <td>{t.mrrPaise ? rupees(t.mrrPaise) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!t.isInternal && (t.status === 'suspended'
                        ? <button className="btn sm outline" onClick={() => setStatus(t, 'active')}>Reactivate</button>
                        : <button className="btn sm danger" onClick={() => setStatus(t, 'suspended')}>Suspend</button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!tenants && !error && <div className="empty">Loading…</div>}
          </div>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          MRR counts paid, non-internal subscriptions only. Billing, invoices and usage metering arrive in Phase 3.
        </p>
        </>}
      </div>
      {adding && <Onboard plans={plans} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </div>
  );
}

function Onboard({ plans, onClose, onDone }: { plans: Plan[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', slug: '', industry: '', planCode: 'growth', adminName: '', adminEmail: '', adminPassword: '', workspaces: 'Sales' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const plan = plans.find((p) => p.code === f.planCode);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await platformApi('/platform/v1/tenants', {
        method: 'POST',
        body: {
          ...f,
          slug: f.slug || undefined,
          industry: f.industry || undefined,
          workspaces: f.workspaces.split(',').map((w) => w.trim()).filter(Boolean),
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Onboard a new company</h2>
        {error && <div className="error">{error}</div>}
        <div className="grid cols-2">
          <div className="field"><label>Company name</label><input className="input" value={f.name} onChange={set('name')} required /></div>
          <div className="field"><label>Organization code</label><input className="input" value={f.slug} onChange={set('slug')} placeholder="auto from name" /></div>
          <div className="field"><label>Industry</label><input className="input" value={f.industry} onChange={set('industry')} placeholder="e.g. education" /></div>
          <div className="field">
            <label>Plan</label>
            <select className="input" value={f.planCode} onChange={set('planCode')}>
              {plans.map((p) => <option key={p.code} value={p.code}>{p.name}{p.pricePerUserPaise ? ` · ${rupees(p.pricePerUserPaise)}/user` : ''}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Workspaces / business lines (comma separated)</label>
          <input className="input" value={f.workspaces} onChange={set('workspaces')} placeholder="Education, Real Estate" />
          <span className="small muted">{plan?.maxWorkspaces ? `${plan.name} allows up to ${plan.maxWorkspaces}` : 'Unlimited on this plan'}</span>
        </div>
        <div className="grid cols-2">
          <div className="field"><label>Admin name</label><input className="input" value={f.adminName} onChange={set('adminName')} required /></div>
          <div className="field"><label>Admin email</label><input className="input" type="email" value={f.adminEmail} onChange={set('adminEmail')} required /></div>
        </div>
        <div className="field"><label>Temporary admin password</label><input className="input" type="password" value={f.adminPassword} onChange={set('adminPassword')} minLength={10} required /></div>
        <p className="small muted">Starts a 14-day trial with default roles, the integrations catalogue and one pipeline per workspace.</p>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create organization'}</button>
        </div>
      </form>
    </div>
  );
}

interface PlatformOrder {
  id: string; number: string; cycle: string; status: 'pending' | 'paid' | 'cancelled'; totalPaise: number; createdAt: string; paidAt: string | null; paymentRef: string | null;
  items: { name: string; quantity: number; kind: string }[]; tenant: { id: string; name: string; slug: string } | null;
}
interface Product { id: string; code: string; name: string; kind: string; planCode: string | null; priceMonthlyPaise: number | null; priceOncePaise: number | null; annualDiscountPct: number; isActive: boolean }

/** Orders placed by organizations; the Platform Owner confirms the payment, which applies the licences. */
function Orders({ onChanged }: { onChanged: () => void }) {
  const [orders, setOrders] = useState<PlatformOrder[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'' | 'pending' | 'paid' | 'cancelled'>('pending');
  const [paying, setPaying] = useState<PlatformOrder | null>(null);
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    platformApi<PlatformOrder[]>('/platform/v1/orders').then(setOrders).catch((e) => setError(e.message));
    platformApi<Product[]>('/platform/v1/products').then(setProducts).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  const shown = orders?.filter((o) => !status || o.status === status) ?? [];

  async function markPaid(e: React.FormEvent) {
    e.preventDefault();
    if (!paying) return;
    try {
      await platformApi(`/platform/v1/orders/${paying.id}/mark-paid`, { method: 'POST', body: { paymentRef: ref } });
      setPaying(null); setRef(''); load(); onChanged();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed'); }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        {(['pending', 'paid', 'cancelled', ''] as const).map((s) => (
          <button key={s || 'all'} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>
            {s === '' ? 'All' : s === 'pending' ? 'Waiting for payment' : s === 'paid' ? 'Paid' : 'Cancelled'}
            {s && orders && <span className="count">{orders.filter((o) => o.status === s).length}</span>}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0, marginBottom: 14 }}>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 760 }}>
            <thead><tr><th>Order</th><th>Organization</th><th>Items</th><th>Total</th><th>Status</th><th /></tr></thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id}>
                  <td><b>{o.number}</b><div className="small muted">{new Date(o.createdAt).toLocaleDateString('en-IN')} · {o.cycle.replace('_', '-')}</div></td>
                  <td>{o.tenant?.name ?? '—'}<div className="small muted">{o.tenant?.slug}</div></td>
                  <td className="small">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</td>
                  <td>{rupees(o.totalPaise)}</td>
                  <td>
                    <span className={`badge ${o.status === 'paid' ? 'ok' : o.status === 'pending' ? 'warn' : 'grey'}`}>{o.status}</span>
                    {o.paymentRef && <div className="small muted">ref {o.paymentRef}</div>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{o.status === 'pending' && <button className="btn sm" onClick={() => setPaying(o)}>Mark paid</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {orders && !shown.length && <div className="empty">No orders here.</div>}
        </div>
      </div>
      <div className="card">
        <h2>Products &amp; prices</h2>
        <p className="small muted" style={{ marginTop: -6 }}>What organizations can buy from their Billing page. Prices before GST.</p>
        <table className="table">
          <thead><tr><th>Product</th><th>Type</th><th>Price</th><th>Status</th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b><div className="small muted"><code>{p.code}</code>{p.planCode ? ` · plan ${p.planCode}` : ''}</div></td>
                <td className="small">{p.kind === 'licence' ? 'User licence' : 'Service'}</td>
                <td className="small">{p.kind === 'licence' ? `${rupees(p.priceMonthlyPaise ?? 0)} / user / month${p.annualDiscountPct ? ` · ${p.annualDiscountPct}% off annually` : ''}` : rupees(p.priceOncePaise ?? 0)}</td>
                <td>{p.isActive ? <span className="badge ok">On sale</span> : <span className="badge grey">Hidden</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {paying && (
        <div className="modal-bg" onClick={() => setPaying(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={markPaid}>
            <h2>Confirm payment · {paying.number}</h2>
            <p className="small">{paying.tenant?.name} · {rupees(paying.totalPaise)}. Licence lines switch the plan, add the licences and extend validity by the billing cycle.</p>
            <div className="field"><label>Payment reference (UTR / UPI / receipt no.)</label><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} required minLength={2} autoFocus /></div>
            <div className="row end">
              <button type="button" className="btn ghost" onClick={() => setPaying(null)}>Cancel</button>
              <button className="btn">Mark paid</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
