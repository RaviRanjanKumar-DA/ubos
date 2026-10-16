'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Field, FIELD_TYPE_LABELS, Option, Pipeline, Stage, WorkspaceSettings } from '@/lib/workspace';

type Tab = 'pipelines' | 'fields' | 'lists' | 'general';
type Msg = { type: 'error' | 'notice'; text: string } | null;

export default function WorkspaceSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useShell();
  const [data, setData] = useState<WorkspaceSettings | null>(null);
  const [tab, setTab] = useState<Tab>('pipelines');
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(() => api<WorkspaceSettings>(`/api/v1/workspaces/${id}/settings`).then(setData).catch((e) => setMsg({ type: 'error', text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);

  /** Runs a save, shows the result, reloads. */
  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try {
      await fn();
      await load();
      setMsg({ type: 'notice', text });
      return true;
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
      return false;
    }
  };

  if (!data) return msg ? <div className="error">{msg.text}</div> : <div className="muted">Loading…</div>;
  const ro = !data.canManage;
  const isOrgAdmin = me.permissions['org.workspace.manage'] === 'ORGANIZATION';

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link href="/app/workspaces">Workspaces</Link> /</div>
          <h1>{data.name} — Settings</h1>
          {ro && <div className="small muted">View only — ask your administrator to change these settings.</div>}
        </div>
      </div>
      <div className="row" style={{ gap: 4, marginBottom: 14, borderBottom: '1px solid var(--line)' }}>
        {([['pipelines', 'Pipelines & stages'], ['fields', 'Lead fields'], ['lists', 'Sources & lost reasons'], ['general', 'General']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setMsg(null); }} className="btn ghost"
            style={{ borderRadius: 0, borderBottom: tab === k ? '2px solid var(--brand)' : '2px solid transparent', color: tab === k ? 'var(--brand)' : undefined }}>
            {label}
          </button>
        ))}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      {tab === 'pipelines' && (
        <>
          {data.pipelines.map((p) => <PipelineEditor key={p.id} pipeline={p} readOnly={ro} act={act} canDelete={data.pipelines.length > 1} />)}
          {!ro && (
            <button className="btn outline" onClick={() => {
              const name = prompt('Name of the new pipeline / process, e.g. Renewals');
              if (name) act(() => api(`/api/v1/workspaces/${id}/pipelines`, { method: 'POST', body: { name } }), 'Pipeline added.');
            }}>+ Add pipeline</button>
          )}
        </>
      )}
      {tab === 'fields' && <FieldsEditor ws={data} readOnly={ro} act={act} />}
      {tab === 'lists' && (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <OptionList title="Lead sources" hint="Where leads come from. Used in the Add lead form and source reports." items={data.sources} readOnly={ro}
            onSave={(options) => act(() => api(`/api/v1/workspaces/${id}/options/lead_source`, { method: 'PUT', body: { options } }), 'Lead sources saved.')} />
          <OptionList title="Lost reasons" hint="Asked when a lead is moved to a Lost stage." items={data.lostReasons} readOnly={ro}
            onSave={(options) => act(() => api(`/api/v1/workspaces/${id}/options/lost_reason`, { method: 'PUT', body: { options } }), 'Lost reasons saved.')} />
        </div>
      )}
      {tab === 'general' && (
        <div className="card" style={{ maxWidth: 520 }}>
          <h2>General</h2>
          <p className="small muted">Industry template: {data.template ?? '—'}</p>
          {isOrgAdmin ? (
            <div className="row">
              <button className="btn outline" onClick={() => {
                const name = prompt('Workspace name', data.name);
                if (name) act(() => api(`/api/v1/workspaces/${id}`, { method: 'PATCH', body: { name }, noWorkspace: true }), 'Renamed.');
              }}>Rename</button>
              <button className={`btn ${data.isArchived ? 'outline' : 'danger'}`} onClick={() => {
                if (data.isArchived || confirm(`Archive ${data.name}? It disappears from the workspace switcher; its data is kept.`)) {
                  act(() => api(`/api/v1/workspaces/${id}`, { method: 'PATCH', body: { isArchived: !data.isArchived }, noWorkspace: true }), data.isArchived ? 'Workspace restored.' : 'Workspace archived.');
                }
              }}>{data.isArchived ? 'Restore workspace' : 'Archive workspace'}</button>
            </div>
          ) : <p className="small muted">Only organization admins can rename or archive a workspace.</p>}
        </div>
      )}
    </>
  );
}

