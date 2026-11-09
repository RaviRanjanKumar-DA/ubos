'use client';

import { useCallback, useEffect, useState } from 'react';
import { FEATURES } from '@ubos/shared';
import { ApiError, platformApi, rupees } from '@/lib/api';

export interface PlanRow {
  id: string; code: string; name: string; pricePerUserPaise: number; maxWorkspaces: number | null; storageGbPerUser: number;
  aiCreditsPerUser: number; recordingRetentionDays: number; isPublic: boolean; features: { featureKey: string }[]; organizations: number;
}
interface Product {
  id: string; code: string; name: string; description: string | null; kind: 'licence' | 'service'; planCode: string | null;
  priceMonthlyPaise: number | null; priceOncePaise: number | null; annualDiscountPct: number; isActive: boolean; position: number;
}
const toPaise = (v: string) => Math.round(Number(v || 0) * 100);
const toRupees = (p: number | null | undefined) => (p === null || p === undefined ? '' : String(p / 100));

/**
 * Plans & prices for the Platform Owner.
 * Plans (packages) decide modules and limits; products are what organizations buy on their Billing page.
 */
export function Pricing({ onChanged }: { onChanged: () => void }) {
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [editPlan, setEditPlan] = useState<PlanRow | 'new' | null>(null);
  const [editProduct, setEditProduct] = useState<Product | 'licence' | 'service' | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  const load = useCallback(() => {
    platformApi<PlanRow[]>('/platform/v1/plans').then(setPlans).catch((e) => setMsg({ type: 'error', text: e.message }));
    platformApi<Product[]>('/platform/v1/products').then(setProducts).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); load(); onChanged(); setMsg({ type: 'notice', text }); return true; } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
      return false;
    }
  };
  const planName = (code: string | null) => plans?.find((p) => p.code === code)?.name ?? code ?? '—';

  return (
    <>
      <div className="notice small" style={{ marginBottom: 12 }}>
        Price changes apply to new orders, new trials and renewals. Orders already placed keep the price they were placed at.
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div className="page-head" style={{ marginBottom: 8 }}>
        <div><h2 style={{ margin: 0 }}>Plans (packages)</h2><div className="small muted">What an organization gets: modules, limits and the list price per user.</div></div>
        <button className="btn" onClick={() => setEditPlan('new')}>+ New plan</button>
      </div>
      <div className="grid cols-4" style={{ marginBottom: 22, alignItems: 'stretch' }}>
        {plans?.map((p) => (
          <div key={p.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b style={{ fontSize: 15 }}>{p.name}</b>
              {!p.isPublic && <span className="badge grey">Hidden</span>}
            </div>
            <div><span style={{ fontSize: 22, fontWeight: 700 }}>{p.pricePerUserPaise ? rupees(p.pricePerUserPaise) : 'Custom'}</span>{p.pricePerUserPaise ? <span className="small muted"> / user / month</span> : null}</div>
            <div className="small muted">
              {p.maxWorkspaces ? `Up to ${p.maxWorkspaces} business lines` : 'Unlimited business lines'} · {p.storageGbPerUser} GB / user{p.aiCreditsPerUser ? ` · ${p.aiCreditsPerUser} AI credits` : ''}
            </div>
            <div className="small">
              {p.features.some((f) => f.featureKey === 'module.telephony') ? 'Cloud calling  ' : ''}{p.features.some((f) => f.featureKey === 'module.sim_calling') ? 'SIM calling' : ''}
              {!p.features.some((f) => ['module.telephony', 'module.sim_calling'].includes(f.featureKey)) && <span className="muted">No calling</span>}
              {p.recordingRetentionDays > 0 && <span className="muted"> · recordings {p.recordingRetentionDays} days</span>}
            </div>
            <div className="small">{p.features.length} of {Object.keys(FEATURES).length} modules</div>
            <div className="small muted">{p.organizations} organization(s) on this plan</div>
            <span style={{ flex: 1 }} />
            <button className="btn sm outline" onClick={() => setEditPlan(p)}>Edit plan</button>
          </div>
        ))}
      </div>

      <div className="page-head" style={{ marginBottom: 8 }}>
        <div><h2 style={{ margin: 0 }}>Products on sale</h2><div className="small muted">What organizations can buy on their Billing page. Prices before GST.</div></div>
        <div className="row">
          <button className="btn outline" onClick={() => setEditProduct('licence')}>+ Licence</button>
          <button className="btn outline" onClick={() => setEditProduct('service')}>+ Service</button>
        </div>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table" style={{ minWidth: 700 }}>
          <thead><tr><th>Product</th><th>Type</th><th>Price</th><th>Status</th><th /></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} style={{ opacity: p.isActive ? 1 : 0.6 }}>
                <td><b>{p.name}</b><div className="small muted"><code>{p.code}</code>{p.description ? ` · ${p.description}` : ''}</div></td>
                <td className="small">{p.kind === 'licence' ? <>User licence<div className="muted">activates {planName(p.planCode)}</div></> : 'One-time service'}</td>
                <td className="small">
                  {p.kind === 'licence'
                    ? <>{rupees(p.priceMonthlyPaise ?? 0)} / user / month{p.annualDiscountPct ? <div className="muted">{p.annualDiscountPct}% off when paid annually</div> : null}</>
                    : rupees(p.priceOncePaise ?? 0)}
                </td>
                <td>{p.isActive ? <span className="badge ok">On sale</span> : <span className="badge grey">Hidden</span>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sm ghost" onClick={() => setEditProduct(p)}>Edit</button>
                  <button className="btn sm ghost" onClick={() => save(() => platformApi(`/platform/v1/products/${p.id}`, { method: 'PATCH', body: { isActive: !p.isActive } }), p.isActive ? 'Product hidden from Billing.' : 'Product back on sale.')}>{p.isActive ? 'Hide' : 'Put on sale'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editPlan && <PlanDialog plan={editPlan === 'new' ? null : editPlan} onClose={() => setEditPlan(null)}
        onSave={async (body) => {
          const ok = await save(() => editPlan === 'new'
            ? platformApi('/platform/v1/plans', { method: 'POST', body })
            : platformApi(`/platform/v1/plans/${editPlan.code}`, { method: 'PATCH', body }), editPlan === 'new' ? 'Plan created.' : 'Plan saved.');
          if (ok) setEditPlan(null);
        }} />}
      {editProduct && plans && <ProductDialog product={typeof editProduct === 'string' ? null : editProduct} kind={typeof editProduct === 'string' ? editProduct : editProduct.kind} plans={plans}
        onClose={() => setEditProduct(null)}
        onSave={async (body) => {
          const ok = await save(() => typeof editProduct === 'string'
            ? platformApi('/platform/v1/products', { method: 'POST', body })
            : platformApi(`/platform/v1/products/${editProduct.id}`, { method: 'PATCH', body }), typeof editProduct === 'string' ? 'Product added.' : 'Product saved.');
          if (ok) setEditProduct(null);
        }} />}
    </>
  );
}

