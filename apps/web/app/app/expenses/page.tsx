'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askText } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';
import { Menu } from '@/components/Menu';
import { istDay } from '@/lib/ist';
import { inr, toPaise } from '@/lib/money';

interface Cat { id: string; name: string }
interface Exp { id: string; categoryId: string; workspaceId: string | null; spentAt: string; amountPaise: number; gstPaise: number; vendor: string | null; description: string; mode: string; reference: string | null; isVoided: boolean; voidReason: string | null; category: { name: string } }
interface Data { rows: Exp[]; totalPaise: number; gstPaise: number; canOrgWide: boolean }
type Draft = { id: string | null; categoryId: string; spentOn: string; amount: string; gst: string; vendor: string; description: string; mode: string; reference: string; orgWide: boolean };

const MODES: [string, string][] = [['bank', 'Bank transfer'], ['upi', 'UPI'], ['card', 'Card'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['online', 'Online']];
const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

export default function ExpensesPage() {
  const { version } = useShell();
  const today = istDay(new Date());
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [cats, setCats] = useState<Cat[]>([]);
  const [d, setD] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const params = useCallback(() => new URLSearchParams({ from, to, ...(cat ? { categoryId: cat } : {}), ...(q.trim() ? { q: q.trim() } : {}) }), [from, to, cat, q]);
  const load = useCallback(() => { if (from && to) api<Data>(`/api/v1/expenses?${params()}`).then(setData).catch((e) => setMsg({ type: 'error', text: e.message })); }, [from, to, params]);
  const loadCats = useCallback(() => api<Cat[]>('/api/v1/expense-categories').then(setCats).catch(() => setCats([])), []);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, version]);
  useEffect(() => { loadCats(); }, [loadCats, version]);

  const run = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; } };
  const blank = (): Draft => ({ id: null, categoryId: cats[0]?.id ?? '', spentOn: today, amount: '', gst: '', vendor: '', description: '', mode: 'bank', reference: '', orgWide: false });
  const open = (e: Exp): Draft => ({ id: e.id, categoryId: e.categoryId, spentOn: istDay(new Date(e.spentAt)), amount: String(e.amountPaise / 100), gst: e.gstPaise ? String(e.gstPaise / 100) : '', vendor: e.vendor ?? '', description: e.description, mode: e.mode, reference: e.reference ?? '', orgWide: e.workspaceId === null });
  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!d) return;
    const amountPaise = toPaise(d.amount.replace(/,/g, '')), gstPaise = toPaise(d.gst.replace(/,/g, '') || '0');
    if (!amountPaise || amountPaise < 1 || gstPaise === null || Number.isNaN(gstPaise)) { setMsg({ type: 'error', text: 'Enter the amounts as numbers, for example 1180.50' }); return; }
    const body = { categoryId: d.categoryId, spentOn: d.spentOn, amountPaise, gstPaise, vendor: d.vendor.trim() || null, description: d.description, mode: d.mode, reference: d.reference.trim() || null, orgWide: d.orgWide };
    if (await run(() => (d.id ? api(`/api/v1/expenses/${d.id}`, { method: 'PUT', body }) : api('/api/v1/expenses', { method: 'POST', body })), 'Expense saved.')) setD(null);
  }
  const addCat = async () => { const name = await askText('New category name'); if (!name || !d) return; try { const c = await api<Cat>('/api/v1/expense-categories', { method: 'POST', body: { name } }); await loadCats(); setD({ ...d, categoryId: c.id }); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } };
  const download = async () => { try { const b = await api<Blob>(`/api/v1/expenses.csv?${params()}`); const u = URL.createObjectURL(new Blob([b], { type: 'text/csv' })); const a = document.createElement('a'); a.href = u; a.download = `expenses-${from}-to-${to}.csv`; a.click(); URL.revokeObjectURL(u); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } };

  return (
    <>
      <div className="page-head">
        <div><h1>Expenses</h1><div className="muted small">Costs by business line. Choose &ldquo;All business lines&rdquo; to see every line you can access.</div></div>
        <div className="row"><button className="btn outline" onClick={download}>Download</button><button className="btn" disabled={!cats.length} onClick={() => { setMsg(null); setD(blank()); }}><Icon name="plus" className="ic" />Add expense</button></div>
      </div>
      {msg && !d && <div className={msg.type}>{msg.text}</div>}
      <div className="card exp-filters">
        <input className="input" type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        <select className="input" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input className="input" aria-label="Search expenses" placeholder="Search description or vendor" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {data && <div className="grid cols-2 inv-sum"><div className="card kpi"><div className="label">Total spent</div><div className="value">{inr(data.totalPaise)}</div></div><div className="card kpi"><div className="label">GST included</div><div className="value">{inr(data.gstPaise)}</div></div></div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Vendor</th><th style={{ textAlign: 'right' }}>Amount</th><th /></tr></thead>
            <tbody>
              {data?.rows.map((e) => (
                <tr key={e.id} style={e.isVoided ? { opacity: 0.55 } : undefined}>
                  <td className="small">{day(e.spentAt)}</td>
                  <td>{e.description}{e.workspaceId === null && <span className="badge grey" style={{ marginLeft: 6 }}>Organization</span>}{e.isVoided && <div className="small muted">Voided: {e.voidReason}</div>}</td>
                  <td className="small">{e.category.name}</td>
                  <td className="small">{e.vendor ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}><b>{inr(e.amountPaise, 2)}</b></td>
                  <td style={{ textAlign: 'right' }}>{!e.isVoided && <Menu sm items={[{ label: 'Edit', icon: 'edit', onClick: () => { setMsg(null); setD(open(e)); } }, { label: 'Void', icon: 'close', onClick: async () => { const reason = await askText('Why is this expense being voided?'); if (reason) run(() => api(`/api/v1/expenses/${e.id}/void`, { method: 'POST', body: { reason } }), 'Expense voided.'); } }]} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.rows.length && <div className="empty">No expenses in this period.</div>}
        </div>
      </div>
      {d && (
        <div className="modal-bg">
          <form className="modal book-modal" onSubmit={save}>
            <h2>{d.id ? 'Edit expense' : 'Add expense'}</h2>
            {msg?.type === 'error' && <div className="error">{msg.text}</div>}
            <div className="field"><label htmlFor="x-d">What was it for?</label><input id="x-d" className="input" required minLength={2} maxLength={300} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></div>
            <div className="book-nums">
              <div className="field"><label htmlFor="x-a">Amount paid ₹</label><input id="x-a" className="input" required inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} /></div>
              <div className="field"><label htmlFor="x-g">GST included ₹ (optional)</label><input id="x-g" className="input" inputMode="decimal" value={d.gst} onChange={(e) => setD({ ...d, gst: e.target.value })} /></div>
              <div className="field"><label htmlFor="x-o">Date</label><input id="x-o" className="input" type="date" required value={d.spentOn} onChange={(e) => setD({ ...d, spentOn: e.target.value })} /></div>
              <div className="field"><label htmlFor="x-c">Category <button type="button" className="exp-add" onClick={addCat}>Add new</button></label><select id="x-c" className="input" required value={d.categoryId} onChange={(e) => setD({ ...d, categoryId: e.target.value })}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div className="field"><label htmlFor="x-v">Vendor (optional)</label><input id="x-v" className="input" maxLength={120} value={d.vendor} onChange={(e) => setD({ ...d, vendor: e.target.value })} /></div>
              <div className="field"><label htmlFor="x-m">Paid by</label><select id="x-m" className="input" value={d.mode} onChange={(e) => setD({ ...d, mode: e.target.value })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            </div>
            <div className="field"><label htmlFor="x-r">Reference (optional)</label><input id="x-r" className="input" maxLength={80} value={d.reference} onChange={(e) => setD({ ...d, reference: e.target.value })} /></div>
            {data?.canOrgWide && !d.id && <label className="row small" style={{ marginBottom: 14 }}><input type="checkbox" checked={d.orgWide} onChange={(e) => setD({ ...d, orgWide: e.target.checked })} /> Organization-wide cost, not for one business line</label>}
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setD(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
