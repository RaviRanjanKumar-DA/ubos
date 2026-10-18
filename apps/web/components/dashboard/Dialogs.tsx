'use client';

import { useEffect, useState } from 'react';
import { GROUP_LABELS, GroupBy, METRIC_CATEGORIES, METRICS, RANGE_LABELS, RangePreset, SPECIAL_WIDGETS, WIDGET_LABELS, WidgetConfig, WidgetType } from '@ubos/shared';
import { api } from '@/lib/api';

const TYPE_HINT: Record<WidgetType, string> = {
  kpi: 'One number with the change vs the previous period', line: 'How a number moves day by day, week or month', bar: 'Compare people, stages, sources…',
  pie: 'Share of a total', funnel: 'How far new leads get', table: 'Exact numbers per group', leaderboard: 'People ranked by wins, calls and more',
  heatmap: 'Best weekday and hour', gauge: 'Progress towards a target', followups: 'Follow-ups due today and overdue', forecast: 'Where this month will land', goals: 'Progress towards the goals you can see',
};
/** Groupings that make sense for each chart type. */
const TYPE_GROUPS: Partial<Record<WidgetType, GroupBy[]>> = {
  kpi: ['none'], gauge: ['none'], line: ['day', 'week', 'month'], heatmap: ['heatmap'],
  bar: ['stage', 'status', 'source', 'owner', 'workspace', 'disposition', 'lost_reason', 'activity_type', 'day', 'week', 'month'],
  pie: ['stage', 'status', 'source', 'owner', 'workspace', 'disposition', 'lost_reason', 'activity_type'],
  table: ['stage', 'status', 'source', 'owner', 'workspace', 'disposition', 'lost_reason', 'activity_type', 'day', 'week', 'month'],
};

export function WidgetDialog({ widget, onClose, onSave }: { widget: WidgetConfig | null; onClose: () => void; onSave: (w: WidgetConfig) => void }) {
  const [w, setW] = useState<WidgetConfig>(widget ?? { id: `w${Date.now().toString(36)}`, type: 'kpi', title: '', metric: 'leads', groupBy: 'none', w: 3, h: 1 });
  const special = SPECIAL_WIDGETS.includes(w.type);
  const groups = (TYPE_GROUPS[w.type] ?? []).filter((g) => !w.metric || METRICS[w.metric].groupBy.includes(g));
  const metrics = Object.entries(METRICS).filter(([, m]) => (TYPE_GROUPS[w.type] ?? []).some((g) => m.groupBy.includes(g)));
  const format = w.metric ? METRICS[w.metric].format : 'count';
  // Keep the grouping valid when the type or metric changes.
  useEffect(() => {
    if (special) return;
    if (w.metric && !metrics.some(([k]) => k === w.metric)) setW((x) => ({ ...x, metric: metrics[0]?.[0] }));
    else if (!groups.includes(w.groupBy ?? 'none')) setW((x) => ({ ...x, groupBy: groups[0] ?? 'none' }));
  }, [w.type, w.metric]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickType = (t: WidgetType) => setW({
    ...w, type: t,
    w: t === 'kpi' ? 3 : t === 'leaderboard' ? 12 : w.w === 3 ? 6 : w.w,
    h: t === 'kpi' ? 1 : w.h === 1 ? 2 : w.h,
  });
  const autoTitle = () => (special ? WIDGET_LABELS[w.type] : `${w.metric ? METRICS[w.metric].label : ''}${w.groupBy && w.groupBy !== 'none' ? ` by ${GROUP_LABELS[w.groupBy].toLowerCase()}` : ''}`);

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 680, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onSave({ ...w, title: w.title.trim() || autoTitle(), ...(special ? { metric: undefined, groupBy: undefined } : {}) }); }}>
        <h2>{widget ? 'Edit widget' : 'Add a widget'}</h2>
        <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>1. Chart type</div>
        <div className="widget-types">
          {(Object.keys(WIDGET_LABELS) as WidgetType[]).map((t) => (
            <button type="button" key={t} className={`widget-type ${w.type === t ? 'on' : ''}`} onClick={() => pickType(t)}>
              <b>{WIDGET_LABELS[t]}</b><span className="small muted">{TYPE_HINT[t]}</span>
            </button>
          ))}
        </div>
        {!special && (
          <>
            <div className="small" style={{ fontWeight: 600, margin: '12px 0 6px' }}>2. What to measure</div>
            <div className="grid cols-2">
              <div className="field">
                <label>Metric</label>
                <select className="input" value={w.metric} onChange={(e) => setW({ ...w, metric: e.target.value })}>
                  {METRIC_CATEGORIES.map((cat) => {
                    const items = metrics.filter(([, m]) => m.category === cat);
                    return items.length ? <optgroup key={cat} label={cat}>{items.map(([k, m]) => <option key={k} value={k}>{m.label}{m.audit ? ' (audit access)' : ''}</option>)}</optgroup> : null;
                  })}
                </select>
                {w.metric && <span className="small muted">{METRICS[w.metric].hint}</span>}
              </div>
              {groups.length > 1 || (groups[0] && groups[0] !== 'none') ? (
                <div className="field">
                  <label>Split by</label>
                  <select className="input" value={w.groupBy} onChange={(e) => setW({ ...w, groupBy: e.target.value as GroupBy })}>
                    {groups.map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
                  </select>
                </div>
              ) : <div />}
              {w.type === 'gauge' && (
                <div className="field">
                  <label>Target {format === 'currency' ? '(₹)' : format === 'percent' ? '(%)' : ''}</label>
                  <input className="input" type="number" min={0} required value={w.target === undefined ? '' : format === 'currency' ? w.target / 100 : w.target}
                    onChange={(e) => setW({ ...w, target: e.target.value === '' ? undefined : Number(e.target.value) * (format === 'currency' ? 100 : 1) })} />
                </div>
              )}
            </div>
          </>
        )}
        <div className="small" style={{ fontWeight: 600, margin: '12px 0 6px' }}>{special ? '2' : '3'}. Title, period and size</div>
        <div className="grid cols-2">
          <div className="field"><label>Title</label><input className="input" value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} placeholder={autoTitle()} /></div>
          <div className="field">
            <label>Period</label>
            <select className="input" value={w.range ?? ''} onChange={(e) => setW({ ...w, range: (e.target.value || undefined) as RangePreset | undefined })} disabled={w.type === 'followups' || w.type === 'forecast'}>
              <option value="">Same as the dashboard</option>
              {(Object.keys(RANGE_LABELS) as RangePreset[]).filter((r) => r !== 'custom').map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Width</label>
            <select className="input" value={w.w} onChange={(e) => setW({ ...w, w: Number(e.target.value) as WidgetConfig['w'] })}>
              <option value={3}>Quarter</option><option value={4}>Third</option><option value={6}>Half</option><option value={8}>Two thirds</option><option value={12}>Full width</option>
            </select>
          </div>
          <div className="field">
            <label>Height</label>
            <select className="input" value={w.h} onChange={(e) => setW({ ...w, h: Number(e.target.value) as WidgetConfig['h'] })}>
              <option value={1}>Small</option><option value={2}>Medium</option><option value={3}>Large</option>
            </select>
          </div>
        </div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">{widget ? 'Save widget' : 'Add widget'}</button>
        </div>
      </form>
    </div>
  );
}

