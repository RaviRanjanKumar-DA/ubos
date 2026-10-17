'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Integration {
  key: string; name: string; description: string; category: string; phase: string;
  status: 'active' | 'inactive' | 'paused'; activatedAt: string | null;
}
const ORDER = ['Lead sources', 'Calling', 'Messaging', 'Website & e-commerce', 'Payments', 'Productivity', 'Other CRMs'];

export default function IntegrationsPage() {
  const { me, version } = useShell();
  const [list, setList] = useState<Integration[] | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const canManage = me.permissions['integrations.manage'] === 'ORGANIZATION';

  const load = () => api<Integration[]>('/api/v1/integrations', { noWorkspace: true }).then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [version]);

  async function toggle(i: Integration) {
    setBusy(i.key);
    setError('');
    try {
      await api(`/api/v1/integrations/${i.key}/${i.status === 'active' ? 'deactivate' : 'activate'}`, { method: 'POST', noWorkspace: true });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy('');
    }
  }

  const shown = useMemo(() => (list ?? []).filter((i) => (!cat || i.category === cat) && (!q || `${i.name} ${i.description}`.toLowerCase().includes(q.toLowerCase()))), [list, q, cat]);
  const active = (list ?? []).filter((i) => i.status === 'active');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <div className="muted small">{active.length} active of {list?.length ?? 0} · switch each service on or off for {me.tenant.name}. Connection settings arrive with each integration in the phase shown.</div>
        </div>
        <input className="input" style={{ width: 220 }} placeholder="Search integrations" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="chips" style={{ marginBottom: 14 }}>
        <button className={`chip ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>All <span className="count">{list?.length ?? 0}</span></button>
        {ORDER.map((c) => (
          <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>
            {c} <span className="count">{list?.filter((i) => i.category === c).length ?? 0}</span>
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {!list && <div className="muted">Loading…</div>}
      {ORDER.filter((c) => shown.some((i) => i.category === c)).map((c) => (
        <div key={c} style={{ marginBottom: 18 }}>
          <h2>{c}</h2>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 560 }}>
                <tbody>
                  {shown.filter((i) => i.category === c).map((i) => (
                    <tr key={i.key}>
                      <td style={{ width: '55%' }}><b>{i.name}</b><div className="small muted">{i.description}</div></td>
                      <td>
                        {i.status === 'active' ? <span className="badge ok"><span className="dot" />Active</span> : <span className="badge grey">Inactive</span>}
                        <span className="badge" style={{ marginLeft: 6, fontWeight: 500 }} title="When the live connection ships">{i.phase}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {canManage && (
                          <button className={`btn sm ${i.status === 'active' ? 'danger' : 'outline'}`} disabled={busy === i.key} onClick={() => toggle(i)}>
                            {i.status === 'active' ? 'Deactivate' : 'Activate now'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}
      {list && !shown.length && <div className="card empty">No integration matches “{q}”.</div>}
    </>
  );
}