function PlanDialog({ plan, onClose, onSave }: { plan: PlanRow | null; onClose: () => void; onSave: (b: unknown) => void }) {
  const [f, setF] = useState({
    code: '', name: plan?.name ?? '', price: toRupees(plan?.pricePerUserPaise ?? 0), maxWorkspaces: plan?.maxWorkspaces ? String(plan.maxWorkspaces) : '',
    storage: String(plan?.storageGbPerUser ?? 5), ai: String(plan?.aiCreditsPerUser ?? 0), rec: String(plan?.recordingRetentionDays ?? 90), isPublic: plan?.isPublic ?? true,
    features: plan?.features.map((x) => x.featureKey) ?? ['module.crm', 'module.workspaces'], sell: true, discount: '0',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const toggle = (k: string) => setF({ ...f, features: f.features.includes(k) ? f.features.filter((x) => x !== k) : [...f.features, k] });
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 620, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            ...(plan ? {} : { code: f.code, sellAsLicence: f.sell, annualDiscountPct: Number(f.discount || 0) }),
            name: f.name, pricePerUserPaise: toPaise(f.price), maxWorkspaces: f.maxWorkspaces ? Number(f.maxWorkspaces) : null,
            storageGbPerUser: Number(f.storage || 0), aiCreditsPerUser: Number(f.ai || 0), recordingRetentionDays: Number(f.rec || 0), isPublic: f.isPublic, features: f.features,
          });
        }}>
        <h2>{plan ? `Edit plan · ${plan.name}` : 'New plan (package)'}</h2>
        {plan && plan.organizations > 0 && <div className="notice small">{plan.organizations} organization(s) use this plan. Module changes apply to them at once; the price applies to their next order or renewal.</div>}
        <div className="grid cols-2">
          <div className="field"><label>Plan name</label><input className="input" value={f.name} onChange={set('name')} placeholder="e.g. Growth Plus" required /></div>
          {plan ? <div className="field"><label>Code</label><input className="input" value={plan.code} disabled /></div>
            : <div className="field"><label>Code</label><input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} placeholder="growth_plus" required /></div>}
          <div className="field"><label>Price per user / month (₹)</label><input className="input" type="number" min={0} step="1" value={f.price} onChange={set('price')} required /><span className="small muted">0 = custom pricing</span></div>
          <div className="field"><label>Business lines allowed</label><input className="input" type="number" min={1} value={f.maxWorkspaces} onChange={set('maxWorkspaces')} placeholder="Unlimited" /></div>
          <div className="field"><label>Storage per user (GB)</label><input className="input" type="number" min={0} value={f.storage} onChange={set('storage')} /></div>
          <div className="field"><label>AI credits per user / month</label><input className="input" type="number" min={0} value={f.ai} onChange={set('ai')} /></div>
        </div>
        <div className="small" style={{ fontWeight: 600, margin: '4px 0 6px' }}>Calling</div>
        <div className="row" style={{ marginBottom: 10 }}>
          {([['', 'No calling', []], ['cloud', 'Cloud calling', ['module.telephony']], ['sim', 'SIM calling', ['module.sim_calling']], ['both', 'Both', ['module.telephony', 'module.sim_calling']]] as const).map(([k, l, keys]) => {
            const has = (x: string) => f.features.includes(x);
            const on = keys.length === 0 ? !has('module.telephony') && !has('module.sim_calling') : keys.every(has) && (k === 'both' || !has(k === 'cloud' ? 'module.sim_calling' : 'module.telephony'));
            return <button type="button" key={k} className={`chip ${on ? 'on' : ''}`} onClick={() => setF({ ...f, features: [...f.features.filter((x) => x !== 'module.telephony' && x !== 'module.sim_calling'), ...keys] })}>{l}</button>;
          })}
          <label className="row small" style={{ marginLeft: 'auto' }}>Keep recordings <input className="input" style={{ width: 80 }} type="number" min={0} max={3650} value={f.rec} onChange={set('rec')} /> days</label>
        </div>
        <div className="small" style={{ fontWeight: 600, margin: '4px 0 6px' }}>Modules included</div>
        <div className="grid cols-2" style={{ gap: 6, marginBottom: 10 }}>
          {Object.entries(FEATURES).map(([k, label]) => (
            <label key={k} className="row small" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}><input type="checkbox" checked={f.features.includes(k)} onChange={() => toggle(k)} /> {label}</label>
          ))}
        </div>
        <label className="row small"><input type="checkbox" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} /> Offer this plan to new organizations</label>
        {!plan && (
          <div className="card" style={{ padding: 10, marginTop: 10 }}>
            <label className="row small"><input type="checkbox" checked={f.sell} onChange={(e) => setF({ ...f, sell: e.target.checked })} /> Also sell it on the Billing page as a user licence at this price</label>
            {f.sell && <div className="field" style={{ marginTop: 8, maxWidth: 220 }}><label>Annual discount (%)</label><input className="input" type="number" min={0} max={90} value={f.discount} onChange={set('discount')} /></div>}
          </div>
        )}
        <div className="row end" style={{ marginTop: 12 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!f.features.length}>{plan ? 'Save plan' : 'Create plan'}</button>
        </div>
      </form>
    </div>
  );
}

