'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { BroadcastDialog } from '@/components/whatsapp/BroadcastDialog';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { fromIstInput } from '@/lib/ist';
import { useShell } from '@/components/AppShell';
import { FieldInput } from '@/components/FieldInput';
import { LostDialog } from '@/components/LostDialog';
import { Adv, advCount, advFromQuery, advParams, EMPTY_ADV, LeadFilters } from '@/components/LeadFilters';
import { displayValue, relTime, showValue, STATUS_TONE, WorkspaceSettings } from '@/lib/workspace';

interface Lead {
  id: string; name: string; mobile: string | null; email: string | null; city: string | null; customerId: string; customerCode: string; source: string;
  workspaceId: string; workspace: string; pipelineId: string; pipeline: string; stageId: string; stage: string; stageColor: string | null;
  lostReason: string | null; status: string | null; inStageDays: number; slaBreached: boolean; score: number;
  customFields: Record<string, unknown>; ownerId: string | null; owner: string | null;
  nextFollowUpAt: string | null; lastActivityAt: string | null; lastDisposition: string | null; createdAt: string; labelIds: string[];
}
interface Person { id: string; name: string }
export interface LabelRow { id: string; name: string; color: string; workspaceId: string | null }
interface SavedView { id: string; name: string; isMine: boolean; owner: string | null; workspaceId: string | null; layout: 'list' | 'board'; sharedRoleIds: string[]; query: { quick?: Quick; adv?: Partial<Adv>; sort?: string } }
type Quick = { followUp: string; owner: string; q: string };
type BulkAction = 'assign' | 'stage' | 'status' | 'remark' | 'follow_up' | 'labels';
const SORTS: [string, string][] = [
  ['created_desc', 'Newest first'], ['created_asc', 'Oldest first'], ['activity_desc', 'Recently worked'],
  ['followup_asc', 'Next follow-up'], ['score_desc', 'Highest score'], ['stage_age_desc', 'Longest in stage'],
];
const EMPTY_Q: Quick = { followUp: '', owner: '', q: '' };
const readable = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');

export default function LeadsPageRoute() {
  return <Suspense fallback={null}><LeadsPage /></Suspense>;
}

