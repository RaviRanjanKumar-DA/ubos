'use client';

import { useState } from 'react';
import type { WorkspaceSettings } from '@/lib/workspace';

export interface Adv {
  stageIds: string[]; statuses: string[]; sources: string[]; owners: string[]; dispositions: string[]; lostReasons: string[]; labelIds: string[];
  createdFrom: string; createdTo: string; assignedFrom: string; assignedTo: string; activityFrom: string; activityTo: string;
  followUpFrom: string; followUpTo: string; contacted: '' | 'yes' | 'no'; stuck: '' | 'yes'; scoreMin: string; scoreMax: string;
  cf: Record<string, string>;
}
export const EMPTY_ADV: Adv = {
  stageIds: [], statuses: [], sources: [], owners: [], dispositions: [], lostReasons: [], labelIds: [],
  createdFrom: '', createdTo: '', assignedFrom: '', assignedTo: '', activityFrom: '', activityTo: '', followUpFrom: '', followUpTo: '',
  contacted: '', stuck: '', scoreMin: '', scoreMax: '', cf: {},
};

/** Query-string parameters for the leads API. */
export function advParams(a: Adv): [string, string][] {
  const out: [string, string][] = [];
  for (const k of ['stageIds', 'statuses', 'sources', 'owners', 'dispositions', 'lostReasons', 'labelIds'] as const) if (a[k]?.length) out.push([k, a[k].join(',')]);
  for (const k of ['createdFrom', 'createdTo', 'assignedFrom', 'assignedTo', 'activityFrom', 'activityTo', 'followUpFrom', 'followUpTo', 'contacted', 'stuck', 'scoreMin', 'scoreMax'] as const) if (a[k]) out.push([k, a[k]]);
  for (const [k, v] of Object.entries(a.cf)) if (v) out.push([`cf_${k}`, v]);
  return out;
}
export const advCount = (a: Adv) => advParams(a).length;

/** Reads filters from a query string (links from dashboards: ?stageIds=…&createdFrom=…). */
export function advFromQuery(q: URLSearchParams): Adv {
  const a: Adv = { ...EMPTY_ADV, cf: {} };
  for (const k of ['stageIds', 'statuses', 'sources', 'owners', 'dispositions', 'lostReasons', 'labelIds'] as const) { const v = q.get(k); if (v) a[k] = v.split(',').filter(Boolean); }
  for (const k of ['createdFrom', 'createdTo', 'assignedFrom', 'assignedTo', 'activityFrom', 'activityTo', 'followUpFrom', 'followUpTo', 'scoreMin', 'scoreMax'] as const) { const v = q.get(k); if (v) a[k] = v; }
  if (q.get('contacted') === 'yes' || q.get('contacted') === 'no') a.contacted = q.get('contacted') as 'yes' | 'no';
  if (q.get('stuck') === 'yes') a.stuck = 'yes';
  for (const [k, v] of q) if (k.startsWith('cf_') && v) a.cf[k.slice(3)] = v;
  return a;
}

/**
 * Flexible filters to follow leads end to end: by stage, status, source, owner, last call outcome, lost reason,
 * dates (created / assigned / last activity / follow-up), contact, SLA breach, score and any custom field.
 */
