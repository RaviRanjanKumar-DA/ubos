'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { IntegrationIcon } from '@/components/IntegrationIcon';
import { IntegrationSetup } from '@/components/IntegrationSetup';

interface Integration {
  key: string; name: string; description: string; category: string; phase: string;
  status: 'active' | 'inactive' | 'paused'; activatedAt: string | null;
}
const ORDER = [
  'Lead sources', 'Forms & surveys', 'Calling', 'Messaging', 'Website & e-commerce', 'Payments', 'Accounting',
  'Marketing & analytics', 'AI & automation', 'Productivity', 'Support desks', 'Other CRMs',
];

export default function IntegrationsPage() {
  const { me, version } = useShell();
  const [list, setList] = useState<Integration[] | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
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

  const shown = useMemo(() => (list ?? []).filter((i) =>
    (!cat || i.category === cat) && (!onlyActive || i.status === 'active')
    && (!q || `${i.name} ${i.description} ${i.category}`.toLowerCase().includes(q.toLowerCase()))), [list, q, cat, onlyActive]);
  const active = (list ?? []).filter((i) => i.status === 'active');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <div className="muted small">{active.length} active of {list?.length ?? 0} · switch each service on or off for {me.tenant.name}. Connection settings arrive with each integration in the phase shown.</div>
        </div>
        <div className="row">
          <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Active only</label>
          <input className="input" style={{ width: 230 }} placeholder="Search 90+ integrations" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="chips" style={{ marginBottom: 16 }}>
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
        <section key={c} style={{ marginBottom: 22 }}>
          <h2 style={{ marginBottom: 10 }}>{c} <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}>({shown.filter((i) => i.category === c).length})</span></h2>
          <div className="int-grid">
            {shown.filter((i) => i.category === c).map((i) => (
              <div key={i.key} className={`card int-card ${i.status === 'active' ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => setOpenKey(i.key)} onKeyDown={(e) => { if (e.key === 'Enter') setOpenKey(i.key); }} title={`Set up ${i.name}`}>
                <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start', gap: 12 }}>
                  <IntegrationIcon id={i.key} name={i.name} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b className="int-name">{i.name}</b>
                    <div className="small muted int-desc">{i.description}</div>
                  </div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 'auto', paddingTop: 10 }}>
                  <span className="row" style={{ gap: 6 }}>
                    {i.status === 'active' ? <span className="badge ok"><span className="dot" />Active</span> : <span className="badge grey">Inactive</span>}
                    <span className="badge" style={{ fontWeight: 500 }} title="When the live connection ships">{i.phase}</span>
                  </span>
                  {canManage && (
                    <button className={`btn sm ${i.status === 'active' ? 'ghost' : 'outline'}`} disabled={busy === i.key} onClick={(e) => { e.stopPropagation(); if (i.status === 'active') toggle(i); else setOpenKey(i.key); }}
                      style={i.status === 'active' ? { color: 'var(--bad)' } : undefined}>
                      {i.status === 'active' ? 'Deactivate' : 'Set up'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {openKey && <IntegrationSetup id={openKey} canManage={canManage} onClose={() => setOpenKey(null)} onChanged={load} />}
      {list && !shown.length && <div className="card empty">No integration matches{q ? ` “${q}”` : ' these filters'}.</div>}
    </>
  );
}
