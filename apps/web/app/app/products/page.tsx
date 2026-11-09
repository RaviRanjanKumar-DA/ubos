'use client';

import { Icon } from '@/components/Icon';
import { PickWorkspace } from '@/components/PickWorkspace';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { inr, toPaise } from '@/lib/money';
import type { PriceList, Product } from '@/components/deals/DealsPanel';

type Tab = 'products' | 'prices' | 'rules' | 'quotes';
interface Rule { name: string; minAmountPaise: number | null; maxAmountPaise: number | null; packageIds: string[]; action: 'new_sale' | 'instalment' }

/** Products & packages of the business line, its price lists, payment rules and quote settings. */
export default function ProductsPage() {
  const { me, can, version } = useShell();
  const ws = me.currentWorkspaceId;
  const wsName = me.workspaces.find((w) => w.id === ws)?.name;
  const [tab, setTab] = useState<Tab>('products');
  const [products, setProducts] = useState<Product[]>([]);
  const [archived, setArchived] = useState<Product[]>([]);
  const [lists, setLists] = useState<PriceList[]>([]);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const manage = can('crm.product.manage');

  const load = useCallback(async () => {
    if (!ws) return;
    const [p, a, l] = await Promise.all([
      api<Product[]>('/api/v1/products').catch(() => []),
      api<Product[]>('/api/v1/products?archived=true').catch(() => []),
      api<PriceList[]>('/api/v1/price-lists').catch(() => []),
    ]);
    setProducts(p); setArchived(a); setLists(l);
  }, [ws]);
  useEffect(() => { load(); }, [load, version]);

  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  };

  if (!ws) return (
    <>
      <div className="page-head"><h1>Products & prices</h1></div>
      <PickWorkspace text="Products, prices and payment rules belong to a business line." />
    </>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Products & prices</h1>
          <p className="muted small" style={{ margin: 0 }}>{wsName}: what you sell, at what price, and how incoming payments are treated.{!manage && ' You can view these; managers of this business line change them.'}</p>
        </div>
      </div>
      <div className="dash-tabs" role="tablist">
        {([['products', `Products & packages (${products.length})`], ['prices', `Price lists (${lists.length})`], ['rules', 'Payment rules'], ['quotes', 'Quote settings']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`dash-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {tab === 'products' && <ProductsTab products={products} archived={archived} manage={manage} act={act} />}
      {tab === 'prices' && <PriceListsTab lists={lists} products={products} manage={manage} act={act} />}
      {tab === 'rules' && <RulesTab ws={ws} products={products} act={act} />}
      {tab === 'quotes' && <QuoteSettingsTab ws={ws} act={act} />}
    </>
  );
}

type Act = (fn: () => Promise<unknown>, text: string) => Promise<boolean>;
const blank = { name: '', code: '', category: '', unit: 'unit', mrp: '', gstRate: '18', description: '', accessKind: 'none', validityDays: '', renewBeforeDays: '30', remindCustomer: false };
type AccessFields = { accessKind?: string; validityDays?: number | null; renewBeforeDays?: number; remindCustomer?: boolean };

function ProductsTab({ products, archived, manage, act }: { products: Product[]; archived: Product[]; manage: boolean; act: Act }) {
  const [form, setForm] = useState<typeof blank & { id?: string }>(blank);
  const [showArchived, setShowArchived] = useState(false);
  const edit = (p: Product) => setForm({ id: p.id, name: p.name, code: p.code ?? '', category: p.category ?? '', unit: p.unit, mrp: String(p.mrpPaise / 100), gstRate: String(p.gstRate), description: p.description ?? '', accessKind: (p as Product & AccessFields).accessKind ?? 'none', validityDays: (p as Product & AccessFields).validityDays ? String((p as Product & AccessFields).validityDays) : '', renewBeforeDays: String((p as Product & AccessFields).renewBeforeDays ?? 30), remindCustomer: (p as Product & AccessFields).remindCustomer ?? false });
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name: form.name, code: form.code || null, category: form.category || null, unit: form.unit || 'unit', mrpPaise: toPaise(form.mrp) ?? 0, gstRate: Number(form.gstRate), description: form.description || null, accessKind: form.accessKind, validityDays: form.validityDays ? Number(form.validityDays) : null, renewBeforeDays: Number(form.renewBeforeDays) || 30, remindCustomer: form.remindCustomer };
    act(() => api(form.id ? `/api/v1/products/${form.id}` : '/api/v1/products', { method: form.id ? 'PATCH' : 'POST', body }), form.id ? 'Product saved.' : 'Product added.').then((ok) => ok && setForm(blank));
  };
  const rows = showArchived ? archived : products;
  return (
    <div className={manage ? 'prod-grid' : ''}>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{showArchived ? 'Archived products' : 'Products & packages'}</h2>
          {archived.length > 0 && <button className="btn sm ghost" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Show active' : `Archived (${archived.length})`}</button>}
        </div>
        {!rows.length ? <p className="small muted">{showArchived ? 'Nothing archived.' : 'No products yet. Add what this business line sells — courses, packages, audits, services.'}</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Product</th><th>Category</th><th style={{ textAlign: 'right' }}>MRP</th><th>GST</th><th>Sold</th><th /></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.name}</b>{p.code && <span className="small muted"> · {p.code}</span>}{p.description && <div className="small muted">{p.description}</div>}</td>
                    <td className="small">{p.category ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{inr(p.mrpPaise)}<span className="small muted"> / {p.unit}</span></td>
                    <td className="small">{p.gstRate}%</td>
                    <td className="small">{(p as Product & { soldCount?: number }).soldCount ?? 0}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {manage && !showArchived && <button className="btn sm ghost" onClick={() => edit(p)}>Edit</button>}
                      {manage && <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/products/${p.id}`, { method: 'PATCH', body: { isArchived: !showArchived } }), showArchived ? 'Product restored.' : 'Product archived (kept for old quotes and sales).')}>{showArchived ? 'Restore' : 'Archive'}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {manage && (
        <form className="card" onSubmit={save}>
          <h2>{form.id ? 'Edit product' : 'Add a product'}</h2>
          <div className="field"><label>Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} placeholder="e.g. Vastu Audit — 3 BHK" /></div>
          <div className="grid cols-2">
            <div className="field"><label>Code / SKU</label><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
            <div className="field"><label>Category</label><input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} list="cats" /></div>
          </div>
          <datalist id="cats">{[...new Set(products.map((p) => p.category).filter(Boolean))].map((c) => <option key={c!} value={c!} />)}</datalist>
          <div className="grid cols-3">
            <div className="field"><label>MRP (₹)</label><input className="input" type="number" min={0} step="0.01" value={form.mrp} onChange={(e) => setForm({ ...form, mrp: e.target.value })} required /></div>
            <div className="field"><label>GST %</label><select className="input" value={form.gstRate} onChange={(e) => setForm({ ...form, gstRate: e.target.value })}>{['0', '5', '12', '18', '28'].map((g) => <option key={g}>{g}</option>)}</select></div>
            <div className="field"><label>Unit</label><input className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="unit / visit / month" /></div>
          </div>
          <div className="field"><label>Description</label><textarea className="input" style={{ height: 60, paddingTop: 8 }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className="field"><label htmlFor="p-ak">Gives access to</label><select id="p-ak" className="input" value={form.accessKind} onChange={(e) => setForm({ ...form, accessKind: e.target.value })}><option value="none">Nothing (one-off sale)</option><option value="course">A course</option><option value="software">Software</option><option value="service">A service plan</option></select></div>
          {form.accessKind !== 'none' && (
            <>
              <div className="grid cols-2">
                <div className="field"><label htmlFor="p-vd">Valid for (days)</label><input id="p-vd" className="input" type="number" min={1} max={3660} placeholder="No end date" value={form.validityDays} onChange={(e) => setForm({ ...form, validityDays: e.target.value })} /></div>
                <div className="field"><label htmlFor="p-rb">Open renewal lead before end (days)</label><input id="p-rb" className="input" type="number" min={1} max={180} value={form.renewBeforeDays} onChange={(e) => setForm({ ...form, renewBeforeDays: e.target.value })} /></div>
              </div>
              <label className="row small" style={{ marginBottom: 12 }}><input type="checkbox" checked={form.remindCustomer} onChange={(e) => setForm({ ...form, remindCustomer: e.target.checked })} /> Email the customer before it ends</label>
            </>
          )}
          <div className="row end">
            {form.id && <button type="button" className="btn ghost" onClick={() => setForm(blank)}>Cancel</button>}
            <button className="btn">{form.id ? 'Save' : 'Add product'}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function PriceListsTab({ lists, products, manage, act }: { lists: PriceList[]; products: Product[]; manage: boolean; act: Act }) {
  const [edit, setEdit] = useState<{ id?: string; name: string; isDefault: boolean; validFrom: string; validTo: string; items: Record<string, { price: string; min: string }> } | null>(null);
  const open = (l?: PriceList) => setEdit(l
    ? { id: l.id, name: l.name, isDefault: l.isDefault, validFrom: l.validFrom?.slice(0, 10) ?? '', validTo: l.validTo?.slice(0, 10) ?? '', items: Object.fromEntries(l.items.map((i) => [i.packageId, { price: String(i.pricePaise / 100), min: i.minPricePaise == null ? '' : String(i.minPricePaise / 100) }])) }
    : { name: '', isDefault: !lists.length, validFrom: '', validTo: '', items: {} });
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const items = Object.entries(edit.items).filter(([, v]) => v.price !== '').map(([packageId, v]) => ({ packageId, pricePaise: toPaise(v.price) ?? 0, minPricePaise: v.min === '' ? null : toPaise(v.min) }));
    const body = { name: edit.name, isDefault: edit.isDefault, validFrom: edit.validFrom ? new Date(edit.validFrom).toISOString() : null, validTo: edit.validTo ? new Date(`${edit.validTo}T23:59:00`).toISOString() : null, items };
    act(() => api(edit.id ? `/api/v1/price-lists/${edit.id}` : '/api/v1/price-lists', { method: edit.id ? 'PUT' : 'POST', body }), 'Price list saved.').then((ok) => ok && setEdit(null));
  };
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h2 style={{ margin: 0 }}>Price lists</h2><p className="small muted" style={{ margin: '4px 0 0' }}>Quotes use the default list (or MRP). A “lowest price” means anything below it needs a manager’s approval.</p></div>
        {manage && products.length > 0 && <button className="btn sm" onClick={() => open()}>+ New price list</button>}
      </div>
      {!lists.length && <p className="small muted">No price list yet — quotes use the MRP.</p>}
      {lists.map((l) => (
        <div key={l.id} className="run-card" style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span><b>{l.name}</b> {l.isDefault && <span className="badge ok">Default</span>} <span className="small muted">{l.validFrom || l.validTo ? `${l.validFrom ? new Date(l.validFrom).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '…'} – ${l.validTo ? new Date(l.validTo).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '…'}` : 'Always valid'}</span></span>
            <span className="row" style={{ gap: 6 }}>
              {manage && <button className="btn sm ghost" onClick={() => open(l)}>Edit</button>}
              {manage && !l.isDefault && <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/price-lists/${l.id}`, { method: 'PUT', body: { isDefault: true } }), `${l.name} is now the default.`)}>Make default</button>}
              {manage && <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/price-lists/${l.id}`, { method: 'PUT', body: { isArchived: true } }), 'Price list archived.')}>Archive</button>}
            </span>
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            {l.items.map((i) => { const p = products.find((x) => x.id === i.packageId); return p ? <span key={i.packageId} className="badge grey" style={{ marginRight: 6, marginBottom: 4 }}>{p.name}: {inr(i.pricePaise)}{i.minPricePaise != null ? ` (lowest ${inr(i.minPricePaise)})` : ''}</span> : null; })}
            {!l.items.length && <span className="muted">No prices set — MRP applies.</span>}
          </div>
        </div>
      ))}
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" style={{ maxWidth: 680, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{edit.id ? 'Edit price list' : 'New price list'}</h2>
            <div className="grid cols-3">
              <div className="field"><label>Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required minLength={2} placeholder="Standard / Diwali offer" /></div>
              <div className="field"><label>Valid from</label><input className="input" type="date" value={edit.validFrom} onChange={(e) => setEdit({ ...edit, validFrom: e.target.value })} /></div>
              <div className="field"><label>Valid to</label><input className="input" type="date" value={edit.validTo} onChange={(e) => setEdit({ ...edit, validTo: e.target.value })} /></div>
            </div>
            <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" checked={edit.isDefault} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} /> Default for new quotes</label>
            <table className="table quote-lines">
              <thead><tr><th>Product</th><th>MRP</th><th>Price (₹)</th><th>Lowest without approval (₹)</th></tr></thead>
              <tbody>
                {products.map((p) => {
                  const v = edit.items[p.id] ?? { price: '', min: '' };
                  const set = (patch: Partial<typeof v>) => setEdit({ ...edit, items: { ...edit.items, [p.id]: { ...v, ...patch } } });
                  return (
                    <tr key={p.id}>
                      <td>{p.name}</td><td className="small">{inr(p.mrpPaise)}</td>
                      <td><input className="input" type="number" min={0} step="0.01" placeholder="MRP" value={v.price} onChange={(e) => set({ price: e.target.value })} aria-label={`Price of ${p.name}`} /></td>
                      <td><input className="input" type="number" min={0} step="0.01" placeholder="No limit" value={v.min} onChange={(e) => set({ min: e.target.value })} disabled={v.price === ''} aria-label={`Lowest price of ${p.name}`} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="row end" style={{ marginTop: 12 }}><button type="button" className="btn ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

function RulesTab({ ws, products, act }: { ws: string; products: Product[]; act: Act }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    api<{ canManage: boolean; rules: Rule[] }>(`/api/v1/workspaces/${ws}/payment-rules`).then((r) => { setRules(r.rules); setCanManage(r.canManage); setDirty(false); }).catch(() => setRules([]));
  }, [ws]);
  const set = (i: number, patch: Partial<Rule>) => { setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r))); setDirty(true); };
  const move = (i: number, d: number) => { const n = [...rules]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setRules(n); setDirty(true); };
  return (
    <div className="card" style={{ maxWidth: 980 }}>
      <h2>Payment rules</h2>
      <p className="small muted" style={{ marginTop: -6 }}>
        When a payment comes in without a lead (payment gateway, bank statement, walk-in), the first matching rule decides what it is: a <b>new sale</b> (a won lead is created and its after-sale process starts)
        or an <b>instalment</b> of the customer’s running process. With no matching rule: instalment if a process is running, otherwise a new sale.
      </p>
      {rules.map((r, i) => (
        <div key={i} className="tpl-step">
          <div className="tpl-step-head">
            <span className="step-num">{i + 1}</span>
            <input className="input" value={r.name} onChange={(e) => set(i, { name: e.target.value })} disabled={!canManage} aria-label="Rule name" style={{ maxWidth: 320 }} />
            <select className="input" style={{ maxWidth: 170 }} value={r.action} onChange={(e) => set(i, { action: e.target.value as Rule['action'] })} disabled={!canManage} aria-label="Action">
              <option value="new_sale">→ New sale</option><option value="instalment">→ Instalment</option>
            </select>
            {canManage && <span className="row" style={{ gap: 2, marginLeft: 'auto' }}>
              <button className="btn sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="up" className="ic" /></button>
              <button className="btn sm ghost" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="down" className="ic" /></button>
              <button className="btn sm ghost" onClick={() => { setRules(rules.filter((_, j) => j !== i)); setDirty(true); }} aria-label="Remove rule"><Icon name="close" className="ic" /></button>
            </span>}
          </div>
          <div className="grid cols-3" style={{ marginTop: 8 }}>
            <div className="field"><label>Amount at least (₹)</label><input className="input" type="number" min={0} value={r.minAmountPaise == null ? '' : r.minAmountPaise / 100} onChange={(e) => set(i, { minAmountPaise: toPaise(e.target.value) })} disabled={!canManage} placeholder="Any" /></div>
            <div className="field"><label>Amount at most (₹)</label><input className="input" type="number" min={0} value={r.maxAmountPaise == null ? '' : r.maxAmountPaise / 100} onChange={(e) => set(i, { maxAmountPaise: toPaise(e.target.value) })} disabled={!canManage} placeholder="Any" /></div>
            <div className="field"><label>Only for these products</label>
              <div className="chips">{products.map((p) => <button type="button" key={p.id} disabled={!canManage} className={`chip ${r.packageIds.includes(p.id) ? 'on' : ''}`} onClick={() => set(i, { packageIds: r.packageIds.includes(p.id) ? r.packageIds.filter((x) => x !== p.id) : [...r.packageIds, p.id] })}>{p.name}</button>)}{!products.length && <span className="small muted">Any product</span>}</div>
            </div>
          </div>
        </div>
      ))}
      {!rules.length && <p className="small muted">No rules — the default applies.</p>}
      {canManage && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button className="btn sm ghost" onClick={() => { setRules([...rules, { name: `Rule ${rules.length + 1}`, minAmountPaise: null, maxAmountPaise: null, packageIds: [], action: 'new_sale' }]); setDirty(true); }}>+ Add rule</button>
          <button className="btn" disabled={!dirty} onClick={() => act(() => api(`/api/v1/workspaces/${ws}/payment-rules`, { method: 'PUT', body: { rules } }), 'Payment rules saved.').then((ok) => ok && setDirty(false))}>Save rules</button>
        </div>
      )}
      <IncomingTest products={products} act={act} />
    </div>
  );
}

