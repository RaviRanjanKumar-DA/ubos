'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Integration {
  key: string;
  name: string;
  description: string;
  status: 'active' | 'inactive' | 'paused';
  activatedAt: string | null;
}

export default function IntegrationsPage() {
  const { me, version } = useShell();
  const [list, setList] = useState<Integration[] | null>(null);
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

  const active = list?.filter((i) => i.status === 'active') ?? [];
  const available = list?.filter((i) => i.status !== 'active') ?? [];

  const Table = ({ rows, kind }: { rows: Integration[]; kind: 'active' | 'available' }) => (
    <div className="card" style={{ padding: 0, marginBottom: 18 }}>
      <table className="table">
        <thead><tr><th>Integration</th><th>Status</th><th style={{ textAlign: 'right' }}>{canManage ? 'Action' : ''}</th></tr></thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.key}>
              <td><b>{i.name}</b><div className="small muted">{i.description}</div></td>
              <td>
                {i.status === 'active'
                  ? <span className="badge ok"><span className="dot" />Active</span>
                  : <span className="badge grey">Inactive</span>}
              </td>
              <td style={{ textAlign: 'right' }}>
                {canManage && (
                  <button className={`btn sm ${kind === 'active' ? 'danger' : 'outline'}`} disabled={busy === i.key} onClick={() => toggle(i)}>
                    {kind === 'active' ? 'Deactivate' : 'Activate now'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">{kind === 'active' ? 'No active integrations yet.' : 'Everything is active.'}</div>}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <div className="muted small">Switch each service on or off for {me.tenant.name}. Connection settings (API keys, numbers) arrive with each integration in Phase 1–2.</div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!list ? <div className="muted">Loading…</div> : (
        <>
          <h2>Active integrations ({active.length})</h2>
          <Table rows={active} kind="active" />
          <h2>Available integrations ({available.length})</h2>
          <Table rows={available} kind="available" />
        </>
      )}
    </>
  );
}