export interface SharingState { sharedRoleIds: string[]; sharedTeamIds: string[]; sharedWorkspaceIds: string[]; sharedUserIds: string[]; defaultForRoleIds: string[]; isLocked: boolean }
type Opt = { id: string; name: string };

export function ShareDialog({ name, value, orgWide, workspaces, onClose, onSave }: {
  name: string; value: SharingState; orgWide: boolean; workspaces: Opt[]; onClose: () => void; onSave: (s: SharingState) => void;
}) {
  const [s, setS] = useState<SharingState>(value);
  const [roles, setRoles] = useState<Opt[]>([]);
  const [teams, setTeams] = useState<Opt[]>([]);
  const [users, setUsers] = useState<Opt[]>([]);
  useEffect(() => {
    if (orgWide) {
      api<Opt[]>('/api/v1/roles', { noWorkspace: true }).then((r) => setRoles(r.map((x) => ({ id: x.id, name: x.name })))).catch(() => {});
      api<{ branches: { departments: { teams: Opt[] }[] }[] }>('/api/v1/org/structure', { noWorkspace: true })
        .then((o) => setTeams(o.branches.flatMap((b) => b.departments.flatMap((d) => d.teams.map((t) => ({ id: t.id, name: t.name })))))).catch(() => {});
    }
    api<(Opt & { isActive: boolean })[]>('/api/v1/users', { noWorkspace: true }).then((u) => setUsers(u.filter((x) => x.isActive).map((x) => ({ id: x.id, name: x.name })))).catch(() => {});
  }, [orgWide]);
  const toggle = (k: keyof Omit<SharingState, 'isLocked'>, id: string) => setS({ ...s, [k]: s[k].includes(id) ? s[k].filter((x) => x !== id) : [...s[k], id] });
  const Chips = ({ k, items }: { k: keyof Omit<SharingState, 'isLocked'>; items: Opt[] }) => (
    <div className="chips" style={{ marginBottom: 10 }}>
      {items.map((o) => <button type="button" key={o.id} className={`chip ${s[k].includes(o.id) ? 'on' : ''}`} onClick={() => toggle(k, o.id)}>{o.name}</button>)}
      {!items.length && <span className="small muted">None available</span>}
    </div>
  );
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 640, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(s); }}>
        <h2>Share “{name}”</h2>
        <p className="small muted" style={{ marginTop: -4 }}>Everyone sees only the numbers their own access allows — an RM sees their own leads, a manager their business line.</p>
        {orgWide && <><div className="small" style={{ fontWeight: 600 }}>Roles</div><Chips k="sharedRoleIds" items={roles} /></>}
        {orgWide && <><div className="small" style={{ fontWeight: 600 }}>Teams</div><Chips k="sharedTeamIds" items={teams} /></>}
        <div className="small" style={{ fontWeight: 600 }}>Business lines</div><Chips k="sharedWorkspaceIds" items={workspaces} />
        <div className="small" style={{ fontWeight: 600 }}>People</div><Chips k="sharedUserIds" items={users} />
        {orgWide && (
          <>
            <div className="small" style={{ fontWeight: 600 }}>Make it the landing dashboard for</div>
            <Chips k="defaultForRoleIds" items={roles} />
          </>
        )}
        <label className="row small"><input type="checkbox" checked={s.isLocked} onChange={(e) => setS({ ...s, isLocked: e.target.checked })} /> Lock — only you can change it (others can still duplicate it)</label>
        <div className="row end" style={{ marginTop: 12 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">Save sharing</button>
        </div>
      </form>
    </div>
  );
}