export function LeadFilters({ ws, people, labels = [], value, onApply, onClose }: {
  ws: WorkspaceSettings; people: { id: string; name: string }[]; labels?: { id: string; name: string; color: string }[]; value: Adv; onApply: (a: Adv) => void; onClose: () => void;
}) {
  const [a, setA] = useState<Adv>(value);
  const toggle = (k: 'stageIds' | 'statuses' | 'sources' | 'owners' | 'dispositions' | 'lostReasons' | 'labelIds', v: string) =>
    setA({ ...a, [k]: a[k].includes(v) ? a[k].filter((x) => x !== v) : [...a[k], v] });
  const Chips = ({ k, items }: { k: 'stageIds' | 'statuses' | 'sources' | 'owners' | 'dispositions' | 'lostReasons' | 'labelIds'; items: [string, string][] }) => (
    <div className="chips">{items.map(([v, l]) => <button type="button" key={v} className={`chip ${a[k].includes(v) ? 'on' : ''}`} onClick={() => toggle(k, v)}>{l}</button>)}</div>
  );
  const Range = ({ label, from, to }: { label: string; from: keyof Adv; to: keyof Adv }) => (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input className="input" type="date" value={a[from] as string} onChange={(e) => setA({ ...a, [from]: e.target.value })} aria-label={`${label} from`} />
        <span className="muted">to</span>
        <input className="input" type="date" value={a[to] as string} onChange={(e) => setA({ ...a, [to]: e.target.value })} aria-label={`${label} to`} />
      </div>
    </div>
  );
  const filterable = ws.fields.filter((f) => !f.isArchived && ['dropdown', 'multiselect', 'text', 'checkbox'].includes(f.type));
  const section = (t: string) => <div className="small" style={{ fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '14px 0 6px' }}>{t}</div>;

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 760, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onApply(a); }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Filters · {ws.name}</h2>
          <button type="button" className="btn sm ghost" onClick={() => setA(EMPTY_ADV)}>Reset all</button>
        </div>
        <p className="small muted" style={{ marginTop: 4 }}>Different filters combine (AND); several choices inside one filter mean any of them (OR).</p>

        {section('Journey')}
        {ws.pipelines.map((p) => (
          <div key={p.id} style={{ marginBottom: 6 }}>
            {ws.pipelines.length > 1 && <div className="small muted">{p.name}</div>}
            <Chips k="stageIds" items={p.stages.map((s) => [s.id!, s.name])} />
          </div>
        ))}
        <div className="grid cols-2">
          <div><div className="small" style={{ marginBottom: 4 }}>Status</div><Chips k="statuses" items={[...ws.statuses.map((s) => [s.value!, s.label] as [string, string]), ['__none__', 'No status']]} /></div>
          <div><div className="small" style={{ marginBottom: 4 }}>Lost reason</div><Chips k="lostReasons" items={ws.lostReasons.map((s) => [s.value!, s.label])} /></div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="row small"><input type="checkbox" checked={a.stuck === 'yes'} onChange={(e) => setA({ ...a, stuck: e.target.checked ? 'yes' : '' })} /> Stuck longer than the stage SLA</label>
        </div>

        {labels.length > 0 && <>{section('Labels')}<Chips k="labelIds" items={labels.map((l) => [l.id, l.name])} /></>}

        {section('People & source')}
        <div className="small" style={{ marginBottom: 4 }}>Owner</div>
        <Chips k="owners" items={[['me', 'Me'], ['unassigned', 'Unassigned'], ...people.map((p) => [p.id, p.name] as [string, string])]} />
        <div className="small" style={{ margin: '8px 0 4px' }}>Source</div>
        <Chips k="sources" items={ws.sources.map((s) => [s.value!, s.label])} />

        {section('Calls')}
        <div className="row" style={{ marginBottom: 6 }}>
          {(['', 'no', 'yes'] as const).map((v) => (
            <button type="button" key={v || 'any'} className={`chip ${a.contacted === v ? 'on' : ''}`} onClick={() => setA({ ...a, contacted: v })}>{v === '' ? 'Any' : v === 'no' ? 'Not worked yet' : 'Worked at least once (call or remark)'}</button>
          ))}
        </div>
        <div className="small" style={{ marginBottom: 4 }}>Last call outcome</div>
        <Chips k="dispositions" items={ws.dispositions.map((s) => [s.value!, s.label])} />

        {section('Dates')}
        <div className="grid cols-2">
          <Range label="Created" from="createdFrom" to="createdTo" />
          <Range label="Assigned" from="assignedFrom" to="assignedTo" />
          <Range label="Last activity" from="activityFrom" to="activityTo" />
          <Range label="Next follow-up" from="followUpFrom" to="followUpTo" />
        </div>

        {section('Score & details')}
        <div className="grid cols-2">
          <div className="field">
            <label>Lead score</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input" type="number" placeholder="Min" value={a.scoreMin} onChange={(e) => setA({ ...a, scoreMin: e.target.value })} />
              <span className="muted">to</span>
              <input className="input" type="number" placeholder="Max" value={a.scoreMax} onChange={(e) => setA({ ...a, scoreMax: e.target.value })} />
            </div>
          </div>
          {filterable.map((f) => (
            <div key={f.key} className="field">
              <label>{f.label}</label>
              {f.options.length ? (
                <select className="input" value={a.cf[f.key] ?? ''} onChange={(e) => setA({ ...a, cf: { ...a.cf, [f.key]: e.target.value } })}>
                  <option value="">Any</option>
                  {f.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : f.type === 'checkbox' ? (
                <select className="input" value={a.cf[f.key] ?? ''} onChange={(e) => setA({ ...a, cf: { ...a.cf, [f.key]: e.target.value } })}>
                  <option value="">Any</option><option value="true">Yes</option><option value="false">No</option>
                </select>
              ) : (
                <input className="input" value={a.cf[f.key] ?? ''} onChange={(e) => setA({ ...a, cf: { ...a.cf, [f.key]: e.target.value } })} placeholder="Exact value" />
              )}
            </div>
          ))}
        </div>
        <div className="row end" style={{ marginTop: 10 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">Apply filters ({advCount(a)})</button>
        </div>
      </form>
    </div>
  );
}