function PipelineEditor({ pipeline, readOnly, act, canDelete }: {
  pipeline: Pipeline; readOnly: boolean; canDelete: boolean; act: (fn: () => Promise<unknown>, text: string) => Promise<boolean>;
}) {
  const [stages, setStages] = useState<Stage[]>(pipeline.stages);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setStages(pipeline.stages); setDirty(false); }, [pipeline]);

  const update = (next: Stage[]) => { setStages(next); setDirty(true); };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{pipeline.name} pipeline</h2>
        {!readOnly && (
          <div className="row" style={{ gap: 4 }}>
            <button className="btn sm ghost" onClick={() => {
              const name = prompt('Rename pipeline', pipeline.name);
              if (name) act(() => api(`/api/v1/pipelines/${pipeline.id}`, { method: 'PATCH', body: { name } }), 'Pipeline renamed.');
            }}>Rename</button>
            {canDelete && <button className="btn sm ghost" onClick={() => confirm(`Delete the ${pipeline.name} pipeline?`) && act(() => api(`/api/v1/pipelines/${pipeline.id}`, { method: 'DELETE' }), 'Pipeline deleted.')}>Delete</button>}
          </div>
        )}
      </div>
      <div className="table-wrap"><table className="table" style={{ minWidth: 520 }}>
        <thead><tr><th style={{ width: 40 }}>#</th><th>Stage</th><th>Type</th><th>Leads</th>{!readOnly && <th />}</tr></thead>
        <tbody>
          {stages.map((s, i) => (
            <tr key={s.id ?? `new-${i}`}>
              <td className="muted">{i + 1}</td>
              <td>
                {readOnly ? s.name : (
                  <input className="input" style={{ height: 30, minWidth: 150, maxWidth: 240 }} value={s.name} onChange={(e) => update(stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                )}
              </td>
              <td>
                {readOnly ? (s.isWon ? <span className="badge ok">Won</span> : s.isLost ? <span className="badge bad">Lost</span> : <span className="badge grey">Open</span>) : (
                  <select className="input" style={{ height: 30, width: 110 }} value={s.isWon ? 'won' : s.isLost ? 'lost' : 'open'}
                    onChange={(e) => update(stages.map((x, j) => (j === i ? { ...x, isWon: e.target.value === 'won', isLost: e.target.value === 'lost' } : x)))}>
                    <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
                  </select>
                )}
              </td>
              <td className="muted">{s.leadCount ?? 0}</td>
              {!readOnly && (
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn sm ghost" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                  <button type="button" className="btn sm ghost" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === stages.length - 1}>↓</button>
                  <button type="button" className="btn sm ghost" aria-label="Remove stage" disabled={!!s.leadCount} title={s.leadCount ? 'Move its leads first' : undefined}
                    onClick={() => update(stages.filter((_, j) => j !== i))}>✕</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table></div>
      {!readOnly && (
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <button type="button" className="btn sm outline" onClick={() => {
            const firstClosed = stages.findIndex((s) => s.isWon || s.isLost);
            const at = firstClosed === -1 ? stages.length : firstClosed;
            update([...stages.slice(0, at), { name: 'New stage', isWon: false, isLost: false }, ...stages.slice(at)]);
          }}>+ Add stage</button>
          <div className="row">
            {dirty && <button type="button" className="btn ghost" onClick={() => { setStages(pipeline.stages); setDirty(false); }}>Undo</button>}
            <button type="button" className="btn" disabled={!dirty}
              onClick={() => act(() => api(`/api/v1/pipelines/${pipeline.id}/stages`, {
                method: 'PUT', body: { stages: stages.map(({ id, name, isWon, isLost }) => ({ id, name, isWon, isLost })) },
              }), 'Stages saved.')}>Save stages</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldsEditor({ ws, readOnly, act }: { ws: WorkspaceSettings; readOnly: boolean; act: (fn: () => Promise<unknown>, text: string) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Field | null>(null);
  const [form, setForm] = useState({ label: '', type: 'text', options: '', required: false });

  const openNew = () => { setForm({ label: '', type: 'text', options: '', required: false }); setEditing(null); setAdding(true); };
  const openEdit = (f: Field) => { setForm({ label: f.label, type: f.type, options: f.options.join('\n'), required: f.required }); setEditing(f); setAdding(true); };
  const needsOptions = form.type === 'dropdown' || form.type === 'multiselect';
  const options = form.options.split('\n').map((o) => o.trim()).filter(Boolean);

  const move = (i: number, d: number) => {
    const ids = ws.fields.map((f) => f.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    act(() => api(`/api/v1/workspaces/${ws.id}/fields/order`, { method: 'PUT', body: { ids } }), 'Order saved.');
  };

  return (
    <>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table" style={{ minWidth: 620 }}>
          <thead><tr><th>Field</th><th>Type</th><th>Options</th><th>Required</th>{!readOnly && <th />}</tr></thead>
          <tbody>
            {ws.fields.map((f, i) => (
              <tr key={f.id} style={{ opacity: f.isArchived ? 0.5 : 1 }}>
                <td><b>{f.label}</b>{f.isArchived && <span className="badge grey" style={{ marginLeft: 6 }}>Archived</span>}<div className="small muted"><code>{f.key}</code></div></td>
                <td>{FIELD_TYPE_LABELS[f.type] ?? f.type}</td>
                <td className="small">{f.options.join(', ') || <span className="muted">—</span>}</td>
                <td>{f.required ? <span className="badge warn">Required</span> : <span className="muted small">Optional</span>}</td>
                {!readOnly && (
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm ghost" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                    <button className="btn sm ghost" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === ws.fields.length - 1}>↓</button>
                    <button className="btn sm ghost" onClick={() => openEdit(f)}>Edit</button>
                    <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/fields/${f.id}`, { method: 'PATCH', body: { isArchived: !f.isArchived } }), f.isArchived ? 'Field restored.' : 'Field archived (existing values are kept).')}>
                      {f.isArchived ? 'Restore' : 'Archive'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!ws.fields.length && <div className="empty">No custom fields yet.</div>}
      </div>
      {!readOnly && <button className="btn outline" style={{ marginTop: 12 }} onClick={openNew}>+ Add field</button>}

      {adding && (
        <div className="modal-bg" onClick={() => setAdding(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(
              () => editing
                ? api(`/api/v1/fields/${editing.id}`, { method: 'PATCH', body: { label: form.label, required: form.required, ...(needsOptions ? { options } : {}) } })
                : api(`/api/v1/workspaces/${ws.id}/fields`, { method: 'POST', body: { label: form.label, type: form.type, required: form.required, options: needsOptions ? options : [] } }),
              editing ? 'Field updated.' : 'Field added.',
            );
            if (ok) setAdding(false);
          }}>
            <h2>{editing ? `Edit ${editing.label}` : 'Add lead field'}</h2>
            <div className="field"><label>Field name</label><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Property type" required autoFocus /></div>
            <div className="field">
              <label>Type</label>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} disabled={!!editing}>
                {Object.entries(FIELD_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {editing && <span className="small muted">The type cannot change after creation, so existing values stay valid.</span>}
            </div>
            {needsOptions && (
              <div className="field">
                <label>Options (one per line)</label>
                <textarea className="input" style={{ height: 110, paddingTop: 8 }} value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} placeholder={'Home\nOffice\nShop'} />
              </div>
            )}
            <label className="row small" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /> Required when adding a lead
            </label>
            <div className="row end">
              <button type="button" className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn">{editing ? 'Save' : 'Add field'}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function OptionList({ title, hint, items, readOnly, onSave }: {
  title: string; hint: string; items: Option[]; readOnly: boolean; onSave: (options: { id?: string; label: string }[]) => Promise<boolean>;
}) {
  const [list, setList] = useState<Option[]>(items);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setList(items); setDirty(false); }, [items]);
  const change = (next: Option[]) => { setList(next); setDirty(true); };

  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="small muted" style={{ marginTop: -4 }}>{hint}</p>
      {list.map((o, i) => (
        <div key={o.id ?? `n-${i}`} className="row" style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
          {readOnly ? <span>{o.label}</span> : (
            <>
              <input className="input" style={{ height: 30 }} value={o.label} onChange={(e) => change(list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <button type="button" className="btn sm ghost" aria-label="Remove" onClick={() => change(list.filter((_, j) => j !== i))}>✕</button>
            </>
          )}
        </div>
      ))}
      {!readOnly && (
        <>
          <form className="row" style={{ flexWrap: 'nowrap', marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { change([...list, { label: draft.trim() }]); setDraft(''); } }}>
            <input className="input" style={{ height: 30 }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add new…" />
            <button className="btn sm outline">Add</button>
          </form>
          <div className="row end" style={{ marginTop: 10 }}>
            <button className="btn" disabled={!dirty} onClick={() => onSave(list.map(({ id, label }) => ({ id, label })))}>Save</button>
          </div>
        </>
      )}
    </div>
  );
}
