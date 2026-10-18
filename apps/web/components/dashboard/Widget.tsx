'use client';

import Link from 'next/link';
import { METRICS, WidgetConfig } from '@ubos/shared';
import { relTime } from '@/lib/workspace';
import { BarList, Donut, Empty, fmt, Funnel, Gauge, Heatmap, LineChart, Pt, Trend } from './charts';

export interface MetricData { metric: string; format: string; value: number | null; previous: number | null; series: Pt[]; target: number | null; from: string; to: string; label: string; error?: string }
interface FunnelData { pipeline: string | null; steps: Pt[]; total: number; label: string }
interface LeaderRow {
  userId: string; name: string; leads: number; openLeads: number; calls: number; connected: number; connectRate: number | null; talkMinutes: number;
  won: number; winRate: number | null; wonValue: number; activities: number; leadsWorked: number; followupsDone: number; followupOnTime: number | null;
  answered1h: number | null; firstResponseHours: number | null; staleLeads: number; stuckLeads: number; overdueFollowups: number;
}
const pc = (v: number | null) => (v === null ? '—' : `${v}%`);
const warn = (bad: boolean) => (bad ? { color: 'var(--bad)', fontWeight: 600 } : undefined);
interface FollowRow { id: string; leadId: string; name: string; mobile: string | null; dueAt: string; note: string | null; owner: string | null; overdue: boolean }
interface ForecastData { wonSoFar: number; runRateWins: number; pipelineWins: number; wonValueSoFar: number; runRateValue: number; weightedPipelineValue: number; openLeads: number; daysLeft: number }

/** Leads-list link for a clicked bar / slice, when the metric maps to lead filters. */
export function drillLink(w: WidgetConfig, d: MetricData, p?: Pt): string | null {
  const def = w.metric ? METRICS[w.metric] : null;
  if (!def || !['created', 'none'].includes(def.basis) || !w.metric || ['first_response', 'pipeline_value', 'weighted_pipeline'].includes(w.metric)) return null;
  const q = new URLSearchParams();
  if (def.basis === 'created') {
    const day = (iso: string, back = 0) => new Date(new Date(iso).getTime() - back).toLocaleDateString('en-CA');
    q.set('createdFrom', day(d.from));
    q.set('createdTo', day(d.to, 1));
  }
  if (w.metric === 'stuck_leads') q.set('stuck', 'yes');
  if (w.metric === 'contact_rate' && !p) q.set('contacted', 'no');
  if (p) {
    const g = w.groupBy;
    if (g === 'stage') q.set('stageIds', p.key);
    else if (g === 'owner') q.set('owners', p.key === '__unassigned__' ? 'unassigned' : p.key);
    else if (g === 'source') q.set('sources', p.key);
    else if (g === 'status') q.set('statuses', p.key);
    else if (g === 'day' && def.basis === 'created') { q.set('createdFrom', p.key); q.set('createdTo', p.key); }
    else return null;
  }
  return `/app/leads?${q.toString()}`;
}

/** Groupings that can filter the whole dashboard when clicked. */
export const CROSS_GROUPS = ['owner', 'source', 'status', 'stage', 'workspace'];