function LeadsPage() {
  const params = useSearchParams();
  const { me, can, version } = useShell();
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [ws, setWs] = useState<WorkspaceSettings | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [counts, setCounts] = useState<{ today: number; overdue: number; stuck: number }>({ today: 0, overdue: 0, stuck: 0 });
  const [quick, setQuick] = useState<Quick>(EMPTY_Q);
  const [adv, setAdv] = useState<Adv>(EMPTY_ADV);
  const seenVersion = useRef<number | null>(null);
  const lastReq = useRef(0);
  const [sort, setSort] = useState('created_desc');
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [broadcast, setBroadcast] = useState<'whatsapp' | 'outreach' | null>(null);
  const [adding, setAdding] = useState(false);
  const [losing, setLosing] = useState<{ lead: Lead; stageId: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [labels, setLabels] = useState<LabelRow[]>([]);
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeView, setActiveView] = useState<string>('');
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [boardPipe, setBoardPipe] = useState('');
  const [dragLead, setDragLead] = useState<Lead | null>(null);
  const [shareView, setShareView] = useState<SavedView | null>(null);

  /** One query string for the list and the export, so an export is exactly what is on screen. */
  const query = useCallback(() => {
    const p: [string, string][] = [...(Object.entries(quick).filter(([, v]) => v) as [string, string][]), ...advParams(adv), ['sort', sort]];
    // The quick "My leads / Unassigned" chip and the owners filter are combined into one list.
    const owners = new Set([...(quick.owner ? [quick.owner] : []), ...adv.owners]);
    const out = p.filter(([k]) => k !== 'owner' && k !== 'owners');
    if (owners.size) out.push(['owners', [...owners].join(',')]);
    return new URLSearchParams(out).toString();
  }, [quick, adv, sort]);

  const load = useCallback(() => {
    // Only the latest request may update the list (an older, slower one must not overwrite newer filters).
    const req = ++lastReq.current;
    let count = 0;
    api<Lead[]>(`/api/v1/leads?${query()}`, { onHeaders: (h) => { count = Number(h.get('X-Total-Count') ?? 0); } })
      .then((l) => { if (req !== lastReq.current) return; setTotal(count); setLeads(l); setSelected(new Set()); })
      .catch((e) => { if (req === lastReq.current) setMsg({ type: 'error', text: e.message }); });
    const head = (qs: string) => new Promise<number>((resolve) => {
      api<unknown[]>(`/api/v1/leads?${qs}`, { onHeaders: (h) => resolve(Number(h.get('X-Total-Count') ?? 0)) }).catch(() => resolve(0));
    });
    Promise.all([head('followUp=today'), head('followUp=overdue'), head('stuck=yes')])
      .then(([today, overdue, stuck]) => setCounts({ today, overdue, stuck }));
  }, [query]);

  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    setQuick(EMPTY_Q);
    // First visit may carry filters in the address (drill-down from a dashboard); later workspace switches reset them.
    if (seenVersion.current === null) setAdv(advFromQuery(new URLSearchParams(params.toString())));
    else if (seenVersion.current !== version) setAdv(EMPTY_ADV);
    seenVersion.current = version;
    setActiveView('');
    loadViews();
    api<LabelRow[]>('/api/v1/labels').then(setLabels).catch(() => setLabels([]));
    if (me.currentWorkspaceId && can('org.workspace.view')) {
      api<WorkspaceSettings>(`/api/v1/workspaces/${me.currentWorkspaceId}/settings`).then(setWs).catch(() => setWs(null));
      api<Person[]>(`/api/v1/workspaces/${me.currentWorkspaceId}/assignees`).then(setPeople).catch(() => setPeople([]));
    } else { setWs(null); setPeople([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  function loadViews() { api<SavedView[]>('/api/v1/views').then(setViews).catch(() => setViews([])); }
  function applyView(v: SavedView | null) {
    setActiveView(v?.id ?? '');
    setQuick({ ...EMPTY_Q, ...(v?.query.quick ?? {}) });
    setAdv({ ...EMPTY_ADV, ...(v?.query.adv ?? {}), cf: { ...(v?.query.adv?.cf ?? {}) } });
    setSort(v?.query.sort ?? 'created_desc');
    setLayout(v?.layout ?? 'list');
  }
  async function saveView(existing?: SavedView) {
    const name = existing ? existing.name : prompt('Name this view, e.g. "Hot leads this week"');
    if (!name) return;
    const body = { name, workspaceId: me.currentWorkspaceId, query: { quick, adv, sort }, layout };
    try {
      const v = await api<SavedView>(existing ? `/api/v1/views/${existing.id}` : '/api/v1/views', { method: existing ? 'PATCH' : 'POST', body });
      loadViews();
      setActiveView(v.id);
      setMsg({ type: 'notice', text: existing ? 'View updated.' : `Saved “${name}”.` });
    } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  }
  const labelOf = (id: string) => labels.find((x) => x.id === id);
  const view = views.find((v) => v.id === activeView);

  const stagesFor = (l: Lead) => ws?.pipelines.find((p) => p.id === l.pipelineId)?.stages ?? [];
  // Without a selected business line there are no option labels: show the stored value readably.
  const label = (kind: 'sources' | 'statuses' | 'dispositions', v: string | null) => (v ? ws?.[kind].find((o) => o.value === v)?.label ?? readable(v) : '');
  const h1 = (l: Lead) => (ws ? displayValue(ws.display.h1, l, ws.fields) : '') || l.name;
  const h2 = (l: Lead) => (ws ? displayValue(ws.display.h2, l, ws.fields) : l.mobile ?? l.email ?? '');
  const firstField = ws?.fields.find((x) => !x.isArchived && `cf:${x.key}` !== ws.display.h1 && `cf:${x.key}` !== ws.display.h2);
  const setQ = (k: keyof Quick, v: string) => setQuick({ ...quick, [k]: quick[k] === v ? '' : v });
  const toggle = (id: string) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); };
  const allChecked = !!leads?.length && leads.every((l) => selected.has(l.id));
  const nAdv = advCount(adv);
  const filtered = nAdv > 0 || !!quick.followUp || !!quick.owner || !!quick.q;

  async function moveStage(l: Lead, stageId: string, lostReason?: string) {
    const target = stagesFor(l).find((s) => s.id === stageId);
    if (target?.isLost && !lostReason && ws?.lostReasons.length) return setLosing({ lead: l, stageId });
    try {
      await api(`/api/v1/leads/${l.id}/stage`, { method: 'PATCH', body: { stageId, lostReason } });
      setLosing(null);
      load();
    } catch (e) { setLosing(null); setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed' }); }
  }

  async function exportCsv() {
    try {
      const blob = await api<Blob>(`/api/v1/leads/export?${query()}`);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: 'leads.csv' }).click();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Export failed' }); }
  }

  /** Readable chips for every active advanced filter, each removable on its own. */
  const activeChips: { label: string; clear: () => void }[] = [];
  if (ws) {
    const stageName = new Map(ws.pipelines.flatMap((p) => p.stages.map((s) => [s.id!, s.name] as [string, string])));
    const multi: [keyof Adv, string, (v: string) => string][] = [
      ['stageIds', 'Stage', (v) => stageName.get(v) ?? v],
      ['statuses', 'Status', (v) => (v === '__none__' ? 'No status' : label('statuses', v))],
      ['sources', 'Source', (v) => label('sources', v)],
      ['owners', 'Owner', (v) => (v === 'me' ? 'Me' : v === 'unassigned' ? 'Unassigned' : people.find((p) => p.id === v)?.name ?? 'Someone')],
      ['dispositions', 'Last call', (v) => label('dispositions', v)],
      ['lostReasons', 'Lost reason', (v) => ws.lostReasons.find((r) => r.value === v)?.label ?? v],
      ['labelIds', 'Label', (v) => labelOf(v)?.name ?? 'Label'],
    ];
    for (const [k, title, name] of multi) {
      const vals = adv[k] as string[];
      if (vals.length) activeChips.push({ label: `${title}: ${vals.map(name).join(', ')}`, clear: () => setAdv({ ...adv, [k]: [] }) });
    }
    const ranges: [keyof Adv, keyof Adv, string][] = [['createdFrom', 'createdTo', 'Created'], ['assignedFrom', 'assignedTo', 'Assigned'], ['activityFrom', 'activityTo', 'Last activity'], ['followUpFrom', 'followUpTo', 'Follow-up']];
    for (const [a, b, title] of ranges) {
      if (adv[a] || adv[b]) activeChips.push({ label: `${title}: ${adv[a] || '…'} → ${adv[b] || '…'}`, clear: () => setAdv({ ...adv, [a]: '', [b]: '' }) });
    }
    if (adv.contacted) activeChips.push({ label: adv.contacted === 'yes' ? 'Worked' : 'Not worked yet', clear: () => setAdv({ ...adv, contacted: '' }) });
    if (adv.stuck) activeChips.push({ label: 'Stuck beyond SLA', clear: () => setAdv({ ...adv, stuck: '' }) });
    if (adv.scoreMin || adv.scoreMax) activeChips.push({ label: `Score ${adv.scoreMin || '…'}–${adv.scoreMax || '…'}`, clear: () => setAdv({ ...adv, scoreMin: '', scoreMax: '' }) });
    for (const [k, v] of Object.entries(adv.cf)) {
      if (v) activeChips.push({ label: `${ws.fields.find((x) => x.key === k)?.label ?? k}: ${v}`, clear: () => setAdv({ ...adv, cf: { ...adv.cf, [k]: '' } }) });
    }
  }

  const canBulk = can('crm.lead.update') || can('crm.lead.assign');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="muted small">
            {ws?.name ?? 'All business lines'} · <b>{total}</b> {filtered ? 'match' : 'total'}{leads && total > leads.length ? ` (showing first ${leads.length})` : ''} · your access: {me.permissions['crm.lead.view']?.toLowerCase()}
          </div>
        </div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); load(); }}>
            <input className="input" style={{ width: 210 }} placeholder="Search name, mobile, email" value={quick.q} onChange={(e) => setQuick({ ...quick, q: e.target.value })} />
          </form>
          {can('crm.lead.export') && <button className="btn outline" onClick={exportCsv} title="Exports the leads matching the current filters">Export</button>}
          {can('crm.lead.import') && me.currentWorkspaceId && <Link className="btn outline" href="/app/leads/import">Bulk upload</Link>}
          {can('crm.lead.import') && me.currentWorkspaceId && <Link className="btn outline" href="/app/leads/update">Bulk update</Link>}
          {can('crm.lead.create') && ws && <button className="btn" onClick={() => setAdding(true)}>+ Add lead</button>}
        </div>
      </div>

      <div className="view-bar">
        <button className={`view-tab ${!activeView ? 'on' : ''}`} onClick={() => applyView(null)}>All leads</button>
        {views.map((v) => (
          <button key={v.id} className={`view-tab ${activeView === v.id ? 'on' : ''}`} onClick={() => applyView(v)} title={v.isMine ? 'My view' : `Shared by ${v.owner}`}>
            {v.isMine ? '' : '↗ '}{v.name}{v.layout === 'board' ? ' ▦' : ''}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {view?.isMine && <button className="btn sm ghost" onClick={() => saveView(view)}>Update view</button>}
        {view?.isMine && can('crm.view.share') && <button className="btn sm ghost" onClick={() => setShareView(view)}>Share</button>}
        {view?.isMine && <button className="btn sm ghost" style={{ color: 'var(--bad)' }} onClick={() => { if (confirm(`Remove the view “${view.name}”?`)) api(`/api/v1/views/${view.id}`, { method: 'DELETE' }).then(() => { applyView(null); loadViews(); }); }}>Remove</button>}
        <button className="btn sm outline" onClick={() => saveView()}>☆ Save as view</button>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="chips">
          <button className={`chip ${quick.followUp === 'today' ? 'on' : ''}`} onClick={() => setQ('followUp', 'today')}>Follow-ups today <span className="count">{counts.today}</span></button>
          <button className={`chip ${quick.followUp === 'overdue' ? 'on' : counts.overdue ? 'alert' : ''}`} onClick={() => setQ('followUp', 'overdue')}>Overdue <span className="count">{counts.overdue}</span></button>
          <button className={`chip ${quick.followUp === 'none' ? 'on' : ''}`} onClick={() => setQ('followUp', 'none')}>No follow-up planned</button>
          {ws && <button className={`chip ${adv.stuck ? 'on' : counts.stuck ? 'alert' : ''}`} onClick={() => setAdv({ ...adv, stuck: adv.stuck ? '' : 'yes' })} title="Longer in their stage than the stage SLA">Stuck <span className="count">{counts.stuck}</span></button>}
          <span style={{ width: 1, background: 'var(--line)', margin: '0 4px' }} />
          <button className={`chip ${quick.owner === 'me' ? 'on' : ''}`} onClick={() => setQ('owner', 'me')}>My leads</button>
          {can('crm.lead.assign') && <button className={`chip ${quick.owner === 'unassigned' ? 'on' : ''}`} onClick={() => setQ('owner', 'unassigned')}>Unassigned</button>}
          <span style={{ flex: 1 }} />
          <select className="input" style={{ width: 'auto', height: 32 }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {ws && (
            <span className="row" style={{ gap: 0, border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
              <button className={`btn sm ${layout === 'list' ? '' : 'ghost'}`} style={{ borderRadius: 0 }} onClick={() => setLayout('list')} title="List">☰ List</button>
              <button className={`btn sm ${layout === 'board' ? '' : 'ghost'}`} style={{ borderRadius: 0 }} onClick={() => setLayout('board')} title="Board by stage">▦ Board</button>
            </span>
          )}
          {ws && <button className={`btn sm ${nAdv ? '' : 'outline'}`} onClick={() => setShowFilters(true)}>⚲ Filters{nAdv ? ` (${nAdv})` : ''}</button>}
        </div>
        {ws && ws.pipelines.length > 0 && (
          <div className="chips" style={{ marginTop: 10 }}>
            {ws.pipelines.flatMap((p) => p.stages.map((s) => (
              <button key={s.id} className={`chip ${adv.stageIds.includes(s.id!) ? 'on' : ''}`}
                onClick={() => setAdv({ ...adv, stageIds: adv.stageIds.includes(s.id!) ? adv.stageIds.filter((x) => x !== s.id) : [...adv.stageIds, s.id!] })}>
                <span className="dot" style={{ background: s.color ?? '#e4e2ec', width: 9, height: 9, borderRadius: 9, display: 'inline-block', marginRight: 5, border: '1px solid rgba(0,0,0,.12)' }} />
                {ws.pipelines.length > 1 ? `${p.name} · ` : ''}{s.name}
              </button>
            )))}
          </div>
        )}
        {(activeChips.length > 0 || filtered) && (
          <div className="chips" style={{ marginTop: 10 }}>
            {activeChips.map((c) => <button key={c.label} className="chip on" onClick={c.clear} title="Remove this filter">{c.label} ✕</button>)}
            {filtered && <button className="chip" onClick={() => { setQuick(EMPTY_Q); setAdv(EMPTY_ADV); }}>Clear all filters</button>}
          </div>
        )}
      </div>
      {!me.currentWorkspaceId && can('crm.lead.create') && <div className="notice">Select a workspace (business line) at the top to add, upload, filter in detail or bulk-edit leads.</div>}
      {msg && <div className={msg.type}>{msg.text}</div>}

      {layout === 'board' && ws && (() => {
        const pipe = ws.pipelines.find((p) => p.id === boardPipe) ?? ws.pipelines[0];
        const inPipe = (leads ?? []).filter((l) => l.pipelineId === pipe?.id);
        return (
          <>
            {ws.pipelines.length > 1 && (
              <div className="chips" style={{ marginBottom: 8 }}>
                {ws.pipelines.map((p) => <button key={p.id} className={`chip ${pipe?.id === p.id ? 'on' : ''}`} onClick={() => setBoardPipe(p.id)}>{p.name}</button>)}
              </div>
            )}
            <div className="board">
              {pipe?.stages.map((s) => {
                const cards = inPipe.filter((l) => l.stageId === s.id);
                return (
                  <div key={s.id} className={`board-col ${dragLead && dragLead.stageId !== s.id ? 'droppable' : ''}`}
                    onDragOver={(e) => { if (dragLead && can('crm.lead.update')) e.preventDefault(); }}
                    onDrop={() => { if (dragLead && dragLead.stageId !== s.id) moveStage(dragLead, s.id!); setDragLead(null); }}>
                    <div className="board-head" style={{ borderTopColor: s.color ?? '#e4e2ec' }}>
                      <b>{s.name}</b><span className="count">{cards.length}</span>
                    </div>
                    <div className="board-cards">
                      {cards.map((l) => (
                        <div key={l.id} className={`board-card ${l.slaBreached ? 'stuck' : ''}`} draggable={can('crm.lead.update')}
                          onDragStart={() => setDragLead(l)} onDragEnd={() => setDragLead(null)} onClick={() => router.push(`/app/leads/${l.id}`)}>
                          <b>{h1(l)}</b>
                          <div className="small muted">{h2(l)}</div>
                          {l.labelIds.length > 0 && <div className="lbls">{l.labelIds.map((id) => labelOf(id)).filter(Boolean).map((x) => <span key={x!.id} className="lbl" style={{ background: x!.color }}>{x!.name}</span>)}</div>}
                          <div className="row small" style={{ justifyContent: 'space-between', marginTop: 4 }}>
                            <span>{l.status ? <span className={`badge ${STATUS_TONE[l.status] ?? ''}`}>{label('statuses', l.status)}</span> : null}</span>
                            <span className="muted">{l.slaBreached ? <span className="badge bad">Stuck {l.inStageDays}d</span> : l.owner ?? 'Unassigned'}</span>
                          </div>
                          {l.nextFollowUpAt && <div className="small" style={{ color: new Date(l.nextFollowUpAt) < new Date() ? 'var(--bad)' : 'var(--muted)' }}>⏰ {relTime(l.nextFollowUpAt)}</div>}
                        </div>
                      ))}
                      {!cards.length && <div className="small muted" style={{ padding: 8, textAlign: 'center' }}>{dragLead ? 'Drop here' : 'No leads'}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>Drag a card to another stage — stage rules (required fields, lost reason) still apply. The board shows up to 500 leads; filter to narrow it.</div>
          </>
        );
      })()}

      {(layout === 'list' || !ws) && <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 960 }}>
            <thead>
              <tr>
                {canBulk && <th style={{ width: 34 }}><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(leads?.map((l) => l.id)))} /></th>}
                <th>Lead</th>{!me.currentWorkspaceId && <th>Business line</th>}
                {firstField && <th>{firstField.label}</th>}
                <th>Status</th><th>Stage</th><th>Owner</th><th>Next follow-up</th><th>Last call</th><th title="Lead score from custom actions">Score</th>
              </tr>
            </thead>
            <tbody>
              {leads?.map((l) => {
                const overdue = l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date();
                return (
                  <tr key={l.id} className={`clickable ${selected.has(l.id) ? 'selected' : ''}`} onClick={() => router.push(`/app/leads/${l.id}`)}>
                    {canBulk && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} /></td>}
                    <td>
                      <b>{h1(l)}</b>
                      <div className="small muted">{[h2(l), label('sources', l.source)].filter(Boolean).join(' · ')}</div>
                      {l.labelIds.length > 0 && <div className="lbls">{l.labelIds.map((id) => labelOf(id)).filter(Boolean).map((x) => <span key={x!.id} className="lbl" style={{ background: x!.color }}>{x!.name}</span>)}</div>}
                    </td>
                    {!me.currentWorkspaceId && <td><span className="badge">{l.workspace}</span></td>}
                    {firstField && <td className="small">{showValue(firstField, l.customFields?.[firstField.key]) || <span className="muted">—</span>}</td>}
                    <td>{l.status ? <span className={`badge ${STATUS_TONE[l.status] ?? ''}`}>{label('statuses', l.status)}</span> : <span className="muted small">—</span>}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 10, background: l.stageColor ?? '#e4e2ec', border: '1px solid rgba(0,0,0,.12)', flex: 'none' }} />
                        {can('crm.lead.update') && stagesFor(l).length ? (
                          <select className="input" style={{ height: 30, width: 150 }} value={l.stageId} onChange={(e) => moveStage(l, e.target.value)} aria-label="Stage">
                            {stagesFor(l).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        ) : <span className="badge grey">{l.stage}</span>}
                      </div>
                      <div className="small muted">
                        {l.slaBreached ? <span className="badge bad" title="Longer than the stage SLA">Stuck {l.inStageDays}d</span> : `${l.inStageDays}d in stage`}
                        {l.lostReason && ` · ${ws?.lostReasons.find((r) => r.value === l.lostReason)?.label ?? l.lostReason}`}
                      </div>
                    </td>
                    <td className="small">{l.owner ?? <span className="badge warn">Unassigned</span>}</td>
                    <td className="small">
                      {l.nextFollowUpAt ? <span style={{ color: overdue ? 'var(--bad)' : undefined, fontWeight: overdue ? 600 : undefined }}>{relTime(l.nextFollowUpAt)}</span> : <span className="muted">—</span>}
                    </td>
                    <td className="small muted">{l.lastDisposition ? `${label('dispositions', l.lastDisposition)} · ${relTime(l.lastActivityAt)}` : 'Not called yet'}</td>
                    <td>{l.score ? <span className={`badge ${l.score >= 30 ? 'ok' : ''}`}>{l.score}</span> : <span className="muted small">0</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {leads && !leads.length && <div className="empty">No leads match these filters.</div>}
          {!leads && <div className="empty">Loading…</div>}
        </div>
      </div>}

      {selected.size > 0 && (
        <div className="bulkbar">
          <b>{selected.size} selected</b>
          <span style={{ flex: 1 }} />
          {can('crm.lead.assign') && <button className="btn sm" onClick={() => setBulk('assign')}>Assign</button>}
          {can('crm.lead.update') && ws && <button className="btn sm" onClick={() => setBulk('stage')}>Change stage</button>}
          {can('crm.lead.update') && ws && <button className="btn sm" onClick={() => setBulk('status')}>Change status</button>}
          {can('crm.lead.update') && <button className="btn sm" onClick={() => setBulk('remark')}>Add remark</button>}
          {can('crm.lead.update') && <button className="btn sm" onClick={() => setBulk('follow_up')}>Schedule follow-up</button>}
          {can('crm.lead.update') && labels.length > 0 && <button className="btn sm" onClick={() => setBulk('labels')}>Labels</button>}
          {can('crm.whatsapp.broadcast') && <button className="btn sm" onClick={() => setBroadcast('whatsapp')}>WhatsApp</button>}
          {can('crm.message.manage') && <button className="btn sm" onClick={() => setBroadcast('outreach')}>SMS / Email</button>}
          <button className="btn sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {showFilters && ws && <LeadFilters ws={ws} people={people} labels={labels} value={adv} onClose={() => setShowFilters(false)} onApply={(a) => { setAdv(a); setShowFilters(false); }} />}
      {broadcast && <BroadcastDialog ids={[...selected]} kind={broadcast} onClose={() => setBroadcast(null)} onDone={(text) => { setBroadcast(null); setMsg({ type: 'notice', text }); }} />}
      {bulk && (
        <BulkDialog
          action={bulk} ids={[...selected]} ws={ws} people={people} labels={labels}
          onClose={() => setBulk(null)}
          onDone={(text) => { setBulk(null); setMsg({ type: 'notice', text }); load(); }}
        />
      )}
      {adding && ws && (
        <AddLead ws={ws} people={people} canAssign={can('crm.lead.assign')} meId={me.user.id} onClose={() => setAdding(false)}
          onSaved={(id) => { setAdding(false); router.push(`/app/leads/${id}`); }} />
      )}
      {shareView && <ShareViewDialog view={shareView} onClose={() => setShareView(null)} onDone={() => { setShareView(null); loadViews(); setMsg({ type: 'notice', text: 'Sharing saved.' }); }} />}
      {losing && ws && (
        <LostDialog ws={ws} name={losing.lead.name} onClose={() => setLosing(null)} onPick={(r) => moveStage(losing.lead, losing.stageId, r)} />
      )}
    </>
  );
}

function BulkDialog({ action, ids, ws, people, labels = [], onClose, onDone }: {
  action: BulkAction; ids: string[]; ws: WorkspaceSettings | null; people: Person[]; labels?: LabelRow[]; onClose: () => void; onDone: (text: string) => void;
}) {
  const [addL, setAddL] = useState<string[]>([]);
  const [removeL, setRemoveL] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [stageId, setStageId] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [status, setStatus] = useState('');
  const [remark, setRemark] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stage = ws?.pipelines.flatMap((p) => p.stages).find((s) => s.id === stageId);
  const titles: Record<BulkAction, string> = {
    assign: 'Assign leads', stage: 'Change stage', status: 'Change status', remark: 'Add remark', follow_up: 'Schedule follow-up', labels: 'Add or remove labels',
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ updated: number; skipped: { reason: string }[] }>('/api/v1/leads/bulk', {
        method: 'POST',
        body: {
          leadIds: ids, action,
          ...(action === 'assign' ? { ownerIds: owners } : {}),
          ...(action === 'stage' ? { stageId, lostReason: lostReason || undefined } : {}),
          ...(action === 'status' ? { status: status || undefined } : {}),
          ...(action === 'remark' || action === 'follow_up' ? { remark: remark || undefined } : {}),
          ...(action === 'follow_up' ? { followUpAt: fromIstInput(date).toISOString() } : {}),
          ...(action === 'labels' ? { addLabelIds: addL, removeLabelIds: removeL } : {}),
        },
      });
      const reasons = [...new Set(r.skipped.map((s) => s.reason))];
      onDone(`${r.updated} lead(s) updated${r.skipped.length ? ` · ${r.skipped.length} skipped (${reasons.join('; ')})` : ''}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{titles[action]} · {ids.length} lead(s)</h2>
        {error && <div className="error">{error}</div>}
        {action === 'assign' && (
          <>
            <p className="small muted" style={{ marginTop: -4 }}>Pick one person, or several to share the leads equally (round-robin).</p>
            <div className="chips" style={{ marginBottom: 12 }}>
              {people.map((p) => (
                <button type="button" key={p.id} className={`chip ${owners.includes(p.id) ? 'on' : ''}`} onClick={() => setOwners(owners.includes(p.id) ? owners.filter((x) => x !== p.id) : [...owners, p.id])}>{p.name}</button>
              ))}
            </div>
            {!people.length && <div className="notice">Select a workspace to see who can receive these leads.</div>}
          </>
        )}
        {action === 'stage' && ws && (
          <>
            <div className="field">
              <label>New stage</label>
              <select className="input" value={stageId} onChange={(e) => setStageId(e.target.value)} required>
                <option value="">Choose…</option>
                {ws.pipelines.map((p) => <optgroup key={p.id} label={p.name}>{p.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
              </select>
              <span className="small muted">Leads in a different pipeline are skipped.</span>
            </div>
            {stage?.isLost && ws.lostReasons.length > 0 && (
              <div className="field">
                <label>Lost reason</label>
                <select className="input" value={lostReason} onChange={(e) => setLostReason(e.target.value)} required>
                  <option value="">Choose…</option>
                  {ws.lostReasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            )}
          </>
        )}
        {action === 'status' && ws && (
          <div className="chips" style={{ marginBottom: 12 }}>
            {ws.statuses.map((s) => <button type="button" key={s.value} className={`chip ${status === s.value ? 'on' : ''}`} onClick={() => setStatus(s.value ?? '')}>{s.label}</button>)}
          </div>
        )}
        {action === 'labels' && (
          <>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Add</div>
            <div className="chips" style={{ marginBottom: 10 }}>
              {labels.map((l) => <button type="button" key={l.id} className={`chip ${addL.includes(l.id) ? 'on' : ''}`} onClick={() => { setAddL(addL.includes(l.id) ? addL.filter((x) => x !== l.id) : [...addL, l.id]); setRemoveL(removeL.filter((x) => x !== l.id)); }}><span className="lbl-dot" style={{ background: l.color }} />{l.name}</button>)}
            </div>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Remove</div>
            <div className="chips" style={{ marginBottom: 12 }}>
              {labels.map((l) => <button type="button" key={l.id} className={`chip ${removeL.includes(l.id) ? 'on' : ''}`} onClick={() => { setRemoveL(removeL.includes(l.id) ? removeL.filter((x) => x !== l.id) : [...removeL, l.id]); setAddL(addL.filter((x) => x !== l.id)); }}><span className="lbl-dot" style={{ background: l.color }} />{l.name}</button>)}
            </div>
          </>
        )}
        {action === 'follow_up' && (
          <div className="field"><label>Follow-up on</label><input className="input" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
        )}
        {(action === 'remark' || action === 'follow_up') && (
          <div className="field">
            <label>{action === 'remark' ? 'Remark' : 'Note (optional)'}</label>
            <textarea className="input" style={{ height: 80, paddingTop: 8 }} value={remark} onChange={(e) => setRemark(e.target.value)} required={action === 'remark'} />
          </div>
        )}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || (action === 'assign' && !owners.length) || (action === 'status' && !status) || (action === 'labels' && !addL.length && !removeL.length)}>{busy ? 'Applying…' : 'Apply'}</button>
        </div>
      </form>
    </div>
  );
}

function AddLead({ ws, people, canAssign, meId, onClose, onSaved }: {
  ws: WorkspaceSettings; people: Person[]; canAssign: boolean; meId: string; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [form, setForm] = useState({
    name: '', mobile: '', email: '', city: '',
    source: ws.sources.find((s) => s.value === 'manual')?.value ?? ws.sources[0]?.value ?? 'manual',
    pipelineId: ws.pipelines[0]?.id ?? '',
    status: ws.statuses.find((s) => s.isDefault)?.value ?? '',
    ownerId: canAssign ? 'rules' : '',
    remark: '', followUpAt: '',
  });
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const fields = ws.fields.filter((x) => !x.isArchived);
  const byEmail = ws.leadIdentifier === 'email';
  const section = (t: string) => <div className="small" style={{ fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '6px 0 8px' }}>{t}</div>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { ownerId, status, remark, followUpAt, mobile, email, city, ...rest } = form;
      const r = await api<{ id: string }>('/api/v1/leads', {
        method: 'POST',
        body: {
          ...rest, customFields: custom,
          ...(mobile ? { mobile } : {}), ...(email ? { email } : {}), ...(city ? { city } : {}),
          ...(ownerId ? { ownerId } : {}), ...(status ? { status } : {}), ...(remark.trim() ? { remark: remark.trim() } : {}),
          ...(followUpAt ? { followUpAt: fromIstInput(followUpAt).toISOString() } : {}),
        },
      });
      onSaved(r.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 600, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Add lead · {ws.name}</h2>
        {error && <div className="error">{error}</div>}
        {section('Customer')}
        <div className="grid cols-2">
          <div className="field"><label>Name</label><input className="input" value={form.name} onChange={set('name')} required autoFocus /></div>
          <div className="field"><label>Mobile{byEmail ? ' (optional)' : ''}</label><input className="input" value={form.mobile} onChange={set('mobile')} placeholder="98765 43210" required={!byEmail} /></div>
          <div className="field"><label>Email{byEmail ? '' : ' (optional)'}</label><input className="input" type="email" value={form.email} onChange={set('email')} required={byEmail} /></div>
          <div className="field"><label>City (optional)</label><input className="input" value={form.city} onChange={set('city')} /></div>
        </div>
        <p className="small muted" style={{ marginTop: -4 }}>
          If a customer with this {byEmail ? 'email' : 'mobile'} already exists in any business line, the lead is linked to them — no duplicate customer is created.
        </p>

        {section('Lead')}
        <div className="grid cols-2">
          <div className="field">
            <label>Source</label>
            <select className="input" value={form.source} onChange={set('source')}>
              {ws.sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          {ws.pipelines.length > 1 && (
            <div className="field">
              <label>Pipeline</label>
              <select className="input" value={form.pipelineId} onChange={set('pipelineId')}>
                {ws.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label>Assign to</label>
            {canAssign ? (
              <select className="input" value={form.ownerId} onChange={set('ownerId')}>
                <option value="rules">Automatic (assignment rules)</option>
                {people.some((p) => p.id === meId) && <option value={meId}>Me</option>}
                {people.filter((p) => p.id !== meId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : <input className="input" value="By the workspace assignment rules" disabled />}
          </div>
        </div>
        {ws.statuses.length > 0 && (
          <div className="field">
            <label>Status</label>
            <div className="chips">
              {ws.statuses.map((s) => (
                <button type="button" key={s.value} className={`chip ${form.status === s.value ? 'on' : ''}`} onClick={() => setForm({ ...form, status: form.status === s.value ? '' : s.value ?? '' })}>{s.label}</button>
              ))}
            </div>
          </div>
        )}

        {fields.length > 0 && (
          <>
            {section(`${ws.name} details`)}
            <div className="grid cols-2">
              {fields.map((x) => (
                <div key={x.key} className="field" style={x.type === 'multiselect' || x.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                  <label htmlFor={`f_${x.key}`}>{x.label}{x.required && ' *'}</label>
                  <FieldInput field={x} value={custom[x.key]} onChange={(v) => setCustom({ ...custom, [x.key]: v })} />
                </div>
              ))}
            </div>
          </>
        )}

        {section('First touch (optional)')}
        <div className="field"><label>Remark</label><textarea className="input" style={{ height: 64, paddingTop: 8 }} value={form.remark} onChange={set('remark')} placeholder="e.g. Asked for fee details, call after 5 pm" /></div>
        <div className="field"><label>Follow-up on</label><input className="input" type="datetime-local" value={form.followUpAt} onChange={set('followUpAt')} /></div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save lead'}</button>
        </div>
      </form>
    </div>
  );
}

function ShareViewDialog({ view, onClose, onDone }: { view: SavedView; onClose: () => void; onDone: () => void }) {
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<string[]>(view.sharedRoleIds);
  const [error, setError] = useState('');
  useEffect(() => { api<{ id: string; name: string }[]>('/api/v1/roles', { noWorkspace: true }).then(setRoles).catch(() => setRoles([])); }, []);
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
        e.preventDefault();
        try { await api(`/api/v1/views/${view.id}/sharing`, { method: 'PATCH', body: { sharedRoleIds: picked } }); onDone(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed'); }
      }}>
        <h2>Share “{view.name}”</h2>
        <p className="small muted" style={{ marginTop: -4 }}>People with these roles get this view in their list. Each still sees only the leads their own access allows.</p>
        {error && <div className="error">{error}</div>}
        <div className="chips" style={{ marginBottom: 12 }}>
          {roles.map((r) => <button type="button" key={r.id} className={`chip ${picked.includes(r.id) ? 'on' : ''}`} onClick={() => setPicked(picked.includes(r.id) ? picked.filter((x) => x !== r.id) : [...picked, r.id])}>{r.name}</button>)}
        </div>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn">Save sharing</button></div>
      </form>
    </div>
  );
}
