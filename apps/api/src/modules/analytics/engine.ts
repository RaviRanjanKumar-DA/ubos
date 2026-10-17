import type { Prisma, Tx } from '@ubos/database';
import { defaultWinProbability, GroupBy, METRICS, RangePreset } from '@ubos/shared';

/**
 * Analytics engine: one metric, grouped one way, over a date range, inside the viewer's data scope.
 * Rows are loaded with Prisma (so tenant RLS and the scope filter always apply) and aggregated in memory —
 * fine for the volumes of Phase 1; heavy tenants move to pre-aggregated tables later without changing the API.
 */

export interface Filters { workspaceIds?: string[]; ownerIds?: string[]; sources?: string[]; stageIds?: string[] }
export interface Range { from: Date; to: Date; prevFrom: Date; prevTo: Date; label: string }
export interface Point { key: string; label: string; value: number; color?: string | null; x?: number; y?: number; count?: number }
export interface MetricResult { metric: string; format: string; value: number | null; previous: number | null; series: Point[] }

const LIMIT = 50_000;
type Agg = { num: number; den: number };
const add = (m: Map<string, Agg>, k: string, num: number, den: number) => { const a = m.get(k) ?? { num: 0, den: 0 }; a.num += num; a.den += den; m.set(k, a); };

// ── Time zone helpers (tenant time zone, e.g. Asia/Kolkata) ──