export function WidgetBody({ w, data, onDrill, onCross, active }: {
  w: WidgetConfig; data: unknown; onDrill: (href: string) => void; onCross?: (w: WidgetConfig, p: Pt) => void; active?: string[];
}) {
  if (!data) return <div className="skeleton" />;
  if ((data as { error?: string }).error) return <div className="small" style={{ color: 'var(--bad)' }}>{(data as { error: string }).error}</div>;

  if (w.type === 'funnel') {
    const f = data as FunnelData;
    return <>{f.pipeline && <div className="small muted" style={{ marginBottom: 6 }}>{f.pipeline} · {f.total} new leads</div>}<Funnel steps={f.steps} /></>;
  }
  if (w.type === 'leaderboard') {
    const rows = (data as { rows: LeaderRow[] }).rows;
    if (!rows.length) return <Empty />;
    return (
      <div className="table-wrap">
        <table className="table compact lb-table">
          <thead>
            <tr className="lb-groups"><th colSpan={2} /><th colSpan={4}>Results</th><th colSpan={4}>Activity</th><th colSpan={3}>Speed & SLA</th><th colSpan={4}>Pipeline hygiene</th></tr>
            <tr>
              <th>#</th><th>Person</th>
              <th title="Leads won in the period">Won</th><th title="Deal value won">Won value</th><th title="Won ÷ (won + lost)">Win rate</th><th title="New leads assigned in the period">New leads</th>
              <th title="Calls, remarks, actions, stage moves">Activities</th><th>Calls</th><th title="Connected calls · connect rate">Connected</th><th>Talk time</th>
              <th title="New leads answered within 60 minutes">≤1h</th><th title="Average hours to first response">Avg reply</th><th title="Follow-ups done on their day">On time</th>
              <th>Open</th><th title="Past stage SLA">Stuck</th><th title="No work for 7+ days">Stale</th><th>Overdue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.userId}>
                <td>{i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
                <td style={{ whiteSpace: 'nowrap' }}><Link href={`/app/leads?owners=${r.userId}`}>{r.name}</Link></td>
                <td><b>{r.won}</b></td><td>{r.wonValue ? fmt(r.wonValue, 'currency') : '—'}</td><td>{pc(r.winRate)}</td><td>{r.leads}</td>
                <td>{r.activities}</td><td>{r.calls}</td><td>{r.connected}{r.connectRate !== null && <span className="small muted"> · {r.connectRate}%</span>}</td><td>{fmt(r.talkMinutes, 'minutes')}</td>
                <td style={warn(r.answered1h !== null && r.answered1h < 50)}>{pc(r.answered1h)}</td>
                <td style={warn(r.firstResponseHours !== null && r.firstResponseHours > 24)}>{r.firstResponseHours === null ? '—' : fmt(r.firstResponseHours, 'hours')}</td>
                <td style={warn(r.followupOnTime !== null && r.followupOnTime < 60)}>{pc(r.followupOnTime)}</td>
                <td>{r.openLeads}</td><td style={warn(r.stuckLeads > 0)}>{r.stuckLeads}</td><td style={warn(r.staleLeads > 3)}>{r.staleLeads}</td><td style={warn(r.overdueFollowups > 0)}>{r.overdueFollowups}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (w.type === 'followups') {
    const rows = (data as { rows: FollowRow[] }).rows;
    if (!rows.length) return <div className="empty" style={{ padding: 18 }}>Nothing due — all caught up 🎉</div>;
    return (
      <div className="fu-list">
        {rows.map((f) => (
          <Link key={f.id} href={`/app/leads/${f.leadId}`} className="fu-row">
            <span style={{ minWidth: 0 }}><b>{f.name}</b><span className="small muted"> · {f.note ?? 'Follow-up'}{f.owner ? ` · ${f.owner}` : ''}</span></span>
            <span className={`badge ${f.overdue ? 'bad' : 'warn'}`}>{relTime(f.dueAt)}</span>
          </Link>
        ))}
      </div>
    );
  }
  if (w.type === 'forecast') {
    const f = data as ForecastData;
    const hasValue = f.wonValueSoFar > 0 || f.weightedPipelineValue > 0;
    return (
      <div className="forecast">
        <div className="small muted">This month · {f.daysLeft} day(s) left</div>
        <div className="forecast-grid">
          <div><span className="small muted">Won so far</span><b>{f.wonSoFar}</b>{hasValue && <span className="small">{fmt(f.wonValueSoFar, 'currency')}</span>}</div>
          <div><span className="small muted">At current pace</span><b>{f.runRateWins}</b>{hasValue && <span className="small">{fmt(f.runRateValue, 'currency')}</span>}</div>
          <div><span className="small muted">With open pipeline</span><b>{f.pipelineWins}</b>{hasValue && <span className="small">+{fmt(f.weightedPipelineValue, 'currency')} weighted</span>}</div>
        </div>
        <div className="small muted">“With open pipeline” adds each of the {f.openLeads} open leads × its stage win probability.</div>
      </div>
    );
  }

  const d = data as MetricData;
  const def = w.metric ? METRICS[w.metric] : null;
  const crossable = !!onCross && CROSS_GROUPS.includes(w.groupBy ?? '');
  const pick = (p: Pt) => { if (crossable) return onCross!(w, p); const href = drillLink(w, d, p); if (href) onDrill(href); };
  const canDrill = crossable || !!drillLink(w, d, d.series[0] ?? { key: '', label: '', value: 0 });
  const mark = (pts: Pt[]) => (active?.length ? pts.map((p) => ({ ...p, label: active.includes(p.key) ? `● ${p.label}` : p.label })) : pts);

  if (w.type === 'kpi') {
    const href = drillLink(w, d);
    return (
      <div className="kpi-body">
        <div className="kpi-value">{href ? <Link href={href}>{fmt(d.value, d.format)}</Link> : fmt(d.value, d.format)}</div>
        <Trend value={d.value} previous={d.previous} up={def?.up ?? true} />
        {d.previous === null && def?.basis === 'none' && <span className="trend">right now</span>}
      </div>
    );
  }
  if (w.type === 'gauge') return <Gauge value={d.value ?? 0} target={w.target ?? d.target ?? 0} format={d.format} />;
  if (w.type === 'line') return <LineChart points={d.series} format={d.format} height={w.h === 3 ? 240 : 170} />;
  if (w.type === 'pie') return <Donut points={mark(d.series)} format={d.format} onPick={canDrill ? pick : undefined} />;
  if (w.type === 'heatmap') return <Heatmap points={d.series} format={d.format} />;
  if (w.type === 'table') {
    if (!d.series.length) return <Empty />;
    return (
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>{w.groupBy ?? ''}</th><th style={{ textAlign: 'right' }}>{def?.label}</th><th style={{ textAlign: 'right' }}>Based on</th></tr></thead>
          <tbody>
            {mark(d.series).map((p) => (
              <tr key={p.key} className={`${canDrill ? 'clickable' : ''} ${active?.includes(p.key) ? 'selected' : ''}`} onClick={canDrill ? () => pick(p) : undefined}>
                <td>{p.label}</td><td style={{ textAlign: 'right' }}><b>{fmt(p.value, d.format)}</b></td><td style={{ textAlign: 'right' }} className="small muted">{p.count ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  // bar
  const isTime = ['day', 'week', 'month'].includes(w.groupBy ?? '');
  if (isTime) return <LineChart points={d.series} format={d.format} height={w.h === 3 ? 240 : 170} />;
  return <BarList points={mark(d.series)} format={d.format} onPick={canDrill ? pick : undefined} limit={w.h === 3 ? 14 : 8} />;
}
