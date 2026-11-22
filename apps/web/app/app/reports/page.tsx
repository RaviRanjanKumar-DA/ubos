'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Icon } from '@/components/Icon';

interface Def { key: string; title: string; group: string; description: string; detail: boolean; ready: boolean }
const GROUPS = ['Team', 'Calls', 'Leads', 'Sales', 'AI'];
const ICON: Record<string, string> = { leaderboard: 'star', actions: 'checklist', tasks: 'calendar', calls: 'calls', call_log: 'list', leads: 'leads', duplicates: 'refresh', facebook: 'share', sales: 'trend', deleted: 'trash', ai_insights: 'ai', call_summaries: 'ai' };

/** Every report in one place; each opens with filters and a download. */
export default function ReportsHub() {
  const [defs, setDefs] = useState<Def[] | null>(null);
  const [canExport, setCanExport] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api<{ reports: Def[]; canExport: boolean }>('/api/v1/reports').then((r) => { setDefs(r.reports); setCanExport(r.canExport); }).catch((e) => setErr(e.message)); }, []);
  return (
    <>
      <div className="page-head"><div><h1>Reports</h1><div className="muted small">Pick a report, set the period and filters, and download it for Excel. Dates are in IST.</div></div></div>
      {err && <div className="error">{err}</div>}
      {defs && GROUPS.map((g) => {
        const list = defs.filter((d) => d.group === g);
        if (!list.length) return null;
        return (
          <section key={g} style={{ marginBottom: 18 }}>
            <h2 className="hr-sub">{g}</h2>
            <div className="report-grid">
              {list.map((d) => d.ready ? (
                <Link key={d.key} href={`/app/reports/${d.key}`} className="card report-card">
                  <span className="report-ic"><Icon name={ICON[d.key] ?? 'trend'} className="ic" /></span>
                  <b>{d.title}</b>
                  <span className="small muted">{d.description}</span>
                  {d.detail && !canExport && <span className="small muted">View only: downloading needs “Export leads”.</span>}
                </Link>
              ) : (
                <div key={d.key} className="card report-card soon" aria-disabled="true">
                  <span className="report-ic"><Icon name={ICON[d.key] ?? 'trend'} className="ic" /></span>
                  <b>{d.title} <span className="badge grey">Coming</span></b>
                  <span className="small muted">{d.description}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
