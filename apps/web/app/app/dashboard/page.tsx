'use client';

import { Menu } from '@/components/Menu';
import { Icon } from '@/components/Icon';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GROUP_LABELS, METRICS, RANGE_LABELS, RangePreset, WidgetConfig } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { CROSS_GROUPS, MetricData, WidgetBody } from '@/components/dashboard/Widget';
import { ShareDialog, SharingState, WidgetDialog } from '@/components/dashboard/Dialogs';
import { fmt, Pt } from '@/components/dashboard/charts';
import type { WorkspaceSettings } from '@/lib/workspace';

interface ListItem { id: string; name: string; description: string | null; isMine?: boolean; isShared?: boolean; isLocked?: boolean; widgetCount?: number }
interface DashList { templates: { key: string; name: string; description: string }[]; mine: ListItem[]; shared: ListItem[]; defaultId: string; canShare: boolean }
interface Dash {
  id: string; name: string; description: string | null; widgets: WidgetConfig[]; range: RangePreset; isTemplate: boolean;
  canEdit: boolean; canShare: boolean; isMine?: boolean; isLocked?: boolean; sharing?: SharingState;
}
type Opt = { id: string; name: string };
type Msg = { type: 'error' | 'notice'; text: string } | null;
/** A filter set by clicking a chart: applies to every card. */
interface Cross { group: string; key: string; label: string }

const LAST = 'ubos.dashboard.last';
const remember = (id: string) => { try { localStorage.setItem(LAST, id); } catch { /* storage unavailable */ } };
const recall = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
const periodOf = (d: unknown) => (d && typeof d === 'object' && 'label' in d ? String((d as { label: unknown }).label ?? '') : '');
const TAB_SHORT: Record<string, string> = {
  management: 'Management', company: 'Company', business_line: 'Business line', team_audit: 'Team performance', team: 'Team', marketing: 'Marketing', my_day: 'My day',
};

function FilterBox({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <label className="fbox">
      <span className="fbox-icon" aria-hidden="true"><Icon name={icon} className="ic" /></span>
      <span className="fbox-main"><span className="fbox-label">{label}</span>{children}</span>
    </label>
  );
}

