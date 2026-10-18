'use client';

// Small, dependency-free SVG charts for dashboards. Colours come from CSS variables so they follow the theme.

export interface Pt { key: string; label: string; value: number; color?: string | null; x?: number; y?: number; count?: number }

const PALETTE = ['#5b3cc4', '#1f9d55', '#e08a1e', '#d6455d', '#2f7fd8', '#8a5cf6', '#14a3a3', '#b8860b', '#7a7a8c', '#c2185b'];
export const colorAt = (i: number) => PALETTE[i % PALETTE.length];

/** Formats a metric value: counts, %, hours, minutes or rupees (from paise, with lakh / crore). */
export function fmt(v: number | null | undefined, format: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  switch (format) {
    case 'percent': return `${Math.round(v * 10) / 10}%`;
    case 'hours': return v < 1 ? `${Math.round(v * 60)} min` : `${Math.round(v * 10) / 10} h`;
    case 'minutes': return v >= 120 ? `${Math.round(v / 6) / 10} h` : v < 10 ? `${Math.round(v * 10) / 10} min` : `${Math.round(v)} min`;
    case 'days': return `${Math.round(v * 10) / 10} days`;
    case 'number': return (Math.round(v * 10) / 10).toLocaleString('en-IN');
    case 'currency': {
      const r = v / 100;
      if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)} Cr`;
      if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)} L`;
      return `₹${Math.round(r).toLocaleString('en-IN')}`;
    }
    default: return Math.round(v).toLocaleString('en-IN');
  }
}

export function Trend({ value, previous, up = true }: { value: number | null; previous: number | null; up?: boolean }) {
  if (value === null || previous === null) return null;
  if (previous === 0) return value ? <span className="trend up">new</span> : null;
  const pct = Math.round(((value - previous) / Math.abs(previous)) * 100);
  if (pct === 0) return <span className="trend">= same as before</span>;
  const good = up ? pct > 0 : pct < 0;
  return <span className={`trend ${good ? 'up' : 'down'}`}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct)}% vs previous period</span>;
}

