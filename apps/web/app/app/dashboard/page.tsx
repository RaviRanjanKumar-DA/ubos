'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
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
  const [fu, setFu] = useState<{ today: number; overdue: number } | null>(null);

  useEffect(() => {
    setData(null);
    api<Summary>('/api/v1/dashboard').then(setData).catch((e) => setError(e.message));
    if (me.permissions['crm.lead.view']) {
      Promise.all([api<unknown[]>('/api/v1/follow-ups?when=today'), api<unknown[]>('/api/v1/follow-ups?when=overdue')])
        .then(([t, o]) => setFu({ today: t.length, overdue: o.length })).catch(() => {});
    }
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
          {fu && (
            <div className="grid cols-2" style={{ marginBottom: 14 }}>
              <Link href="/app/leads" className="card kpi" style={{ color: 'inherit' }}><div className="label">⏰ Follow-ups due today</div><div className="value">{fu.today}</div><div className="small muted">Open Leads → "Follow-ups today"</div></Link>
              <Link href="/app/leads" className="card kpi" style={{ color: 'inherit', borderColor: fu.overdue ? '#f0c4bd' : undefined }}><div className="label">⚠ Overdue follow-ups</div><div className="value" style={{ color: fu.overdue ? 'var(--bad)' : undefined }}>{fu.overdue}</div><div className="small muted">Customers waiting for a call back</div></Link>
            </div>
          )}
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
