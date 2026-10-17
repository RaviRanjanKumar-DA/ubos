'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Field, FIELD_TYPE_LABELS, WorkspaceSettings } from '@/lib/workspace';

type Act = (fn: () => Promise<unknown>, text: string) => Promise<boolean>;
const BUILT_IN: [string, string][] = [['name', 'Name'], ['mobile', 'Mobile'], ['email', 'Email ID'], ['city', 'City'], ['source', 'Source'], ['customerCode', 'Customer ID']];
const fmt = (d?: string) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** Fields settings: Lead ID, primary display fields (H1 / H2) and the custom lead fields of a workspace. */
export function FieldsSettings({ ws, readOnly, isOrgAdmin, act }: { ws: WorkspaceSettings; readOnly: boolean; isOrgAdmin: boolean; act: Act }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [sort, setSort] = useState<'position' | 'name' | 'modified'>('position');
  const [editing, setEditing] = useState<Field | 'new' | null>(null);
  const [display, setDisplay] = useState(ws.display);

  const slotOptions: [string, string][] = [...BUILT_IN, ...ws.fields.filter((f) => !f.isArchived).map((f) => [`cf:${f.key}`, f.label] as [string, string])];
  const list = useMemo(() => {
    const l = ws.fields.filter((f) => (view === 'archived' ? f.isArchived : !f.isArchived) && (!type || f.type === type) && (!q || `${f.label} ${f.key}`.toLowerCase().includes(q.toLowerCase())));
    if (sort === 'name') l.sort((a, b) => a.label.localeCompare(b.label));
    if (sort === 'modified') l.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return l;
  }, [ws.fields, q, type, view, sort]);

  const move = (f: Field, d: number) => {
    const ids = ws.fields.map((x) => x.id);
    const i = ids.indexOf(f.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    act(() => api(`/api/v1/workspaces/${ws.id}/fields/order`, { method: 'PUT', body: { ids } }), 'Order saved.');
  };

  return (
    <>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Fields settings</h2>
        {!readOnly && <button className="btn" onClick={() => setEditing('new')}>+ Add a new field</button>}
      </div>

      <div className="small muted" style={{ marginBottom: 4 }}>Lead ID — the value that makes a customer unique across all business lines</div>
      <div className="card row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <b>{ws.leadIdentifier === 'email' ? 'Email ID' : 'Mobile number'}</b>
          <div className="small muted">{ws.leadIdentifier === 'email' ? 'abc@xyz.com — required on every lead; mobile optional' : '98765 43210 — required on every lead; email optional'}</div>
        </div>
        {isOrgAdmin && (
          <button className="btn sm ghost" onClick={() => {
            const next = ws.leadIdentifier === 'email' ? 'mobile' : 'email';
            if (confirm(`Change the Lead ID to ${next === 'email' ? 'Email ID' : 'Mobile number'} for the whole organization? New leads will need it.`)) {
              act(() => api('/api/v1/settings/lead-identifier', { method: 'PUT', body: { leadIdentifier: next }, noWorkspace: true }), 'Lead ID changed.');
            }
          }}>Change</button>
        )}
      </div>

      <div className="small muted" style={{ marginBottom: 4 }}>Primary — what lists and lead headers show first</div>
      <div className="card" style={{ marginBottom: 14, padding: 10 }}>
        {(['h1', 'h2'] as const).map((slot) => (
          <div key={slot} className="row" style={{ padding: '6px 4px', flexWrap: 'nowrap' }}>
            <span className="muted" style={{ width: 34 }}>{slot.toUpperCase()}:</span>
            <select className="input" style={{ maxWidth: 280 }} disabled={readOnly} value={display[slot]} onChange={(e) => setDisplay({ ...display, [slot]: e.target.value })}>
              {slotOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <span className="small muted">{slot === 'h1' ? 'Title of a lead' : 'Second line'}</span>
          </div>
        ))}
        {!readOnly && (display.h1 !== ws.display.h1 || display.h2 !== ws.display.h2) && (
          <div className="row end"><button className="btn sm" onClick={() => act(() => api(`/api/v1/workspaces/${ws.id}/display`, { method: 'PUT', body: display }), 'Primary fields saved.')}>Save</button></div>
        )}
      </div>

      <div className="small muted" style={{ marginBottom: 4 }}>Other fields</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {Object.entries(FIELD_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={view} onChange={(e) => setView(e.target.value as 'active' | 'archived')} aria-label="Active or archived">
          <option value="active">Active fields</option>
          <option value="archived">Archived fields</option>
        </select>
      </div>
      <div className="small muted" style={{ marginBottom: 6 }}>{list.length} result(s) found</div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table" style={{ minWidth: 700 }}>
          <thead>
            <tr>
              <th><button className="btn ghost sm" style={{ padding: 0 }} onClick={() => setSort(sort === 'name' ? 'position' : 'name')}>Field name {sort === 'name' ? '↑' : '⇅'}</button></th>
              <th>Type</th><th>Options</th><th>Created on</th>
              <th><button className="btn ghost sm" style={{ padding: 0 }} onClick={() => setSort(sort === 'modified' ? 'position' : 'modified')}>Last modified {sort === 'modified' ? '↓' : '⇅'}</button></th>
              {!readOnly && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.id}>
                <td><b>{f.label}</b> {f.required && <span className="badge warn">Required</span>}<div className="small muted"><code>{f.key}</code></div></td>
                <td>{FIELD_TYPE_LABELS[f.type] ?? f.type}</td>
                <td className="small" style={{ maxWidth: 220 }}>{f.options.join(', ') || <span className="muted">—</span>}</td>
                <td className="small muted">{fmt(f.createdAt)}</td>
                <td className="small muted">{fmt(f.updatedAt)}</td>
                {!readOnly && (
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {sort === 'position' && view === 'active' && <>
                      <button className="btn sm ghost" aria-label="Move up" onClick={() => move(f, -1)}>↑</button>
                      <button className="btn sm ghost" aria-label="Move down" onClick={() => move(f, 1)}>↓</button>
                    </>}
                    <button className="btn sm ghost" onClick={() => setEditing(f)}>Edit</button>
                    <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/fields/${f.id}`, { method: 'PATCH', body: { isArchived: !f.isArchived } }), f.isArchived ? 'Field restored.' : 'Field archived (values kept).')}>{f.isArchived ? 'Restore' : 'Archive'}</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">No fields here.</div>}
      </div>
      {editing && <FieldDialog ws={ws} field={editing === 'new' ? null : editing} act={act} onClose={() => setEditing(null)} />}
    </>
  );
}

function FieldDialog({ ws, field, act, onClose }: { ws: WorkspaceSettings; field: Field | null; act: Act; onClose: () => void }) {
  const [f, setF] = useState({ label: field?.label ?? '', type: field?.type ?? 'text', options: field?.options.join('\n') ?? '', required: field?.required ?? false });
  const needsOptions = f.type === 'dropdown' || f.type === 'multiselect';
  const options = f.options.split('\n').map((o) => o.trim()).filter(Boolean);
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
        e.preventDefault();
        const ok = await act(
          () => field
            ? api(`/api/v1/fields/${field.id}`, { method: 'PATCH', body: { label: f.label, required: f.required, ...(needsOptions ? { options } : {}) } })
            : api(`/api/v1/workspaces/${ws.id}/fields`, { method: 'POST', body: { label: f.label, type: f.type, required: f.required, options: needsOptions ? options : [] } }),
          field ? 'Field updated.' : 'Field added.',
        );
        if (ok) onClose();
      }}>
        <h2>{field ? `Edit ${field.label}` : 'Add a new field'}</h2>
        <div className="field"><label>Field name</label><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Property type" required autoFocus /></div>
        <div className="field">
          <label>Type</label>
          <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} disabled={!!field}>
            {Object.entries(FIELD_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {field && <span className="small muted">The type is fixed after creation so existing values stay valid.</span>}
        </div>
        {needsOptions && (
          <div className="field"><label>Options (one per line)</label><textarea className="input" style={{ height: 110, paddingTop: 8 }} value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} /></div>
        )}
        <label className="row small" style={{ marginBottom: 12 }}><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> Required when adding a lead</label>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">{field ? 'Save' : 'Add field'}</button>
        </div>
      </form>
    </div>
  );
}
