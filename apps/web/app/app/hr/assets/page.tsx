'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { Menu } from '@/components/Menu';
import { hrDate, istYmd, type Emp } from '@/components/hr/hr';
import { inr, toPaise } from '@/lib/money';

interface Asset { id: string; tag: string; name: string; category: string; serialNo: string | null; costPaise: number | null; purchasedAt: string | null; warrantyEnd: string | null; status: string; condition: string; notes: string | null; holder: { id: string; name: string; employeeCode: string } | null }
type Draft = { id: string | null; tag: string; name: string; category: string; serialNo: string; cost: string; purchasedOn: string; warrantyEndOn: string; notes: string };
const TONE: Record<string, [string, string]> = { available: ['ok', 'In store'], assigned: ['warn', 'Issued'], repair: ['bad', 'In repair'], retired: ['grey', 'Retired'] };
const CATS = ['Laptop', 'Mobile', 'SIM', 'Headset', 'Monitor', 'ID card', 'Vehicle', 'Other'];

export default function AssetsPage() {
  const { version } = useShell();
  const [data, setData] = useState<{ rows: Asset[]; counts: Record<string, number> } | null>(null);
  const [people, setPeople] = useState<Emp[]>([]);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [d, setD] = useState<Draft | null>(null);
  const [issue, setIssue] = useState<{ asset: Asset; employeeId: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(() => api<{ rows: Asset[]; counts: Record<string, number> }>(`/api/v1/hr/assets?${new URLSearchParams({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) })}`).then(setData).catch((e) => setMsg({ type: 'error', text: e.message })), [status, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, version]);
  useEffect(() => { api<{ rows: Emp[] }>('/api/v1/hr/employees').then((r) => setPeople(r.rows.filter((e) => e.status !== 'exited'))).catch(() => setPeople([])); }, [version]);
  const run = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; } };
  const save = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!d) return;
    const cost = d.cost.trim() ? toPaise(d.cost.replace(/,/g, '')) : null;
    if (d.cost.trim() && cost === null) return setMsg({ type: 'error', text: 'Enter the cost as a number' });
    const body = { tag: d.tag, name: d.name, category: d.category, serialNo: d.serialNo.trim() || null, costPaise: cost, purchasedOn: d.purchasedOn || null, warrantyEndOn: d.warrantyEndOn || null, notes: d.notes.trim() || null };
    run(() => api(d.id ? `/api/v1/hr/assets/${d.id}` : '/api/v1/hr/assets', { method: d.id ? 'PUT' : 'POST', body }), 'Asset saved.').then((ok) => ok && setD(null));
  };
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  const giveBack = async (a: Asset, condition: string) => run(() => api(`/api/v1/hr/assets/${a.id}/return`, { method: 'POST', body: { condition } }), condition === 'good' ? 'Taken back into store.' : condition === 'lost' ? 'Marked as lost.' : 'Taken back and sent for repair.');
  return (
    <>
      <div className="page-head">
        <div><h1>Assets</h1><div className="muted small">Laptops, phones, SIMs and anything else given to staff.</div></div>
        <button className="btn" onClick={() => setD({ id: null, tag: '', name: '', category: 'Laptop', serialNo: '', cost: '', purchasedOn: '', warrantyEndOn: '', notes: '' })}><Icon name="plus" className="ic" />Add asset</button>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="chips" style={{ marginBottom: 12 }}>{([['', 'All'], ['available', 'In store'], ['assigned', 'Issued'], ['repair', 'In repair'], ['retired', 'Retired']] as [string, string][]).map(([k, l]) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{l}<span className="count">{k ? data?.counts[k] ?? 0 : total}</span></button>)}</div>
      <input className="input" style={{ marginBottom: 12 }} aria-label="Search assets" placeholder="Search tag, name or serial number" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Asset</th><th>Category</th><th>With</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data?.rows.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.name}</b><div className="small muted">{a.tag}{a.serialNo ? ` · ${a.serialNo}` : ''}{a.costPaise != null ? ` · ${inr(a.costPaise)}` : ''}{a.warrantyEnd ? ` · warranty till ${hrDate(a.warrantyEnd)}` : ''}</div></td>
                  <td className="small">{a.category}</td>
                  <td className="small">{a.holder ? <Link href={`/app/hr/${a.holder.id}`}>{a.holder.name}</Link> : '—'}</td>
                  <td><span className={`badge ${TONE[a.status]?.[0]}`}>{TONE[a.status]?.[1]}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <Menu sm items={[
                      ...(a.status === 'available' ? [{ label: 'Issue to someone', icon: 'share', onClick: () => setIssue({ asset: a, employeeId: people[0]?.id ?? '' }) }] : []),
                      ...(a.status === 'assigned' ? [{ label: 'Take back', icon: 'refresh', onClick: () => giveBack(a, 'good') }, { label: 'Take back damaged', icon: 'close', onClick: () => giveBack(a, 'damaged') }, { label: 'Lost', icon: 'close', onClick: () => giveBack(a, 'lost') }] : []),
                      ...(a.status === 'repair' ? [{ label: 'Back in store', icon: 'tick', onClick: () => run(() => api(`/api/v1/hr/assets/${a.id}`, { method: 'PUT', body: { status: 'available' } }), 'Back in store.') }] : []),
                      ...(a.status !== 'assigned' && a.status !== 'retired' ? [{ label: 'Retire', icon: 'close', onClick: () => run(() => api(`/api/v1/hr/assets/${a.id}`, { method: 'PUT', body: { status: 'retired' } }), 'Retired.') }] : []),
                      { label: 'Edit', icon: 'edit', onClick: () => setD({ id: a.id, tag: a.tag, name: a.name, category: a.category, serialNo: a.serialNo ?? '', cost: a.costPaise == null ? '' : String(a.costPaise / 100), purchasedOn: istYmd(a.purchasedAt), warrantyEndOn: istYmd(a.warrantyEnd), notes: a.notes ?? '' }) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.rows.length && <div className="empty">{total ? 'Nothing matches.' : 'No assets yet.'}</div>}
        </div>
      </div>
      {d && (
        <div className="modal-bg">
          <form className="modal hr-modal" onSubmit={save}>
            <h2>{d.id ? 'Edit asset' : 'Add asset'}</h2>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="a-t">Tag</label><input id="a-t" className="input" required maxLength={40} placeholder="e.g. LAP-014" value={d.tag} onChange={(e) => setD({ ...d, tag: e.target.value })} /></div>
              <div className="field"><label htmlFor="a-n">Name</label><input id="a-n" className="input" required minLength={2} maxLength={120} placeholder="e.g. Dell Latitude 5440" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="a-c">Category</label><input id="a-c" className="input" required list="a-cats" value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })} /><datalist id="a-cats">{CATS.map((c) => <option key={c} value={c} />)}</datalist></div>
              <div className="field"><label htmlFor="a-s">Serial number (optional)</label><input id="a-s" className="input" maxLength={80} value={d.serialNo} onChange={(e) => setD({ ...d, serialNo: e.target.value })} /></div>
              <div className="field"><label htmlFor="a-cost">Cost ₹ (optional)</label><input id="a-cost" className="input" inputMode="decimal" value={d.cost} onChange={(e) => setD({ ...d, cost: e.target.value })} /></div>
              <div className="field"><label htmlFor="a-p">Bought on (optional)</label><input id="a-p" className="input" type="date" value={d.purchasedOn} onChange={(e) => setD({ ...d, purchasedOn: e.target.value })} /></div>
              <div className="field"><label htmlFor="a-w">Warranty till (optional)</label><input id="a-w" className="input" type="date" value={d.warrantyEndOn} onChange={(e) => setD({ ...d, warrantyEndOn: e.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor="a-no">Notes (optional)</label><input id="a-no" className="input" maxLength={500} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setD(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
      {issue && (
        <div className="modal-bg">
          <form className="modal" onSubmit={(e) => { e.preventDefault(); run(() => api(`/api/v1/hr/assets/${issue.asset.id}/issue`, { method: 'POST', body: { employeeId: issue.employeeId } }), `${issue.asset.name} issued.`).then((ok) => ok && setIssue(null)); }}>
            <h2>Issue {issue.asset.name}</h2>
            {!people.length && <p className="small muted">Add employees first.</p>}
            <div className="field"><label htmlFor="i-e">To</label><select id="i-e" className="input" required value={issue.employeeId} onChange={(e) => setIssue({ ...issue, employeeId: e.target.value })}>{people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.employeeCode})</option>)}</select></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setIssue(null)}>Go back</button><button className="btn" disabled={!people.length}>Issue</button></div>
          </form>
        </div>
      )}
    </>
  );
}