function ProductDialog({ product, kind, plans, onClose, onSave }: { product: Product | null; kind: 'licence' | 'service'; plans: PlanRow[]; onClose: () => void; onSave: (b: unknown) => void }) {
  const [f, setF] = useState({
    code: '', name: product?.name ?? '', description: product?.description ?? '', planCode: product?.planCode ?? plans.find((p) => p.isPublic)?.code ?? '',
    monthly: toRupees(product?.priceMonthlyPaise), once: toRupees(product?.priceOncePaise), discount: String(product?.annualDiscountPct ?? 0),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const monthly = toPaise(f.monthly);
  const annual = Math.round((monthly * 12 * (100 - Number(f.discount || 0))) / 100);
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            ...(product ? {} : { code: f.code, kind, planCode: kind === 'licence' ? f.planCode : null }),
            name: f.name, description: f.description || null,
            ...(kind === 'licence' ? { priceMonthlyPaise: monthly, annualDiscountPct: Number(f.discount || 0) } : { priceOncePaise: toPaise(f.once) }),
          });
        }}>
        <h2>{product ? `Edit · ${product.name}` : kind === 'licence' ? 'New user licence' : 'New service'}</h2>
        <div className="grid cols-2">
          <div className="field"><label>Name</label><input className="input" value={f.name} onChange={set('name')} required /></div>
          {product ? <div className="field"><label>Code</label><input className="input" value={product.code} disabled /></div>
            : <div className="field"><label>Code</label><input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} required /></div>}
        </div>
        <div className="field"><label>Description (shown on Billing)</label><input className="input" value={f.description} onChange={set('description')} /></div>
        {kind === 'licence' ? (
          <>
            <div className="field">
              <label>Activates plan</label>
              <select className="input" value={f.planCode} onChange={set('planCode')} disabled={!!product}>
                {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
              </select>
            </div>
            <div className="grid cols-2">
              <div className="field"><label>Price per user / month (₹)</label><input className="input" type="number" min={0} value={f.monthly} onChange={set('monthly')} required /></div>
              <div className="field"><label>Annual discount (%)</label><input className="input" type="number" min={0} max={90} value={f.discount} onChange={set('discount')} /></div>
            </div>
            <p className="small muted">Quarterly: {rupees(monthly * 3)} per user · Annual: {rupees(annual)} per user (before GST)</p>
          </>
        ) : (
          <div className="field" style={{ maxWidth: 240 }}><label>One-time price (₹)</label><input className="input" type="number" min={0} value={f.once} onChange={set('once')} required /></div>
        )}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">{product ? 'Save' : 'Add product'}</button>
        </div>
      </form>
    </div>
  );
}