export default function DashboardPage() {
  const { me, can, version } = useShell();
  const router = useRouter();
  const [list, setList] = useState<DashList | null>(null);
  const [dash, setDash] = useState<Dash | null>(null);
  const [range, setRange] = useState<RangePreset>('this_month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [compare, setCompare] = useState(true);
  const [owner, setOwner] = useState('');
  const [line, setLine] = useState('');
  const [team, setTeam] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [cross, setCross] = useState<Cross[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [teams, setTeams] = useState<Opt[]>([]);
  const [people, setPeople] = useState<Opt[]>([]);
  const [statuses, setStatuses] = useState<Opt[]>([]);
  const [sources, setSources] = useState<Opt[]>([]);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<{ name: string; widgets: WidgetConfig[] } | null>(null);
  const [dialog, setDialog] = useState<WidgetConfig | 'new' | null>(null);
  const [sharing, setSharing] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const editing = !!draft;
  const widgets = draft?.widgets ?? dash?.widgets ?? [];
  const scope = me.permissions['dashboard.view'];

  const open = useCallback(async (id: string) => {
    setMsg(null);
    setDraft(null);
    try {
      const d = await api<Dash>(`/api/v1/dashboards/${encodeURIComponent(id)}`);
      setDash(d);
      setRange(d.range ?? 'this_month');
      remember(id);
    } catch (e) {
      if (id !== list?.defaultId && list) return open(list.defaultId);
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed' });
    }
  }, [list]);

  const loadList = useCallback(async (pick?: string) => {
    const l = await api<DashList>('/api/v1/dashboards');
    setList(l);
    return { l, target: pick ?? recall() ?? l.defaultId };
  }, []);

  useEffect(() => {
    if (!scope) return;
    loadList().then(({ l, target }) => {
      const known = target.startsWith('tpl:') ? l.templates.some((t) => `tpl:${t.key}` === target) : [...l.mine, ...l.shared].some((d) => d.id === target);
      const id = known ? target : l.defaultId;
      api<Dash>(`/api/v1/dashboards/${encodeURIComponent(id)}`).then((d) => { setDash(d); setRange(d.range ?? 'this_month'); }).catch((e) => setMsg({ type: 'error', text: e.message }));
    }).catch((e) => setMsg({ type: 'error', text: e.message }));
    setOwner(''); setLine(''); setTeam(''); setStatus(''); setSource(''); setCross([]);
    if (scope !== 'OWN' && can('org.user.view')) {
      api<{ branches: { departments: { teams: Opt[] }[] }[] }>('/api/v1/org/structure', { noWorkspace: true })
        .then((o) => setTeams(o.branches.flatMap((b) => b.departments.flatMap((d) => d.teams)))).catch(() => setTeams([]));
    } else setTeams([]);
    const ws = me.currentWorkspaceId;
    if (scope !== 'OWN') {
      (ws ? api<Opt[]>(`/api/v1/workspaces/${ws}/assignees`) : can('org.user.view') ? api<(Opt & { isActive: boolean })[]>('/api/v1/users').then((u) => u.filter((x) => x.isActive)) : Promise.resolve([]))
        .then((p) => setPeople(p.map((x) => ({ id: x.id, name: x.name })))).catch(() => setPeople([]));
    } else setPeople([]);
    // Status and source choices from the business lines in view.
    const lines = ws ? [ws] : me.workspaces.map((w) => w.id);
    Promise.all(lines.map((id) => api<WorkspaceSettings>(`/api/v1/workspaces/${id}/settings`, { workspace: id }).catch(() => null))).then((all) => {
      const merge = (k: 'statuses' | 'sources') => [...new Map(all.flatMap((s) => s?.[k] ?? []).map((o) => [o.value!, { id: o.value!, name: o.label }])).values()];
      setStatuses(merge('statuses'));
      setSources(merge('sources'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  /** Dropdown filters, then chart clicks on top (a clicked value replaces the dropdown for that field). */
  const filters = useMemo(() => {
    const f: Record<string, string[]> = {};
    if (owner) f.ownerIds = [owner];
    if (line) f.workspaceIds = [line];
    if (team) f.teamIds = [team];
    if (status) f.statuses = [status];
    if (source) f.sources = [source];
    const field: Record<string, string> = { owner: 'ownerIds', source: 'sources', status: 'statuses', stage: 'stageIds', workspace: 'workspaceIds' };
    for (const c of cross) {
      if (c.key === '__unassigned__') continue;
      f[field[c.group]] = [c.key];
    }
    return f;
  }, [owner, line, team, status, source, cross]);

  const widgetKey = JSON.stringify(widgets.map(({ id, type, metric, groupBy, range: r, target }) => ({ id, type, metric, groupBy, r, target })));
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    if (!widgets.length || (range === 'custom' && (!from || !to))) { setData({}); return; }
    setLoading(true);
    api<Record<string, unknown>>('/api/v1/analytics/batch', { method: 'POST', body: { range, from: from || undefined, to: to || undefined, compare, filters, widgets } })
      .then(setData).catch((e) => setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Could not load the numbers' })).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetKey, range, from, to, compare, filterKey, version]);

  async function run(fn: () => Promise<unknown>, text: string) {
    setMsg(null);
    try { await fn(); setMsg({ type: 'notice', text }); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  }

  async function saveCopy(name: string, ws: WidgetConfig[]) {
    let id = '';
    if (await run(async () => { id = (await api<{ id: string }>('/api/v1/dashboards', { method: 'POST', body: { name, range, widgets: ws } })).id; }, 'Saved to My dashboards.')) {
      await loadList();
      await open(id);
      setMsg({ type: 'notice', text: `Saved as “${name}” in My dashboards.` });
      return id;
    }
    return null;
  }

  async function saveDraft() {
    if (!dash || !draft) return;
    if (dash.isTemplate || !dash.canEdit) { await saveCopy(draft.name, draft.widgets); return; }
    if (await run(() => api(`/api/v1/dashboards/${dash.id}`, { method: 'PATCH', body: { name: draft.name, range, widgets: draft.widgets } }), 'Dashboard saved.')) {
      setDash({ ...dash, name: draft.name, widgets: draft.widgets, range });
      setDraft(null);
      loadList();
    }
  }

  function exportCsv() {
    const rows: string[][] = [['Widget', 'Item', 'Value']];
    for (const w of widgets) {
      const d = data[w.id] as MetricData | undefined;
      if (!d || !('format' in d)) continue;
      if (d.series?.length) for (const p of d.series) rows.push([w.title, p.label, fmt(p.value, d.format)]);
      else rows.push([w.title, 'Total', fmt(d.value, d.format)]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `${dash?.name ?? 'dashboard'}.csv` }).click();
    URL.revokeObjectURL(url);
  }

  const onCross = (w: WidgetConfig, p: Pt) => {
    const group = w.groupBy ?? '';
    if (!CROSS_GROUPS.includes(group)) return;
    setCross((cur) => {
      const same = cur.find((c) => c.group === group);
      if (same?.key === p.key) return cur.filter((c) => c.group !== group); // click again to clear
      return [...cur.filter((c) => c.group !== group), { group, key: p.key, label: p.label.replace(/^● /, '') }];
    });
  };
  const leadsLink = () => {
    const q = new URLSearchParams();
    const map: Record<string, string> = { ownerIds: 'owners', sources: 'sources', statuses: 'statuses', stageIds: 'stageIds' };
    for (const [k, v] of Object.entries(filters)) if (map[k]) q.set(map[k], v.join(','));
    return `/app/leads?${q.toString()}`;
  };

  const move = (fromIdx: number, toIdx: number) => {
    if (!draft || fromIdx === toIdx) return;
    const next = [...draft.widgets];
    const [m] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, m);
    setDraft({ ...draft, widgets: next });
  };
  const tabs = useMemo(() => list ? [
    ...list.templates.map((t) => ({ id: `tpl:${t.key}`, name: TAB_SHORT[t.key] ?? t.name, hint: t.description, kind: '' })),
    ...list.mine.map((d) => ({ id: d.id, name: d.name, hint: 'My dashboard', kind: 'mine' })),
    ...list.shared.map((d) => ({ id: d.id, name: d.name, hint: 'Shared with me', kind: d.isLocked ? 'locked' : 'shared' })),
  ] : [], [list]);
  const activeFilters = [owner, line, team, status, source].filter(Boolean).length + cross.length + (range === 'custom' ? 1 : 0);

  if (!scope) return <div className="notice">Your role has no dashboard access. Ask your administrator for “View dashboards”.</div>;
  const scopeText = scope === 'OWN' ? 'your own leads and calls' : scope === 'TEAM' ? 'your team' : scope === 'WORKSPACE' ? 'your business lines' : me.currentWorkspaceId ? 'this business line' : 'the whole organization';

  return (
    <>
      <div className="dash-head">
        <div style={{ minWidth: 0 }}>
          {editing ? (
            <input className="input" style={{ fontSize: 22, fontWeight: 750, height: 42, maxWidth: 420 }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Dashboard name" />
          ) : <h1 style={{ margin: 0 }}>{dash?.name ?? 'Dashboard'}</h1>}
          <div className="small muted">{dash?.description ? `${dash.description} ` : ''}Showing {scopeText}.</div>
        </div>
        <div className="row">
          {!editing && (
            <>
              {dash && <EmailMe dashboardId={dash.id} />}
              <Menu items={[
                { label: dash?.canEdit && !dash.isTemplate ? 'Edit this dashboard' : 'Customise a copy', icon: 'edit', hidden: !dash, onClick: () => dash && setDraft({ name: dash.canEdit && !dash.isTemplate ? dash.name : `${dash.name} (my copy)`, widgets: dash.widgets }) },
                { label: 'Share', icon: 'share', hidden: !(dash?.canShare && !dash.isTemplate && list?.canShare), onClick: () => setSharing(true) },
                { label: 'New dashboard', icon: 'plus', onClick: () => saveCopy('My dashboard', [{ id: 'k1', type: 'kpi', title: 'New leads', metric: 'leads', groupBy: 'none', w: 3, h: 1 }]).then((id) => { if (id) setDraft({ name: 'My dashboard', widgets: [{ id: 'k1', type: 'kpi', title: 'New leads', metric: 'leads', groupBy: 'none', w: 3, h: 1 }] }); }) },
              ]} />
            </>
          )}
          {editing && (
            <>
              <button className="btn outline" onClick={() => setDialog('new')}>+ Add widget</button>
              <button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn" onClick={saveDraft} disabled={!draft.name.trim()}>{dash?.isTemplate || !dash?.canEdit ? 'Save as my dashboard' : 'Save'}</button>
            </>
          )}
        </div>
      </div>

      {!editing && tabs.length > 0 && (
        <div className="dash-tabs" role="tablist" aria-label="Dashboards">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={dash?.id === t.id} className={`dash-tab ${dash?.id === t.id ? 'on' : ''}`} title={t.hint} onClick={() => { setCross([]); open(t.id); }}>
              {t.kind === 'mine' ? <Icon name="star" className="ic" /> : t.kind === 'locked' ? <Icon name="lock" className="ic" /> : t.kind === 'shared' ? <Icon name="share" className="ic" /> : null}{t.name}
            </button>
          ))}
        </div>
      )}

      <div className="card fbar">
        <FilterBox icon="calendar" label="Period">
          <select value={range} onChange={(e) => setRange(e.target.value as RangePreset)}>
            {(Object.keys(RANGE_LABELS) as RangePreset[]).map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
          </select>
        </FilterBox>
        {!me.currentWorkspaceId && me.workspaces.length > 1 && (
          <FilterBox icon="tenants" label="Business line">
            <select value={line} onChange={(e) => setLine(e.target.value)}>
              <option value="">All business lines</option>
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </FilterBox>
        )}
        {teams.length > 0 && (
          <FilterBox icon="leads" label="Team">
            <select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All teams</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </FilterBox>
        )}
        {people.length > 0 && (
          <FilterBox icon="hr" label="RM / person">
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Everyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </FilterBox>
        )}
        <FilterBox icon="radio" label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__none__">No status</option>
          </select>
        </FilterBox>
        <FilterBox icon="trend" label="Source">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </FilterBox>
        <div className="fbar-actions" ref={moreRef}>
          <button className={`btn outline ${moreOpen ? 'on' : ''}`} onClick={() => setMoreOpen(!moreOpen)}><Icon name="funnel" className="ic" /> More filters <Icon name="chevron" className="ic" /></button>
          {moreOpen && (
            <div className="card fbar-more">
              <div className="field">
                <label>Custom dates</label>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setRange('custom'); }} aria-label="From" />
                  <span className="muted">to</span>
                  <input className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setRange('custom'); }} aria-label="To" />
                </div>
              </div>
              <label className="row small"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare with the previous period</label>
              {activeFilters > 0 && (
                <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => { setOwner(''); setLine(''); setTeam(''); setStatus(''); setSource(''); setCross([]); setRange(dash?.range ?? 'this_month'); setFrom(''); setTo(''); }}>Clear all filters</button>
              )}
            </div>
          )}
          {can('crm.lead.export') && <button className="btn outline" onClick={exportCsv}><Icon name="download" className="ic" /> Export</button>}
        </div>
      </div>
      <div className="fbar-foot">
        {cross.length > 0 ? (
          <>
            <span className="small">Filtered by</span>
            {cross.map((c) => (
              <button key={c.group} className="chip on" onClick={() => setCross(cross.filter((x) => x.group !== c.group))} title="Remove">{GROUP_LABELS[c.group as keyof typeof GROUP_LABELS]}: {c.label} <Icon name="close" className="ic" /></button>
            ))}
            <Link className="small" href={leadsLink()}>View these leads →</Link>
          </>
        ) : <span className="small muted fbar-tip">Tip: click a bar, slice or row to filter every card; click it again to clear.</span>}
        <span style={{ flex: 1 }} />
        {loading && <span className="small muted">Updating…</span>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {editing && <div className="notice small">Drag widgets to reorder. Use the pencil to change a widget, or the size buttons to resize it.</div>}

      <div className="dash-grid">
        {widgets.map((w, i) => (
          <section key={w.id} className={`card dash-widget w${w.w} h${w.h} ${editing ? 'editing' : ''} ${drag === i ? 'dragging' : ''}`}
            draggable={editing} onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)} onDragOver={(e) => editing && e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}>
            <header className="dash-widget-head">
              {editing && <span className="drag-handle" aria-hidden="true">⠿</span>}
              <h3 title={w.title}>{w.title}</h3>
              {!editing && <span className="small muted">{w.metric && METRICS[w.metric].basis === 'none' ? 'Now' : w.type === 'followups' ? 'Today' : w.type === 'forecast' ? 'This month' : periodOf(data[w.id])}</span>}
              {editing && draft && (
                <span className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
                  <button className="btn sm ghost" title="Narrower" aria-label="Narrower" onClick={() => setDraft({ ...draft, widgets: draft.widgets.map((x, j) => (j === i ? { ...x, w: ([3, 3, 4, 6, 8] as const)[[3, 4, 6, 8, 12].indexOf(x.w)] } : x)) })}>◂</button>
                  <button className="btn sm ghost" title="Wider" aria-label="Wider" onClick={() => setDraft({ ...draft, widgets: draft.widgets.map((x, j) => (j === i ? { ...x, w: ([4, 6, 8, 12, 12] as const)[[3, 4, 6, 8, 12].indexOf(x.w)] } : x)) })}>▸</button>
                  <button className="btn sm ghost" title="Taller / shorter" aria-label="Change height" onClick={() => setDraft({ ...draft, widgets: draft.widgets.map((x, j) => (j === i ? { ...x, h: ((x.h % 3) + 1) as WidgetConfig['h'] } : x)) })}>↕</button>
                  <button className="btn sm ghost" title="Edit" aria-label="Edit widget" onClick={() => setDialog(w)}><Icon name="edit" className="ic" /></button>
                  <button className="btn sm ghost" title="Remove" aria-label="Remove widget" style={{ color: 'var(--bad)' }} onClick={() => setDraft({ ...draft, widgets: draft.widgets.filter((_, j) => j !== i) })}><Icon name="close" className="ic" /></button>
                </span>
              )}
            </header>
            <div className="dash-widget-body">
              <WidgetBody w={w} data={data[w.id]} onDrill={(href) => router.push(href)} onCross={editing ? undefined : onCross}
                active={cross.filter((c) => c.group === w.groupBy).map((c) => c.key)} />
            </div>
          </section>
        ))}
        {editing && (
          <button className="card dash-widget w3 h1 add-widget" onClick={() => setDialog('new')}>+ Add widget</button>
        )}
      </div>
      {!widgets.length && !editing && dash && <div className="empty">This dashboard has no widgets yet.</div>}

      {dash && !dash.isTemplate && !editing && (dash.isMine || list?.canShare) && (
        <div className="row end" style={{ marginTop: 14 }}>
          <button className="btn sm ghost" style={{ color: 'var(--bad)' }} onClick={() => {
            if (confirm(`Delete the dashboard “${dash.name}”?`)) run(() => api(`/api/v1/dashboards/${dash.id}`, { method: 'DELETE' }), 'Dashboard deleted.').then(async (ok) => { if (ok) { const { l } = await loadList(); open(l.defaultId); } });
          }}>Delete this dashboard</button>
        </div>
      )}

      {dialog && draft && (
        <WidgetDialog widget={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)}
          onSave={(w) => { setDraft({ ...draft, widgets: dialog === 'new' ? [...draft.widgets, w] : draft.widgets.map((x) => (x.id === w.id ? w : x)) }); setDialog(null); }} />
      )}
      {sharing && dash?.sharing && (
        <ShareDialog name={dash.name} value={dash.sharing} orgWide={me.permissions['dashboard.manage'] === 'ORGANIZATION'} workspaces={me.workspaces} onClose={() => setSharing(false)}
          onSave={(s) => run(() => api(`/api/v1/dashboards/${dash.id}/sharing`, { method: 'PUT', body: s }), 'Sharing saved.').then((ok) => { if (ok) { setSharing(false); setDash({ ...dash, sharing: s, isLocked: s.isLocked }); loadList(); } })} />
      )}
    </>
  );
}

/** "Email me this dashboard" — daily or weekly, with the person's own numbers. */
function EmailMe({ dashboardId }: { dashboardId: string }) {
  const [sub, setSub] = useState<{ frequency: string; hour: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ frequency: 'daily', hour: 9 });
  useEffect(() => {
    api<{ frequency: string; hour: number } | null>(`/api/v1/dashboards/${encodeURIComponent(dashboardId)}/subscription`)
      .then((r) => { setSub(r); if (r) setF({ frequency: r.frequency, hour: r.hour }); }).catch(() => setSub(null));
  }, [dashboardId]);
  return (
    <span style={{ position: 'relative' }}>
      <button className={`btn ${sub ? '' : 'outline'}`} onClick={() => setOpen(!open)} title="Get this dashboard by email"><Icon name="mail" className="ic" /> {sub ? (sub.frequency === 'weekly' ? 'Weekly email' : 'Daily email') : 'Email me'}</button>
      {open && (
        <div className="card fbar-more" style={{ width: 280 }}>
          <div className="field"><label>Send</label>
            <select className="input" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="daily">Every day (yesterday’s numbers)</option><option value="weekly">Every Monday (last 7 days)</option></select>
          </div>
          <div className="field"><label>At</label>
            <select className="input" value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${((h + 11) % 12) + 1}:00 ${h < 12 ? 'am' : 'pm'}`}</option>)}</select>
          </div>
          <div className="row end">
            {sub && <button className="btn sm ghost" onClick={() => api(`/api/v1/dashboards/${encodeURIComponent(dashboardId)}/subscription`, { method: 'DELETE' }).then(() => { setSub(null); setOpen(false); })}>Stop emails</button>}
            <button className="btn sm" onClick={() => api<{ frequency: string; hour: number }>(`/api/v1/dashboards/${encodeURIComponent(dashboardId)}/subscription`, { method: 'PUT', body: f }).then((r) => { setSub(r); setOpen(false); })}>Save</button>
          </div>
        </div>
      )}
    </span>
  );
}