/** Record a payment that arrived without a lead; the rules decide what happens. */
function IncomingTest({ products, act }: { products: Product[]; act: Act }) {
  const { can } = useShell();
  const [f, setF] = useState({ mobile: '', name: '', amount: '', packageId: '', mode: 'online', reference: '' });
  const [result, setResult] = useState<{ action: string; rule: string | null; leadId: string; fallback: boolean } | null>(null);
  if (!can('process.payment')) return null;
  return (
    <form style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }} onSubmit={(e) => {
      e.preventDefault();
      act(async () => {
        const r = await api<{ action: string; rule: string | null; leadId: string; fallback: boolean }>('/api/v1/payments/incoming', { method: 'POST', body: { mobile: f.mobile, name: f.name || undefined, amountPaise: toPaise(f.amount), packageId: f.packageId || null, mode: f.mode, reference: f.reference || null } });
        setResult(r);
      }, 'Payment recorded.');
    }}>
      <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>Record a payment that came in without a lead</h3>
      <div className="grid cols-3">
        <div className="field"><label>Customer mobile</label><input className="input" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} required /></div>
        <div className="field"><label>Name (if new)</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label>Amount (₹)</label><input className="input" type="number" min={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></div>
        <div className="field"><label>Product</label><select className="input" value={f.packageId} onChange={(e) => setF({ ...f, packageId: e.target.value })}><option value="">—</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div className="field"><label>Mode</label><select className="input" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{['online', 'upi', 'bank', 'card', 'cash', 'cheque'].map((m) => <option key={m}>{m}</option>)}</select></div>
        <div className="field"><label>Reference</label><input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></div>
      </div>
      <div className="row end"><button className="btn outline">Record payment</button></div>
      {result && <div className="notice">{result.action === 'new_sale' ? 'New sale' : 'Instalment'}{result.rule ? ` (rule: ${result.rule})` : ' (default)'}{result.fallback ? ' — nothing was running, so it became a new sale' : ''}. <a href={`/app/leads/${result.leadId}?tab=process`}>Open the lead →</a></div>}
    </form>
  );
}

