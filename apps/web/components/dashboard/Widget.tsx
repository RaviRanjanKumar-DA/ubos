'use client';

import Link from 'next/link';
import { METRICS, WidgetConfig } from '@ubos/shared';
import { relTime } from '@/lib/workspace';
import { BarList, Donut, Empty, fmt, Funnel, Gauge, Heatmap, LineChart, Pt, Trend } from './charts';

export interface MetricData { metric: string; format: string; value: number | null; previous: number | null; series: Pt[]; target: number | null; from: string; to: string; label: string; error?: string }
interface FunnelData { pipeline: string | null; steps: Pt[]; total: number; label: string }
interface LeaderRow { userId: string; name: string; leads: number; calls: number; connected: number; connectRate: number | null; talkMinutes: number; won: number; winRate: number | null }
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

export function WidgetBody({ w, data, onDrill }: { w: WidgetConfig; data: unknown; onDrill: (href: string) => void }) {
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
        <table className="table compact">
          <thead><tr><th>#</th><th>Person</th><th>New leads</th><th>Calls</th><th>Connected</th><th>Talk time</th><th>Won</th><th>Win rate</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.userId}>
                <td>{i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
                <td><Link href={`/app/leads?owners=${r.userId}`}>{r.name}</Link></td>
                <td>{r.leads}</td><td>{r.calls}</td>
                <td>{r.connected}{r.connectRate !== null && <span className="small muted"> · {r.connectRate}%</span>}</td>
                <td>{fmt(r.talkMinutes, 'minutes')}</td><td><b>{r.won}</b></td><td>{r.winRate === null ? '—' : `${r.winRate}%`}</td>
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
  const pick = (p: Pt) => { const href = drillLink(w, d, p); if (href) onDrill(href); };
  const canDrill = !!drillLink(w, d, d.series[0] ?? { key: '', label: '', value: 0 });

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
  if (w.type === 'pie') return <Donut points={d.series} format={d.format} onPick={canDrill ? pick : undefined} />;
  if (w.type === 'heatmap') return <Heatmap points={d.series} format={d.format} />;
  if (w.type === 'table') {
    if (!d.series.length) return <Empty />;
    return (
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>{w.groupBy ?? ''}</th><th style={{ textAlign: 'right' }}>{def?.label}</th><th style={{ textAlign: 'right' }}>Based on</th></tr></thead>
          <tbody>
            {d.series.map((p) => (
              <tr key={p.key} className={canDrill ? 'clickable' : ''} onClick={canDrill ? () => pick(p) : undefined}>
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
  return <BarList points={d.series} format={d.format} onPick={canDrill ? pick : undefined} limit={w.h === 3 ? 14 : 8} />;
}
