'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { istDay } from '@/lib/ist';

export interface AccessRow { id: string; state: 'lifetime' | 'active' | 'expiring' | 'expired' | 'revoked'; daysLeft: number | null; startsAt: string; expiresAt: string | null; revokeReason: string | null; hasLicence: boolean; licenceLast4: string | null; notes: string | null; renewalLeadId: string | null; package: { id: string; name: string; validityDays: number | null }; customer: { id: string; code: string; name: string; mobile: string | null } }
interface Product { id: string; name: string; accessKind: string; validityDays: number | null }

export const ACCESS_TONE: Record<AccessRow['state'], [string, string]> = { lifetime: ['ok', 'No end date'], active: ['ok', 'Active'], expiring: ['warn', 'Expiring'], expired: ['bad', 'Expired'], revoked: ['grey', 'Revoked'] };
export const accessDate = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

/** On a lead or customer: share the gallery on WhatsApp, see what they have, and give access. */
export function AccessPanel({ customerId, leadId, workspace, mobile, name }: { customerId: string; leadId?: string; workspace?: string; mobile?: string | null; name?: string }) {
  const { me, can, version } = useShell();
  const ws = workspace ?? me.currentWorkspaceId ?? undefined;
  const view = can('crm.access.view'), manage = can('crm.access.manage');
  const opts = workspace ? { workspace } : {};
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [share, setShare] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [d, setD] = useState<{ packageId: string; startsOn: string; days: string; licenceKey: string } | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { if (view) api<{ rows: AccessRow[] }>(`/api/v1/access?customerId=${customerId}`, opts).then((r) => setRows(r.rows)).catch(() => setRows([])); }, [customerId, view, workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    if (!ws) return;
    api<{ gallery: { isActive: boolean } | null; url: string | null }>('/api/v1/gallery', { workspace: ws }).then((g) => setShare(g.gallery?.isActive ? g.url : null)).catch(() => setShare(null));
    if (manage) api<Product[]>(`/api/v1/products?workspaceId=${ws}`, { workspace: ws }).then((p) => setProducts(p.filter((x) => x.accessKind !== 'none'))).catch(() => setProducts([]));
  }, [ws, manage, version]);
  const pick = (id: string) => { const p = products.find((x) => x.id === id); setD((x) => x && { ...x, packageId: id, days: p?.validityDays ? String(p.validityDays) : '' }); };
  const open = () => { setErr(''); const p = products[0]; setD({ packageId: p?.id ?? '', startsOn: istDay(new Date()), days: p?.validityDays ? String(p.validityDays) : '', licenceKey: '' }); };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!d) return;
    try { await api('/api/v1/access', { method: 'POST', ...opts, body: { customerId, leadId: leadId ?? null, packageId: d.packageId, startsOn: d.startsOn, validityDays: d.days ? Number(d.days) : null, licenceKey: d.licenceKey.trim() || null } }); setD(null); load(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); }
  }
  const digits = (mobile ?? '').replace(/\D/g, '');
  if (!view && !share) return null;
  return (
    <div className="card acc-panel">
      <div className="org-head">
        <h2 style={{ margin: 0 }}>Packages and access</h2>
        <div className="row" style={{ gap: 6 }}>
          {share && digits && <a className="btn sm outline" target="_blank" rel="noreferrer" href={`https://wa.me/${digits}?text=${encodeURIComponent(`Hello${name ? ` ${name}` : ''}, please have a look at what we offer: ${share}`)}`}><Icon name="share" className="ic" />Share gallery</a>}
          {manage && products.length > 0 && <button className="btn sm" onClick={open}><Icon name="plus" className="ic" />Give access</button>}
        </div>
      </div>
      {view && !rows.length && <p className="small muted" style={{ margin: '8px 0 0' }}>No course, software or service access yet.</p>}
      {rows.map((r) => (
        <div key={r.id} className="acc-row">
          <div><b>{r.package.name}</b><div className="small muted">{r.expiresAt ? `Until ${accessDate(r.expiresAt)}` : 'No end date'}</div></div>
          <span className={`badge ${ACCESS_TONE[r.state][0]}`}>{ACCESS_TONE[r.state][1]}</span>
        </div>
      ))}
      {rows.length > 0 && <div className="small" style={{ marginTop: 8 }}><Link href="/app/access">Manage access</Link></div>}
      {d && (
        <div className="modal-bg">
          <form className="modal" onSubmit={save}>
            <h2>Give access</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label htmlFor="ac-p">Product</label><select id="ac-p" className="input" required value={d.packageId} onChange={(e) => pick(e.target.value)}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="ac-s">Starts on</label><input id="ac-s" className="input" type="date" required value={d.startsOn} onChange={(e) => setD({ ...d, startsOn: e.target.value })} /></div>
              <div className="field"><label htmlFor="ac-d">Valid for (days)</label><input id="ac-d" className="input" type="number" min={1} placeholder="No end date" value={d.days} onChange={(e) => setD({ ...d, days: e.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor="ac-l">Licence key (optional)</label><input id="ac-l" className="input" autoComplete="off" maxLength={500} value={d.licenceKey} onChange={(e) => setD({ ...d, licenceKey: e.target.value })} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setD(null)}>Go back</button><button className="btn">Give access</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
