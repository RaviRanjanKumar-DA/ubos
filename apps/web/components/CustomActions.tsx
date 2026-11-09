'use client';

import { Icon } from '@/components/Icon';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { FIELD_TYPE_LABELS } from '@/lib/workspace';

export interface Question { key?: string; label: string; type: string; options: string[]; required: boolean }
export interface CustomAction {
  id: string; code: number; name: string; description: string | null; workspaceId: string | null; score: number;
  fields: Question[]; isArchived: boolean; timesUsed: number; canManage: boolean;
}

/** Custom actions of a workspace: forms people run from a lead; each answer adds the action's score to the lead. */
export function CustomActions({ workspaceId, readOnly }: { workspaceId: string; readOnly: boolean }) {
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [list, setList] = useState<CustomAction[] | null>(null);
  const [counts, setCounts] = useState({ active: 0, archived: 0 });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<CustomAction | 'new' | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  const load = () => Promise.all([
    api<CustomAction[]>(`/api/v1/custom-actions?workspaceId=${workspaceId}&archived=false`),
    api<CustomAction[]>(`/api/v1/custom-actions?workspaceId=${workspaceId}&archived=true`),
  ]).then(([a, b]) => { setCounts({ active: a.length, archived: b.length }); setList(tab === 'active' ? a : b); }).catch((e) => setMsg({ type: 'error', text: e.message }));
  useEffect(() => { load(); }, [tab, workspaceId]);

  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); await load(); setMsg({ type: 'notice', text }); return true; } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
      return false;
    }
  };
  const shown = (list ?? []).filter((a) => !q || `${a.name} ${a.code}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Custom actions</h2>
          <div className="small muted">Short forms people fill from a lead (e.g. Course Details, Site visit report). Answers go on the lead journey and add to the lead score.</div>
        </div>
        {!readOnly && <button className="btn" onClick={() => setEditing('new')}>+ Add a new action</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <input className="input" placeholder="Search custom action by name or code" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
      <div className="small muted" style={{ marginBottom: 8 }}>{shown.length} action(s) found</div>
      <div className="row" style={{ gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 10 }}>
        {(['active', 'archived'] as const).map((t) => (
          <button key={t} className="btn ghost sm" onClick={() => setTab(t)} style={{ borderRadius: 0, borderBottom: tab === t ? '2px solid var(--brand)' : '2px solid transparent', color: tab === t ? 'var(--brand)' : undefined }}>
            {t === 'active' ? 'Active' : `Archived (${counts.archived})`}
          </button>
        ))}
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table" style={{ minWidth: 560 }}>
          <thead><tr><th>Name</th><th>Code</th><th>Score</th><th>Applies to</th><th>Used</th><th>Actions</th></tr></thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id}>
                <td><b>{a.name}</b><div className="small muted">{a.fields.length} question(s){a.description ? ` · ${a.description}` : ''}</div></td>
                <td>{a.code}</td>
                <td>{a.score > 0 ? `+${a.score}` : a.score}</td>
                <td className="small">{a.workspaceId ? 'This business line' : 'All business lines'}</td>
                <td>{a.timesUsed}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {a.canManage && !readOnly && <>
                    <button className="btn sm ghost" onClick={() => setEditing(a)}>Edit</button>
                    <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/custom-actions/${a.id}/duplicate`, { method: 'POST' }), 'Action duplicated.')}>Duplicate</button>
                    <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/custom-actions/${a.id}`, { method: 'PATCH', body: { isArchived: !a.isArchived } }), a.isArchived ? 'Action restored.' : 'Action archived.')}>{a.isArchived ? 'Restore' : 'Archive'}</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list && !shown.length && <div className="empty">No custom actions here yet.</div>}
      </div>
      {editing && <ActionDialog action={editing === 'new' ? null : editing} workspaceId={workspaceId} onClose={() => setEditing(null)}
        onSave={async (body) => { if (await act(() => editing === 'new' ? api('/api/v1/custom-actions', { method: 'POST', body }) : api(`/api/v1/custom-actions/${editing.id}`, { method: 'PATCH', body }), 'Action saved.')) setEditing(null); }} />}
    </>
  );
}

function ActionDialog({ action, workspaceId, onClose, onSave }: { action: CustomAction | null; workspaceId: string; onClose: () => void; onSave: (b: unknown) => void }) {
  const [name, setName] = useState(action?.name ?? '');
  const [description, setDescription] = useState(action?.description ?? '');
  const [score, setScore] = useState(action?.score ?? 10);
  const [scope, setScope] = useState<'ws' | 'all'>(action && !action.workspaceId ? 'all' : 'ws');
  const [qs, setQs] = useState<Question[]>(action?.fields ?? [{ label: '', type: 'dropdown', options: [], required: true }]);
  const setQ = (i: number, patch: Partial<Question>) => setQs(qs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 640, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onSave({ name, description: description || null, score, workspaceId: scope === 'ws' ? workspaceId : null, fields: qs }); }}>
        <h2>{action ? `Edit ${action.name}` : 'New custom action'}{action ? ` · ${action.code}` : ''}</h2>
        <div className="grid cols-2">
          <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Course Details" required /></div>
          <div className="field"><label>Score added to the lead</label><input className="input" type="number" min={-100} max={100} value={score} onChange={(e) => setScore(Number(e.target.value))} /></div>
        </div>
        <div className="field"><label>Description (optional)</label><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="field">
          <label>Available in</label>
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value as 'ws' | 'all')}>
            <option value="ws">This business line only</option>
            <option value="all">All business lines (organization admins)</option>
          </select>
        </div>
        <h2 style={{ fontSize: 14 }}>Questions</h2>
        {qs.map((x, i) => (
          <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input" value={x.label} onChange={(e) => setQ(i, { label: e.target.value })} placeholder={`Question ${i + 1}`} required />
              <select className="input" style={{ width: 190 }} value={x.type} onChange={(e) => setQ(i, { type: e.target.value })}>
                {Object.entries(FIELD_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <button type="button" className="btn sm ghost" aria-label="Remove question" onClick={() => setQs(qs.filter((_, j) => j !== i))} disabled={qs.length === 1}><Icon name="close" className="ic" /></button>
            </div>
            {(x.type === 'dropdown' || x.type === 'multiselect') && (
              <input className="input" style={{ marginTop: 6 }} value={x.options.join(', ')} onChange={(e) => setQ(i, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })} placeholder="Options, separated by commas" />
            )}
            <label className="row small" style={{ marginTop: 6 }}><input type="checkbox" checked={x.required} onChange={(e) => setQ(i, { required: e.target.checked })} /> Required</label>
          </div>
        ))}
        <button type="button" className="btn sm outline" onClick={() => setQs([...qs, { label: '', type: 'text', options: [], required: false }])}>+ Add question</button>
        <div className="row end" style={{ marginTop: 12 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">Save action</button>
        </div>
      </form>
    </div>
  );
}