function offsetMinutes(at: Date, tz: string) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}
export function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
}
/** The instant of local midnight for a calendar date in the tenant's zone. */
function midnight(y: number, m: number, d: number, tz: string) {
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - offsetMinutes(guess, tz) * 60_000);
}
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date, tz: string) => { const p = localParts(d, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
function weekKey(d: Date, tz: string) {
  const p = localParts(d, tz);
  const monday = new Date(Date.UTC(p.y, p.m - 1, p.d - p.wd));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}
const monthKey = (d: Date, tz: string) => { const p = localParts(d, tz); return `${p.y}-${pad(p.m)}`; };

export function resolveRange(preset: RangePreset, tz: string, from?: string, to?: string): Range {
  const t = localParts(new Date(), tz);
  const day = (offset: number) => midnight(t.y, t.m, t.d + offset, tz);
  const shift = (a: Date, b: Date) => ({ prevFrom: new Date(a.getTime() - (b.getTime() - a.getTime())), prevTo: a });
  switch (preset) {
    case 'today': return { from: day(0), to: day(1), ...shift(day(0), day(1)), label: 'Today' };
    case 'yesterday': return { from: day(-1), to: day(0), ...shift(day(-1), day(0)), label: 'Yesterday' };
    case 'last_7_days': return { from: day(-6), to: day(1), ...shift(day(-6), day(1)), label: 'Last 7 days' };
    case 'last_30_days': return { from: day(-29), to: day(1), ...shift(day(-29), day(1)), label: 'Last 30 days' };
    case 'last_month': return { from: midnight(t.y, t.m - 1, 1, tz), to: midnight(t.y, t.m, 1, tz), prevFrom: midnight(t.y, t.m - 2, 1, tz), prevTo: midnight(t.y, t.m - 1, 1, tz), label: 'Last month' };
    case 'this_quarter': {
      const q = Math.floor((t.m - 1) / 3) * 3 + 1;
      return { from: midnight(t.y, q, 1, tz), to: midnight(t.y, q + 3, 1, tz), prevFrom: midnight(t.y, q - 3, 1, tz), prevTo: midnight(t.y, q, 1, tz), label: 'This quarter' };
    }
    case 'this_year': return { from: midnight(t.y, 1, 1, tz), to: midnight(t.y + 1, 1, 1, tz), prevFrom: midnight(t.y - 1, 1, 1, tz), prevTo: midnight(t.y, 1, 1, tz), label: 'This year' };
    case 'custom': {
      const [fy, fm, fd] = (from ?? '').split('-').map(Number);
      const [ty, tm, td] = (to ?? '').split('-').map(Number);
      if (!fy || !ty) return resolveRange('this_month', tz);
      const a = midnight(fy, fm, fd, tz);
      const b = midnight(ty, tm, td + 1, tz);
      return b > a ? { from: a, to: b, ...shift(a, b), label: `${from} → ${to}` } : resolveRange('this_month', tz);
    }
    case 'this_month':
    default:
      return { from: midnight(t.y, t.m, 1, tz), to: midnight(t.y, t.m + 1, 1, tz), prevFrom: midnight(t.y, t.m - 1, 1, tz), prevTo: midnight(t.y, t.m, 1, tz), label: 'This month' };
  }
}

/** Every time bucket in a range, so trend charts show empty days as 0. */
function timeKeys(g: 'day' | 'week' | 'month', r: Range, tz: string): string[] {
  const keys: string[] = [];
  const end = Math.min(r.to.getTime(), Date.now() + 86_400_000);
  for (let t = r.from.getTime(); t < end && keys.length < 400; t += 86_400_000) {
    const d = new Date(t);
    const k = g === 'day' ? dayKey(d, tz) : g === 'week' ? weekKey(d, tz) : monthKey(d, tz);
    if (keys[keys.length - 1] !== k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}
const timeLabel = (g: GroupBy, k: string) => {
  if (g === 'month') return new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const d = new Date(`${k}T00:00:00Z`);
  return (g === 'week' ? 'Wk ' : '') + d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

// ── Lookups shared by all widgets of one dashboard request ──

export interface Lookups {
  tz: string;
  stages: Map<string, { name: string; color: string | null; isWon: boolean; isLost: boolean; position: number; pipelineId: string; slaDays: number | null; prob: number }>;
  workspaces: Map<string, { name: string; valueFieldKey: string | null }>;
  users: Map<string, string>;
  labels: Record<'lead_status' | 'lead_source' | 'call_disposition', Map<string, string>>;
}

export async function loadLookups(tx: Tx, tenantId: string): Promise<Lookups> {
  const [tenant, stages, workspaces, users, options] = await Promise.all([
    tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
    tx.leadStage.findMany({ select: { id: true, name: true, color: true, isWon: true, isLost: true, position: true, pipelineId: true, slaDays: true, winProbability: true } }),
    tx.workspace.findMany({ select: { id: true, name: true, valueFieldKey: true } }),
    tx.user.findMany({ select: { id: true, name: true } }),
    tx.workspaceOption.findMany({ where: { kind: { in: ['lead_status', 'lead_source', 'call_disposition'] } }, select: { kind: true, value: true, label: true } }),
  ]);
  const openCount = new Map<string, number>();
  for (const s of stages) if (!s.isWon && !s.isLost) openCount.set(s.pipelineId, (openCount.get(s.pipelineId) ?? 0) + 1);
  const openPos = new Map<string, number>();
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  const idx = new Map<string, number>();
  for (const s of sorted) if (!s.isWon && !s.isLost) { const i = idx.get(s.pipelineId) ?? 0; openPos.set(s.id, i); idx.set(s.pipelineId, i + 1); }
  const labels = { lead_status: new Map<string, string>(), lead_source: new Map<string, string>(), call_disposition: new Map<string, string>() };
  for (const o of options) if (!labels[o.kind as keyof typeof labels].has(o.value)) labels[o.kind as keyof typeof labels].set(o.value, o.label);
  return {
    tz: tenant?.timezone ?? 'Asia/Kolkata',
    stages: new Map(stages.map((s) => [s.id, {
      name: s.name, color: s.color, isWon: s.isWon, isLost: s.isLost, position: s.position, pipelineId: s.pipelineId, slaDays: s.slaDays,
      prob: s.isWon ? 100 : s.isLost ? 0 : s.winProbability ?? defaultWinProbability(openPos.get(s.id) ?? 0, openCount.get(s.pipelineId) ?? 1),
    }])),
    workspaces: new Map(workspaces.map((w) => [w.id, { name: w.name, valueFieldKey: w.valueFieldKey }])),
    users: new Map(users.map((u) => [u.id, u.name])),
    labels,
  };
}

/** Deal value of a lead from its business line's value field (0 when there is none). */
function dealValue(L: Lookups, workspaceId: string, cf: unknown) {
  const key = L.workspaces.get(workspaceId)?.valueFieldKey;
  if (!key || !cf || typeof cf !== 'object') return 0;
  const v = Number((cf as Record<string, unknown>)[key]);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0; // paise
}

// ── The query ──

export interface Ctx { tx: Tx; L: Lookups; scope: Prisma.LeadWhereInput; filters: Filters }

function leadWhere(c: Ctx): Prisma.LeadWhereInput {
  const f = c.filters;
  return {
    AND: [
      c.scope,
      ...(f.workspaceIds?.length ? [{ workspaceId: { in: f.workspaceIds } }] : []),
      ...(f.ownerIds?.length ? [{ ownerId: { in: f.ownerIds } }] : []),
      ...(f.sources?.length ? [{ source: { in: f.sources } }] : []),
      ...(f.stageIds?.length ? [{ stageId: { in: f.stageIds } }] : []),
    ],
  };
}

export async function runMetric(c: Ctx, metric: string, groupBy: GroupBy, r: Range, compare: boolean): Promise<MetricResult> {
  const def = METRICS[metric];
  if (!def) throw new Error(`Unknown metric ${metric}`);
  const g: GroupBy = def.groupBy.includes(groupBy) ? groupBy : 'none';
  const cur = await aggregate(c, metric, g, r.from, r.to);
  const value = total(metric, cur.all);
  const previous = compare && def.basis !== 'none' && g === 'none' ? total(metric, (await aggregate(c, metric, 'none', r.prevFrom, r.prevTo)).all) : null;
  return { metric, format: def.format, value, previous, series: g === 'none' ? [] : toSeries(c.L, metric, g, cur.groups, r) };
}

function total(metric: string, a: Agg): number | null {
  const kind = aggKind(metric);
  if (kind === 'sum') return a.num;
  if (!a.den) return null;
  return kind === 'ratio' ? Math.round((a.num / a.den) * 1000) / 10 : Math.round((a.num / a.den) * 10) / 10;
}
const aggKind = (m: string): 'sum' | 'ratio' | 'avg' =>
  ['win_rate', 'contact_rate', 'connect_rate', 'followup_compliance'].includes(m) ? 'ratio' : m === 'first_response' ? 'avg' : 'sum';

async function aggregate(c: Ctx, metric: string, g: GroupBy, from: Date, to: Date) {
  const all: Agg = { num: 0, den: 0 };
  const groups = new Map<string, Agg>();
  const { L } = c;
  const def = METRICS[metric];
  const bucket = (d: Date) => (g === 'day' ? dayKey(d, L.tz) : g === 'week' ? weekKey(d, L.tz) : monthKey(d, L.tz));
  const put = (key: string | null, num: number, den: number) => { all.num += num; all.den += den; if (g !== 'none') add(groups, key ?? '—', num, den); };
  const range = { gte: from, lt: to };

  if (['calls', 'connected_calls', 'connect_rate', 'talk_time'].includes(metric)) {
    const rows = await c.tx.leadActivity.findMany({
      where: { type: 'call', createdAt: range, lead: leadWhere({ ...c, filters: { ...c.filters, ownerIds: undefined } }), ...(c.filters.ownerIds?.length ? { userId: { in: c.filters.ownerIds } } : {}) },
      select: { createdAt: true, userId: true, workspaceId: true, disposition: true, connected: true, durationSec: true }, take: LIMIT,
    });
    for (const a of rows) {
      const [num, den] = metric === 'calls' ? [1, 1] : metric === 'connected_calls' ? [a.connected ? 1 : 0, 1] : metric === 'connect_rate' ? [a.connected ? 1 : 0, 1] : [a.connected ? Math.round((a.durationSec ?? 0) / 60) : 0, 1];
      const p = localParts(a.createdAt, L.tz);
      const key = g === 'owner' ? a.userId : g === 'workspace' ? a.workspaceId : g === 'disposition' ? a.disposition : g === 'heatmap' ? `${p.wd}:${p.h}` : ['day', 'week', 'month'].includes(g) ? bucket(a.createdAt) : null;
      put(key, num, den);
    }
    return { all, groups };
  }

  if (['followups_due', 'followup_compliance', 'overdue_followups'].includes(metric)) {
    const now = new Date();
    const rows = await c.tx.followUp.findMany({
      where: {
        lead: leadWhere({ ...c, filters: { ...c.filters, ownerIds: undefined } }),
        ...(c.filters.ownerIds?.length ? { userId: { in: c.filters.ownerIds } } : {}),
        ...(metric === 'overdue_followups' ? { doneAt: null, dueAt: { lt: now } } : { dueAt: metric === 'followup_compliance' ? { gte: from, lt: to < now ? to : now } : range }),
      },
      select: { dueAt: true, doneAt: true, userId: true, lead: { select: { workspaceId: true } } }, take: LIMIT,
    });
    for (const f of rows) {
      let num = 1;
      if (metric === 'followup_compliance') {
        const p = localParts(f.dueAt, L.tz);
        num = f.doneAt && f.doneAt < midnight(p.y, p.m, p.d + 1, L.tz) ? 1 : 0;
      }
      const key = g === 'owner' ? f.userId : g === 'workspace' ? f.lead.workspaceId : ['day', 'week', 'month'].includes(g) ? bucket(f.dueAt) : null;
      put(key, num, 1);
    }
    return { all, groups };
  }

  // Lead metrics
  const wonLost = [...L.stages].filter(([, s]) => (metric === 'won' || metric === 'won_value' ? s.isWon : metric === 'lost' ? s.isLost : s.isWon || s.isLost)).map(([id]) => id);
  const open = [...L.stages].filter(([, s]) => !s.isWon && !s.isLost).map(([id]) => id);
  const extra: Prisma.LeadWhereInput =
    def.basis === 'created' ? { createdAt: range }
    : def.basis === 'closed' ? { stageChangedAt: range, stageId: { in: wonLost } }
    : { stageId: { in: open } };
  const needValue = ['pipeline_value', 'weighted_pipeline', 'won_value'].includes(metric);
  const rows = await c.tx.lead.findMany({
    where: { AND: [leadWhere(c), extra] },
    select: { createdAt: true, stageId: true, stageChangedAt: true, status: true, source: true, ownerId: true, workspaceId: true, firstResponseAt: true, lostReason: true, ...(needValue ? { customFields: true } : {}) },
    take: LIMIT,
  });
  const now = Date.now();
  for (const l of rows) {
    const st = L.stages.get(l.stageId);
    let num = 1;
    let den = 1;
    switch (metric) {
      case 'win_rate': num = st?.isWon ? 1 : 0; break;
      case 'contact_rate': num = l.firstResponseAt ? 1 : 0; break;
      case 'first_response':
        if (!l.firstResponseAt) continue;
        num = Math.max(0, (l.firstResponseAt.getTime() - l.createdAt.getTime()) / 3_600_000); break;
      case 'stuck_leads':
        if (!st?.slaDays || Math.floor((now - l.stageChangedAt.getTime()) / 86_400_000) < st.slaDays) continue;
        break;
      case 'pipeline_value': case 'won_value': num = dealValue(L, l.workspaceId, (l as { customFields?: unknown }).customFields); break;
      case 'weighted_pipeline': num = Math.round((dealValue(L, l.workspaceId, (l as { customFields?: unknown }).customFields) * (st?.prob ?? 0)) / 100); break;
    }
    const date = def.basis === 'closed' ? l.stageChangedAt : l.createdAt;
    const key =
      g === 'stage' ? l.stageId : g === 'status' ? l.status ?? '__none__' : g === 'source' ? l.source : g === 'owner' ? l.ownerId ?? '__unassigned__'
      : g === 'workspace' ? l.workspaceId : g === 'lost_reason' ? l.lostReason ?? '—' : ['day', 'week', 'month'].includes(g) ? bucket(date) : null;
    put(key, num, den);
  }
  return { all, groups };
}

function toSeries(L: Lookups, metric: string, g: GroupBy, groups: Map<string, Agg>, r: Range): Point[] {
  const val = (a?: Agg) => (a ? total(metric, a) ?? 0 : 0);
  if (g === 'day' || g === 'week' || g === 'month') {
    return timeKeys(g, r, L.tz).map((k) => ({ key: k, label: timeLabel(g, k), value: val(groups.get(k)), count: groups.get(k)?.den ?? 0 }));
  }
  if (g === 'heatmap') {
    return [...groups].map(([k, a]) => { const [x, y] = k.split(':').map(Number); return { key: k, label: `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][x]} ${y}:00`, value: val(a), x, y, count: a.den }; });
  }
  const label = (k: string) =>
    g === 'stage' ? L.stages.get(k)?.name ?? '—'
    : g === 'owner' ? (k === '__unassigned__' ? 'Unassigned' : L.users.get(k) ?? 'Former user')
    : g === 'workspace' ? L.workspaces.get(k)?.name ?? '—'
    : g === 'status' ? (k === '__none__' ? 'No status' : L.labels.lead_status.get(k) ?? k)
    : g === 'source' ? L.labels.lead_source.get(k) ?? k
    : g === 'disposition' ? L.labels.call_disposition.get(k) ?? k
    : k;
  const pts: Point[] = [...groups].map(([k, a]) => ({ key: k, label: label(k), value: val(a), count: a.den, ...(g === 'stage' ? { color: L.stages.get(k)?.color ?? null } : {}) }));
  if (g === 'stage') {
    return pts.sort((a, b) => {
      const sa = L.stages.get(a.key); const sb = L.stages.get(b.key);
      return (sa?.pipelineId ?? '').localeCompare(sb?.pipelineId ?? '') || (sa?.position ?? 0) - (sb?.position ?? 0);
    });
  }
  return pts.sort((a, b) => b.value - a.value).slice(0, 30);
}

// ── Special widgets ──

/** Funnel of leads created in the range: how many reached each stage (from the stage history), by pipeline. */
export async function funnel(c: Ctx, r: Range) {
  const leads = await c.tx.lead.findMany({ where: { AND: [leadWhere(c), { createdAt: { gte: r.from, lt: r.to } }] }, select: { id: true, stageId: true, pipelineId: true }, take: LIMIT });
  if (!leads.length) return { pipeline: null, steps: [] as Point[], total: 0 };
  const byPipe = new Map<string, number>();
  for (const l of leads) byPipe.set(l.pipelineId, (byPipe.get(l.pipelineId) ?? 0) + 1);
  const pipelineId = [...byPipe].sort((a, b) => b[1] - a[1])[0][0];
  const mine = leads.filter((l) => l.pipelineId === pipelineId);
  const moves = await c.tx.leadActivity.findMany({ where: { type: 'stage', leadId: { in: mine.map((l) => l.id) } }, select: { leadId: true, data: true }, take: LIMIT });
  const reached = new Map<string, number>(); // lead → highest open/won position reached
  const pos = (sid: unknown) => { const s = c.L.stages.get(String(sid)); return s && !s.isLost ? s.position : -1; };
  for (const l of mine) reached.set(l.id, Math.max(0, pos(l.stageId)));
  for (const m of moves) reached.set(m.leadId, Math.max(reached.get(m.leadId) ?? 0, pos((m.data as { to?: string } | null)?.to)));
  const stages = [...c.L.stages].filter(([, s]) => s.pipelineId === pipelineId && !s.isLost).sort((a, b) => a[1].position - b[1].position);
  const steps = stages.map(([id, s]) => ({
    key: id, label: s.name, color: s.color,
    value: s.isWon ? mine.filter((l) => c.L.stages.get(l.stageId)?.isWon).length : [...reached.values()].filter((p) => p >= s.position).length,
  }));
  const pipeName = await c.tx.pipeline.findUnique({ where: { id: pipelineId }, select: { name: true } });
  return { pipeline: pipeName?.name ?? null, steps, total: mine.length };
}

/** Per-person numbers for the range. */
export async function leaderboard(c: Ctx, r: Range) {
  const [leads, won, lost, calls] = await Promise.all([
    aggregate(c, 'leads', 'owner', r.from, r.to), aggregate(c, 'won', 'owner', r.from, r.to),
    aggregate(c, 'lost', 'owner', r.from, r.to), aggregate(c, 'calls', 'owner', r.from, r.to),
  ]);
  const [connected, talk] = await Promise.all([aggregate(c, 'connected_calls', 'owner', r.from, r.to), aggregate(c, 'talk_time', 'owner', r.from, r.to)]);
  const ids = new Set([...leads.groups.keys(), ...won.groups.keys(), ...calls.groups.keys()].filter((k) => k !== '__unassigned__' && k !== '—'));
  return [...ids].map((id) => {
    const w = won.groups.get(id)?.num ?? 0;
    const l = lost.groups.get(id)?.num ?? 0;
    const cl = calls.groups.get(id)?.num ?? 0;
    const cn = connected.groups.get(id)?.num ?? 0;
    return {
      userId: id, name: c.L.users.get(id) ?? 'Former user', leads: leads.groups.get(id)?.num ?? 0, calls: cl, connected: cn,
      connectRate: cl ? Math.round((cn / cl) * 100) : null, talkMinutes: talk.groups.get(id)?.num ?? 0, won: w, winRate: w + l ? Math.round((w / (w + l)) * 100) : null,
    };
  }).sort((a, b) => b.won - a.won || b.connected - a.connected || b.calls - a.calls).slice(0, 25);
}

/** Open follow-ups due by the end of today (overdue first). */
export async function followUpList(c: Ctx) {
  const p = localParts(new Date(), c.L.tz);
  const end = midnight(p.y, p.m, p.d + 1, c.L.tz);
  const rows = await c.tx.followUp.findMany({
    where: { doneAt: null, dueAt: { lt: end }, lead: leadWhere({ ...c, filters: { ...c.filters, ownerIds: undefined } }), ...(c.filters.ownerIds?.length ? { userId: { in: c.filters.ownerIds } } : {}) },
    orderBy: { dueAt: 'asc' }, take: 25,
    select: { id: true, dueAt: true, note: true, userId: true, lead: { select: { id: true, customer: { select: { name: true, mobile: true } } } } },
  });
  return rows.map((f) => ({ id: f.id, leadId: f.lead.id, name: f.lead.customer.name, mobile: f.lead.customer.mobile, dueAt: f.dueAt, note: f.note, owner: c.L.users.get(f.userId) ?? null, overdue: f.dueAt < new Date() }));
}

/**
 * Month-end forecast (statistical, no AI): wins so far + expected wins from open leads weighted by stage
 * probability, and the run-rate projection; the same for deal value where a value field is set.
 */
export async function forecast(c: Ctx) {
  const r = resolveRange('this_month', c.L.tz);
  const [wonSoFar, wonValue, weighted] = await Promise.all([
    aggregate(c, 'won', 'none', r.from, r.to), aggregate(c, 'won_value', 'none', r.from, r.to), aggregate(c, 'weighted_pipeline', 'none', r.from, r.to),
  ]);
  const openLeads = await c.tx.lead.findMany({ where: { AND: [leadWhere(c), { stageId: { in: [...c.L.stages].filter(([, s]) => !s.isWon && !s.isLost).map(([id]) => id) } }] }, select: { stageId: true }, take: LIMIT });
  const expectedWins = openLeads.reduce((n, l) => n + (c.L.stages.get(l.stageId)?.prob ?? 0) / 100, 0);
  const elapsed = Math.max(1, (Date.now() - r.from.getTime()) / 86_400_000);
  const days = (r.to.getTime() - r.from.getTime()) / 86_400_000;
  const runRate = (wonSoFar.all.num / elapsed) * days;
  return {
    wonSoFar: wonSoFar.all.num, runRateWins: Math.round(runRate), pipelineWins: Math.round(wonSoFar.all.num + expectedWins),
    wonValueSoFar: wonValue.all.num, runRateValue: Math.round((wonValue.all.num / elapsed) * days), weightedPipelineValue: weighted.all.num,
    openLeads: openLeads.length, daysLeft: Math.max(0, Math.ceil((r.to.getTime() - Date.now()) / 86_400_000)),
  };
}
