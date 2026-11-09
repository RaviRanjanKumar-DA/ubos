'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { PickWorkspace } from '@/components/PickWorkspace';
import { inr } from '@/lib/money';

interface Row { id: string; number: string | null; status: string; customerName: string; issuedAt: string | null; dueAt: string | null; totalPaise: number; paidPaise: number; createdAt: string }
interface Data { rows: Row[]; summary: { billedPaise: number; collectedPaise: number; overduePaise: number; overdueCount: number } }
interface Profile { legalName: string; gstin: string | null; stateCode: string; address: string; email: string | null; phone: string | null; invoicePrefix: string; terms: string | null; bankDetails: string | null }
interface ProfileRes { states: Record<string, string>; canEdit: boolean; profile: Profile | null }

const VIEWS: [string, string][] = [['all', 'All'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['draft', 'Drafts'], ['cancelled', 'Cancelled']];
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function statusOf(r: { status: string; totalPaise: number; paidPaise: number; dueAt: string | null }) {
  if (r.status === 'draft') return { label: 'Draft', tone: 'grey' };
  if (r.status === 'cancelled') return { label: 'Cancelled', tone: 'grey' };
  if (r.paidPaise >= r.totalPaise) return { label: 'Paid', tone: 'ok' };
  if (r.dueAt && new Date(r.dueAt) < new Date()) return { label: 'Overdue', tone: 'bad' };
  return r.paidPaise > 0 ? { label: 'Part paid', tone: 'warn' } : { label: 'Unpaid', tone: 'warn' };
}

export default function InvoicesPage() {
  const { me, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [view, setView] = useState('all');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [setup, setSetup] = useState<ProfileRes | null>(null);
  const [edit, setEdit] = useState<(Omit<Profile, 'gstin' | 'email' | 'phone' | 'terms' | 'bankDetails'> & { gstin: string; email: string; phone: string; terms: string; bankDetails: string }) | null>(null);
  const [reg, setReg] = useState<{ from: string; to: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  const load = useCallback(() => {
    if (!ws) return;
    api<Data>(`/api/v1/invoices?${new URLSearchParams({ view, ...(q.trim() ? { q: q.trim() } : {}) })}`).then(setData).catch((e) => setMsg({ type: 'error', text: e.message }));
  }, [ws, view, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, version]);
  useEffect(() => { if (ws) api<ProfileRes>('/api/v1/billing-profile').then(setSetup).catch(() => setSetup(null)); }, [ws, version]);
  if (!ws) return <><div className="page-head"><h1>Invoices</h1></div><PickWorkspace text="Invoices belong to a business line." /></>;

  const open = () => { const p = setup?.profile; setEdit({ legalName: p?.legalName ?? '', gstin: p?.gstin ?? '', stateCode: p?.stateCode ?? '', address: p?.address ?? '', email: p?.email ?? '', phone: p?.phone ?? '', invoicePrefix: p?.invoicePrefix ?? 'INV', terms: p?.terms ?? '', bankDetails: p?.bankDetails ?? '' }); };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    try {
      await api('/api/v1/billing-profile', { method: 'PUT', body: { ...edit, gstin: edit.gstin.trim() || null, email: edit.email.trim() || null, phone: edit.phone.trim() || null, terms: edit.terms.trim() || null, bankDetails: edit.bankDetails.trim() || null } });
      setMsg({ type: 'notice', text: 'Billing details saved.' }); setEdit(null);
      setSetup(await api<ProfileRes>('/api/v1/billing-profile'));
    } catch (err) { setMsg({ type: 'error', text: err instanceof ApiError ? err.message : 'Failed' }); }
  }
  async function download(e: React.FormEvent) {
    e.preventDefault();
    if (!reg) return;
    try {
      const text = await api<Blob>(`/api/v1/invoices/register.csv?${new URLSearchParams(reg)}`);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `sales-register-${reg.from}-to-${reg.to}.csv`; a.click(); URL.revokeObjectURL(url);
      setReg(null);
    } catch (err) { setMsg({ type: 'error', text: err instanceof ApiError ? err.message : 'Failed' }); }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Invoices</h1><div className="muted small">Create an invoice from the Quotes tab of a lead, then issue it here.</div></div>
        <div className="row">
          <button className="btn outline" onClick={() => setReg({ from: `${today().slice(0, 8)}01`, to: today() })}>Sales register</button>
          {setup && <button className={`btn${setup.profile ? ' outline' : ''}`} disabled={!setup.canEdit} onClick={open}>Billing details</button>}
        </div>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {setup && !setup.profile && <div className="notice small">Add your billing details before creating invoices.{!setup.canEdit && ' Ask your manager to do this.'}</div>}
      {data && (
        <div className="grid cols-3 inv-sum">
          <div className="card kpi"><div className="label">Billed</div><div className="value">{inr(data.summary.billedPaise)}</div></div>
          <div className="card kpi"><div className="label">Collected</div><div className="value">{inr(data.summary.collectedPaise)}</div></div>
          <div className="card kpi"><div className="label">Overdue</div><div className="value">{inr(data.summary.overduePaise)}</div><div className="small muted">{data.summary.overdueCount} {data.summary.overdueCount === 1 ? 'invoice' : 'invoices'}</div></div>
        </div>
      )}
      <div className="inv-tools">
        <div className="dash-tabs" role="tablist" style={{ marginBottom: 0 }}>{VIEWS.map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} className={`dash-tab${view === k ? ' on' : ''}`} onClick={() => setView(k)}>{l}</button>)}</div>
        <input className="input" aria-label="Search invoices" placeholder="Search number or customer" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Due</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Paid</th><th>Status</th></tr></thead>
            <tbody>
              {data?.rows.map((r) => { const s = statusOf(r); return (
                <tr key={r.id}>
                  <td><Link href={`/app/invoices/${r.id}`}><b>{r.number ?? 'Draft'}</b></Link></td>
                  <td>{r.customerName}</td>
                  <td className="small">{day(r.issuedAt)}</td>
                  <td className="small">{day(r.dueAt)}</td>
                  <td style={{ textAlign: 'right' }}>{inr(r.totalPaise, 2)}</td>
                  <td style={{ textAlign: 'right' }}>{inr(r.paidPaise, 2)}</td>
                  <td><span className={`badge ${s.tone}`}>{s.label}</span></td>
                </tr>
              ); })}
            </tbody>
          </table>
          {data && !data.rows.length && <div className="empty">No invoices here.</div>}
        </div>
      </div>

      {edit && setup && (
        <div className="modal-bg">
          <form className="modal book-modal" onSubmit={save}>
            <h2>Billing details</h2>
            <p className="small muted">Printed on every invoice of this business line. Leave the GSTIN empty if you are not registered; no GST will be charged.</p>
            <div className="field"><label htmlFor="b-n">Legal name</label><input id="b-n" className="input" required minLength={2} value={edit.legalName} onChange={(e) => setEdit({ ...edit, legalName: e.target.value })} /></div>
            <div className="book-nums">
              <div className="field"><label htmlFor="b-g">GSTIN</label><input id="b-g" className="input" maxLength={15} style={{ textTransform: 'uppercase' }} value={edit.gstin} onChange={(e) => { const gstin = e.target.value.toUpperCase(); setEdit({ ...edit, gstin, stateCode: setup.states[gstin.slice(0, 2)] ? gstin.slice(0, 2) : edit.stateCode }); }} /></div>
              <div className="field"><label htmlFor="b-s">State</label><select id="b-s" className="input" required value={edit.stateCode} onChange={(e) => setEdit({ ...edit, stateCode: e.target.value })}><option value="">Choose…</option>{Object.entries(setup.states).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></div>
            </div>
            <div className="field"><label htmlFor="b-a">Address</label><textarea id="b-a" className="input" rows={2} required minLength={5} value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></div>
            <div className="book-nums">
              <div className="field"><label htmlFor="b-e">Email</label><input id="b-e" className="input" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-p">Phone</label><input id="b-p" className="input" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
            </div>
            <div className="field" style={{ maxWidth: 200 }}><label htmlFor="b-x">Invoice prefix</label><input id="b-x" className="input" required maxLength={6} style={{ textTransform: 'uppercase' }} value={edit.invoicePrefix} onChange={(e) => setEdit({ ...edit, invoicePrefix: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label htmlFor="b-b">Bank details (optional)</label><textarea id="b-b" className="input" rows={2} value={edit.bankDetails} onChange={(e) => setEdit({ ...edit, bankDetails: e.target.value })} /></div>
            <div className="field"><label htmlFor="b-t">Standard terms (optional)</label><textarea id="b-t" className="input" rows={2} value={edit.terms} onChange={(e) => setEdit({ ...edit, terms: e.target.value })} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setEdit(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}

      {reg && (
        <div className="modal-bg">
          <form className="modal" onSubmit={download}>
            <h2>Sales register</h2>
            <p className="small muted">Every issued invoice in the period, with taxable value and tax. Cancelled invoices are listed at zero. Dates are IST.</p>
            <div className="book-nums">
              <div className="field"><label htmlFor="r-f">From</label><input id="r-f" className="input" type="date" required value={reg.from} onChange={(e) => setReg({ ...reg, from: e.target.value })} /></div>
              <div className="field"><label htmlFor="r-t">To</label><input id="r-t" className="input" type="date" required value={reg.to} onChange={(e) => setReg({ ...reg, to: e.target.value })} /></div>
            </div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setReg(null)}>Go back</button><button className="btn">Download</button></div>
          </form>
        </div>
      )}
    </>
  );
}

