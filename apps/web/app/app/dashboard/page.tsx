'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { METRICS, RANGE_LABELS, RangePreset, WidgetConfig } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { WidgetBody, MetricData } from '@/components/dashboard/Widget';
import { ShareDialog, SharingState, WidgetDialog } from '@/components/dashboard/Dialogs';
import { fmt } from '@/components/dashboard/charts';

interface ListItem { id: string; name: string; description: string | null; isMine?: boolean; isShared?: boolean; isLocked?: boolean; widgetCount?: number }
interface DashList { templates: { key: string; name: string; description: string }[]; mine: ListItem[]; shared: ListItem[]; defaultId: string; canShare: boolean }
interface Dash {
  id: string; name: string; description: string | null; widgets: WidgetConfig[]; range: RangePreset; isTemplate: boolean;
  canEdit: boolean; canShare: boolean; isMine?: boolean; isLocked?: boolean; sharing?: SharingState;
}
type Msg = { type: 'error' | 'notice'; text: string } | null;
const LAST = 'ubos.dashboard.last';
const remember = (id: string) => { try { localStorage.setItem(LAST, id); } catch { /* storage unavailable */ } };
const periodOf = (d: unknown) => (d && typeof d === 'object' && 'label' in d ? String((d as { label: unknown }).label ?? '') : '');
const recall = () => { try { return localStorage.getItem(LAST); } catch { return null; } };

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
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<{ name: string; widgets: WidgetConfig[] } | null>(null);
  const [dialog, setDialog] = useState<WidgetConfig | 'new' | null>(null);
  const [sharing, setSharing] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
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
    setOwner('');
    const ws = me.currentWorkspaceId;
    if (scope && scope !== 'OWN') {
      (ws ? api<{ id: string; name: string }[]>(`/api/v1/workspaces/${ws}/assignees`) : can('org.user.view') ? api<{ id: string; name: string; isActive: boolean }[]>('/api/v1/users').then((u) => u.filter((x) => x.isActive)) : Promise.resolve([]))
        .then((p) => setPeople(p.map((x) => ({ id: x.id, name: x.name })))).catch(() => setPeople([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const widgetKey = JSON.stringify(widgets.map(({ id, type, metric, groupBy, range: r, target }) => ({ id, type, metric, groupBy, r, target })));
  useEffect(() => {
    if (!widgets.length || (range === 'custom' && (!from || !to))) { setData({}); return; }
    setLoading(true);
    const body = { range, from: from || undefined, to: to || undefined, compare, filters: owner ? { ownerIds: [owner] } : {}, widgets };
    api<Record<string, unknown>>('/api/v1/analytics/batch', { method: 'POST', body })
      .then(setData).catch((e) => setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Could not load the numbers' })).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetKey, range, from, to, compare, owner, version]);

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

  const move = (fromIdx: number, toIdx: number) => {
    if (!draft || fromIdx === toIdx) return;
    const next = [...draft.widgets];
    const [m] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, m);
    setDraft({ ...draft, widgets: next });
  };
  const options = useMemo(() => list ? [
    { label: 'Ready-made', items: list.templates.map((t) => ({ id: `tpl:${t.key}`, name: t.name })) },
    { label: 'My dashboards', items: list.mine.map((d) => ({ id: d.id, name: d.name })) },
    { label: 'Shared with me', items: list.shared.map((d) => ({ id: d.id, name: `${d.name}${d.isLocked ? ' 🔒' : ''}` })) },
  ].filter((g) => g.items.length) : [], [list]);

  if (!scope) return <div className="notice">Your role has no dashboard access. Ask your administrator for “View dashboards”.</div>;
  const scopeText = scope === 'OWN' ? 'your own leads and calls' : scope === 'TEAM' ? 'your team' : scope === 'WORKSPACE' ? 'your business lines' : me.currentWorkspaceId ? 'this business line' : 'the whole organization';

  return (
    <>
      <div className="page-head" style={{ alignItems: 'flex-end' }}>
        <div style={{ minWidth: 0 }}>
          {editing ? (
            <input className="input" style={{ fontSize: 20, fontWeight: 700, height: 40, maxWidth: 380 }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Dashboard name" />
          ) : (
            <select className="dash-picker" value={dash?.id ?? ''} onChange={(e) => open(e.target.value)} aria-label="Choose dashboard">
              {options.map((g) => <optgroup key={g.label} label={g.label}>{g.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>)}
            </select>
          )}
          <div className="small muted">{dash?.description ? `${dash.description} · ` : ''}Showing {scopeText}.</div>
        </div>
        <div className="row">
          {!editing && (
            <>
              {dash && (dash.canEdit && !dash.isTemplate
                ? <button className="btn outline" onClick={() => setDraft({ name: dash.name, widgets: dash.widgets })}>Edit</button>
                : <button className="btn outline" onClick={() => setDraft({ name: `${dash.name} (my copy)`, widgets: dash.widgets })} title="Change widgets and save it as your own dashboard">Customise</button>)}
              {dash?.canShare && !dash.isTemplate && list?.canShare && <button className="btn outline" onClick={() => setSharing(true)}>Share</button>}
              {can('crm.lead.export') && <button className="btn ghost" onClick={exportCsv}>Export</button>}
              <button className="btn" onClick={() => saveCopy('My dashboard', [{ id: 'k1', type: 'kpi', title: 'New leads', metric: 'leads', groupBy: 'none', w: 3, h: 1 }]).then((id) => { if (id) setDraft({ name: 'My dashboard', widgets: [{ id: 'k1', type: 'kpi', title: 'New leads', metric: 'leads', groupBy: 'none', w: 3, h: 1 }] }); })}>+ New dashboard</button>
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

      <div className="card dash-controls">
        <select className="input" style={{ width: 'auto' }} value={range} onChange={(e) => setRange(e.target.value as RangePreset)} aria-label="Period">
          {(Object.keys(RANGE_LABELS) as RangePreset[]).map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
        </select>
        {range === 'custom' && (
          <>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" style={{ width: 'auto' }} />
            <span className="muted">to</span>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" style={{ width: 'auto' }} />
          </>
        )}
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare with previous period</label>
        {people.length > 0 && (
          <select className="input" style={{ width: 'auto' }} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Person">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <span style={{ flex: 1 }} />
        {loading && <span className="small muted">Updating…</span>}
        {dash?.isLocked && !editing && <span className="badge grey">🔒 Locked</span>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {editing && <div className="notice small">Drag widgets to reorder. Use ✎ to change a widget, or the size buttons to resize it.</div>}

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
                  <button className="btn sm ghost" title="Edit" aria-label="Edit widget" onClick={() => setDialog(w)}>✎</button>
                  <button className="btn sm ghost" title="Remove" aria-label="Remove widget" style={{ color: 'var(--bad)' }} onClick={() => setDraft({ ...draft, widgets: draft.widgets.filter((_, j) => j !== i) })}>✕</button>
                </span>
              )}
            </header>
            <div className="dash-widget-body"><WidgetBody w={w} data={data[w.id]} onDrill={(href) => router.push(href)} /></div>
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
