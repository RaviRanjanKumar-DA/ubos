'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { ACCESS_TONE, accessDate, type AccessRow } from '@/components/access/AccessPanel';
import { askText } from '@/components/Dialogs';
import { Menu } from '@/components/Menu';

type State = AccessRow['state'] | '';
interface Data { rows: AccessRow[]; counts: Record<AccessRow['state'], number> }
const TABS: [State, string][] = [['', 'All'], ['expiring', 'Expiring soon'], ['expired', 'Expired'], ['active', 'Active'], ['lifetime', 'No end date'], ['revoked', 'Revoked']];

export default function AccessPage() {
  const { can, version } = useShell();
  const manage = can('crm.access.manage');
  const [state, setState] = useState<State>('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const qs = useCallback(() => new URLSearchParams({ ...(state ? { state } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString(), [state, q]);
  const load = useCallback(() => api<Data>(`/api/v1/access?${qs()}`).then(setData).catch((e) => setMsg({ type: 'error', text: e.message })), [qs]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, version]);
  const run = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); load(); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } };
  const renew = async (r: AccessRow) => {
    const days = await askText(`Add how many days to ${r.package.name}?`, r.package.validityDays ? String(r.package.validityDays) : '');
    if (!days) return;
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) return setMsg({ type: 'error', text: 'Enter a whole number of days' });
    run(() => api(`/api/v1/access/${r.id}/renew`, { method: 'POST', body: { days: n } }), 'Access renewed.');
  };
  const revoke = async (r: AccessRow) => { const reason = await askText('Why is this access being revoked?'); if (reason) run(() => api(`/api/v1/access/${r.id}/revoke`, { method: 'POST', body: { reason } }), 'Access revoked.'); };
  const key = async (r: AccessRow) => { try { const k = await api<{ licenceKey: string }>(`/api/v1/access/${r.id}/licence`, { method: 'POST' }); setMsg({ type: 'notice', text: `Licence key for ${r.customer.name}: ${k.licenceKey}` }); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } };
  const download = async () => { try { const b = await api<Blob>(`/api/v1/access.csv?${qs()}`); const u = URL.createObjectURL(new Blob([b], { type: 'text/csv' })); const a = document.createElement('a'); a.href = u; a.download = 'access.csv'; a.click(); URL.revokeObjectURL(u); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } };
  const left = (r: AccessRow) => (r.state === 'revoked' ? r.revokeReason : r.daysLeft === null ? '' : r.daysLeft < 0 ? `${-r.daysLeft} days ago` : r.daysLeft === 0 ? 'Last day today' : `${r.daysLeft} days left`);
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <div className="page-head">
        <div><h1>Access and renewals</h1><div className="muted small">Who has which course, software or service, and until when. Give access from a lead or customer page.</div></div>
        <button className="btn outline" onClick={download}>Download</button>
      </div>
      {msg && <div className={msg.type} style={{ overflowWrap: 'anywhere' }}>{msg.text}</div>}
      <div className="chips" style={{ marginBottom: 12 }}>
        {TABS.map(([k, l]) => <button key={k} className={`chip ${state === k ? 'on' : ''}`} onClick={() => setState(k)}>{l}<span className="count">{k ? data?.counts[k] ?? 0 : total}</span></button>)}
      </div>
      <input className="input" style={{ marginBottom: 12 }} aria-label="Search access" placeholder="Search customer, mobile or product" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Customer</th><th>Product</th><th>Until</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/app/customers/${r.customer.id}`}><b>{r.customer.name}</b></Link><div className="small muted">{r.customer.code}</div></td>
                  <td>{r.package.name}{r.hasLicence && <div className="small muted">Key ending {r.licenceLast4}</div>}</td>
                  <td className="small">{r.expiresAt ? accessDate(r.expiresAt) : '—'}<div className="muted">{left(r)}</div></td>
                  <td><span className={`badge ${ACCESS_TONE[r.state][0]}`}>{ACCESS_TONE[r.state][1]}</span>{r.renewalLeadId && r.state !== 'revoked' && <div className="small"><Link href={`/app/leads/${r.renewalLeadId}`}>Renewal lead</Link></div>}</td>
                  <td style={{ textAlign: 'right' }}>{manage && <Menu sm items={r.state === 'revoked' ? [{ label: 'Restore', icon: 'refresh', onClick: () => run(() => api(`/api/v1/access/${r.id}/restore`, { method: 'POST', body: {} }), 'Access restored.') }] : [{ label: 'Renew', icon: 'refresh', onClick: () => renew(r) }, ...(r.hasLicence ? [{ label: 'Show key', icon: 'unlock', onClick: () => key(r) }] : []), { label: 'Revoke', icon: 'close', onClick: () => revoke(r) }]} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.rows.length && <div className="empty">Nothing here.</div>}
        </div>
      </div>
    </>
  );
}