/** Line / area chart for time series. */
export function LineChart({ points, format, height = 170 }: { points: Pt[]; format: string; height?: number }) {
  if (!points.length) return <Empty />;
  const W = 600;
  const H = height;
  const pad = { l: 44, r: 10, t: 10, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const x = (i: number) => pad.l + (points.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad.b} L${x(0).toFixed(1)},${H - pad.b} Z`;
  const step = Math.max(1, Math.ceil(points.length / 7));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Trend chart">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--line)" />
          <text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end" className="chart-tick">{fmt(max * f, format)}</text>
        </g>
      ))}
      <path d={area} fill="var(--brand)" opacity="0.08" />
      <path d={line} fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={p.key}>
          <circle cx={x(i)} cy={y(p.value)} r={points.length > 40 ? 0 : 3} fill="var(--brand)"><title>{`${p.label}: ${fmt(p.value, format)}`}</title></circle>
          {i % step === 0 && <text x={x(i)} y={H - 6} textAnchor="middle" className="chart-tick">{p.label}</text>}
        </g>
      ))}
    </svg>
  );
}

/** Horizontal bars for categories; each bar can drill down. */
export function BarList({ points, format, onPick, limit = 10 }: { points: Pt[]; format: string; onPick?: (p: Pt) => void; limit?: number }) {
  if (!points.length) return <Empty />;
  const shown = points.slice(0, limit);
  const max = Math.max(1, ...shown.map((p) => p.value));
  return (
    <div className="barlist">
      {shown.map((p, i) => (
        <button key={p.key} type="button" className="barlist-row" onClick={onPick ? () => onPick(p) : undefined} disabled={!onPick} title={onPick ? 'Click to filter the dashboard' : undefined}>
          <span className="barlist-label">{p.label}</span>
          <span className="barlist-track"><span style={{ width: `${Math.max(2, (p.value / max) * 100)}%`, background: p.color && p.color !== '#e4e2ec' ? p.color : colorAt(i) }} /></span>
          <b className="barlist-value">{fmt(p.value, format)}</b>
        </button>
      ))}
      {points.length > limit && <div className="small muted">+{points.length - limit} more</div>}
    </div>
  );
}

/** Donut with legend. */
export function Donut({ points, format, onPick }: { points: Pt[]; format: string; onPick?: (p: Pt) => void }) {
  const positive = points.filter((p) => p.value > 0);
  const total = positive.reduce((n, p) => n + p.value, 0);
  const rest = positive.slice(5).reduce((n, p) => n + p.value, 0);
  const items: Pt[] = positive.length > 6 ? [...positive.slice(0, 5), { key: '__other__', label: 'Other', value: rest }] : positive;
  if (!total) return <Empty />;
  const R = 52;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" width="112" height="112" role="img" aria-label="Donut chart" style={{ flex: "none" }}>
        {items.map((p, i) => {
          const len = (p.value / total) * C;
          const el = <circle key={p.key} cx="70" cy="70" r={R} fill="none" stroke={colorAt(i)} strokeWidth="20" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)"><title>{`${p.label}: ${fmt(p.value, format)}`}</title></circle>;
          acc += len;
          return el;
        })}
        <text x="70" y="68" textAnchor="middle" className="donut-total">{fmt(total, format)}</text>
        <text x="70" y="84" textAnchor="middle" className="chart-tick">total</text>
      </svg>
      <div className="donut-legend">
        {items.map((p, i) => (
          <button key={p.key} type="button" onClick={onPick && p.key !== '__other__' ? () => onPick(p) : undefined} disabled={!onPick || p.key === '__other__'}>
            <i style={{ background: colorAt(i) }} />{p.label}<b>{Math.round((p.value / total) * 100)}%</b>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Funnel: how many leads reached each stage, with step conversion. */
export function Funnel({ steps }: { steps: Pt[] }) {
  if (!steps.length || !steps[0].value) return <Empty />;
  const top = steps[0].value;
  return (
    <div className="funnel">
      {steps.map((s, i) => (
        <div key={s.key} className="funnel-row">
          <span className="funnel-label">{s.label}</span>
          <span className="funnel-track"><span style={{ width: `${Math.max(3, (s.value / top) * 100)}%`, background: s.color && s.color !== '#e4e2ec' ? s.color : colorAt(0), opacity: 1 - i * 0.06 }} /></span>
          <b>{s.value}</b>
          <span className="small muted funnel-conv">{i ? `${steps[i - 1].value ? Math.round((s.value / steps[i - 1].value) * 100) : 0}%` : '100%'}</span>
        </div>
      ))}
    </div>
  );
}

/** Weekday × hour heatmap (09:00–21:00). */
export function Heatmap({ points, format }: { points: Pt[]; format: string }) {
  if (!points.length) return <Empty />;
  const hours = Array.from({ length: 13 }, (_, i) => i + 9);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const at = new Map(points.map((p) => [`${p.x}:${p.y}`, p]));
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="heatmap" role="table" aria-label="Heatmap by weekday and hour">
      <div className="heatmap-row"><span />{hours.map((h) => <span key={h} className="chart-tick">{h}</span>)}</div>
      {days.map((d, x) => (
        <div key={d} className="heatmap-row">
          <span className="chart-tick">{d}</span>
          {hours.map((h) => {
            const p = at.get(`${x}:${h}`);
            return <span key={h} className="heat" title={p ? `${d} ${h}:00 — ${fmt(p.value, format)} (${p.count} calls)` : `${d} ${h}:00 — no calls`} style={{ background: p ? `rgba(91, 60, 196, ${0.12 + (p.value / max) * 0.88})` : '#f3f2f8' }} />;
          })}
        </div>
      ))}
    </div>
  );
}

/** Semi-circle gauge of value vs target. */
export function Gauge({ value, target, format }: { value: number; target: number; format: string }) {
  const pct = target ? Math.min(1, value / target) : 0;
  const a = Math.PI * (1 - pct);
  const x = 80 + 62 * Math.cos(a);
  const y = 80 - 62 * Math.sin(a);
  return (
    <div style={{ textAlign: 'center' }}>
      <svg viewBox="0 0 160 96" width="100%" style={{ maxWidth: 260 }} role="img" aria-label={`${Math.round(pct * 100)}% of target`}>
        <path d="M18 80 A62 62 0 0 1 142 80" fill="none" stroke="#ecebf2" strokeWidth="14" strokeLinecap="round" />
        {pct > 0 && <path d={`M18 80 A62 62 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`} fill="none" stroke={pct >= 1 ? 'var(--ok)' : 'var(--brand)'} strokeWidth="14" strokeLinecap="round" />}
        <text x="80" y="72" textAnchor="middle" className="donut-total">{Math.round(pct * 100)}%</text>
      </svg>
      <div className="small"><b>{fmt(value, format)}</b> <span className="muted">of {fmt(target, format)} target</span></div>
    </div>
  );
}

export function Empty() {
  return <div className="empty" style={{ padding: 18 }}>No data for this period</div>;
}
