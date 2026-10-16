'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Summary {
  view: 'workspace' | 'organization';
  totalLeads: number;
  wonLeads: number;
  conversionRate: number;
  byStage: { name: string; count: number }[];
  bySource: { name: string; count: number }[];
  byWorkspace: { name: string; count: number }[];
}

function Bars({ rows }: { rows: { name: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return <div className="empty">No data yet</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.map((r) => (
        <div key={r.name}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
            <span>{r.name}</span>
            <b style={{ fontVariantNumeric: 'tabular-nums' }}>{r.count}</b>
          </div>
          <div className="bar"><span style={{ width: `${(r.count / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { me, version } = useShell();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    api<Summary>('/api/v1/dashboard').then(setData).catch((e) => setError(e.message));
  }, [version]);

  const wsName = me.workspaces.find((w) => w.id === me.currentWorkspaceId)?.name;
  const firstName = me.user.name.split(' ')[0];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Welcome, {firstName}</h1>
          <div className="muted small">
            {wsName ? `${wsName} workspace` : 'All business lines (organization view)'} · {me.roles.map((r) => r.role).join(', ')}
          </div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!data ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div className="card kpi"><div className="label">Leads in your view</div><div className="value">{data.totalLeads}</div></div>
            <div className="card kpi"><div className="label">Won</div><div className="value">{data.wonLeads}</div></div>
            <div className="card kpi"><div className="label">Conversion rate</div><div className="value">{data.conversionRate}%</div></div>
            <div className="card kpi"><div className="label">Lead sources</div><div className="value">{data.bySource.length}</div></div>
          </div>
          <div className="grid cols-3">
            <div className="card"><h2>Leads by stage</h2><Bars rows={data.byStage} /></div>
            <div className="card"><h2>Leads by source</h2><Bars rows={data.bySource} /></div>
            <div className="card">
              <h2>{data.view === 'organization' ? 'Leads by business line' : 'This business line'}</h2>
              <Bars rows={data.byWorkspace} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