function QuoteSettingsTab({ ws, act }: { ws: string; act: Act }) {
  const [s, setS] = useState<{ quoteMaxDiscountPct: number; quoteTerms: string | null; canManage: boolean } | null>(null);
  useEffect(() => { api<{ quoteMaxDiscountPct: number; quoteTerms: string | null; canManage: boolean }>(`/api/v1/workspaces/${ws}/quote-settings`).then(setS).catch(() => setS(null)); }, [ws]);
  if (!s) return null;
  return (
    <form className="card" style={{ maxWidth: 720 }} onSubmit={(e) => { e.preventDefault(); act(() => api(`/api/v1/workspaces/${ws}/quote-settings`, { method: 'PUT', body: { quoteMaxDiscountPct: s.quoteMaxDiscountPct, quoteTerms: s.quoteTerms || null } }), 'Quote settings saved.'); }}>
      <h2>Quote settings</h2>
      <div className="field" style={{ maxWidth: 280 }}><label>Discount allowed without approval (%)</label>
        <input className="input" type="number" min={0} max={100} value={s.quoteMaxDiscountPct} onChange={(e) => setS({ ...s, quoteMaxDiscountPct: Number(e.target.value) })} disabled={!s.canManage} />
      </div>
      <div className="field"><label>Default terms printed on quotes</label>
        <textarea className="input" style={{ height: 110, paddingTop: 8 }} value={s.quoteTerms ?? ''} onChange={(e) => setS({ ...s, quoteTerms: e.target.value })} disabled={!s.canManage} placeholder="e.g. 50% advance to start; balance before delivery. Prices exclude GST." />
      </div>
      {s.canManage && <div className="row end"><button className="btn">Save</button></div>}
    </form>
  );
}
