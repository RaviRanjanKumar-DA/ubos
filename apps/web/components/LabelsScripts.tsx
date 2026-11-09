'use client';

import { askText } from '@/components/Dialogs';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { WorkspaceSettings } from '@/lib/workspace';

interface Label { id: string; name: string; color: string; workspaceId: string | null; isArchived: boolean }
interface Script { id: string; stageId: string | null; title: string; body: string; isArchived: boolean }
const COLORS = ['#5b3cc4', '#d6455d', '#1f9d55', '#e08a1e', '#2f7fd8', '#8a5cf6', '#14a3a3', '#c2185b', '#546e7a', '#111111'];
type Msg = { type: 'error' | 'notice'; text: string } | null;

/** Labels (tags) for this business line, plus the organization-wide ones (editable by organization admins). */
export function LabelsSettings({ ws, readOnly, isOrgAdmin }: { ws: WorkspaceSettings; readOnly: boolean; isOrgAdmin: boolean }) {
  const [list, setList] = useState<Label[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [draft, setDraft] = useState({ name: '', color: COLORS[0], orgWide: false });
  const [msg, setMsg] = useState<Msg>(null);
  const load = useCallback(() => api<Label[]>(`/api/v1/labels?workspaceId=${ws.id}&archived=${archived}`, { workspace: ws.id }).then(setList).catch((e) => setMsg({ type: 'error', text: e.message })), [ws.id, archived]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); await load(); setMsg({ type: 'notice', text }); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  };
  const canEdit = (l: Label) => !readOnly && (l.workspaceId ? true : isOrgAdmin);

  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Labels</h2>
        <label className="row small"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
      </div>
      <p className="small muted">Coloured tags for leads — e.g. VIP, Site visit due, Referral partner. Filter the leads list by label and add or remove them in bulk.</p>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {!readOnly && !archived && (
        <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); run(() => api('/api/v1/labels', { method: 'POST', workspace: ws.id, body: { name: draft.name, color: draft.color, workspaceId: draft.orgWide ? null : ws.id } }), 'Label added.').then((ok) => ok && setDraft({ ...draft, name: '' })); }}>
          <input className="input" style={{ width: 220 }} placeholder="New label name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={40} />
          <span className="row" style={{ gap: 3 }}>
            {COLORS.map((c) => <button type="button" key={c} aria-label={`Colour ${c}`} onClick={() => setDraft({ ...draft, color: c })} style={{ width: 22, height: 22, borderRadius: 6, background: c, border: draft.color === c ? '2px solid #000' : '1px solid rgba(0,0,0,.1)', cursor: 'pointer' }} />)}
          </span>
          {isOrgAdmin && <label className="row small"><input type="checkbox" checked={draft.orgWide} onChange={(e) => setDraft({ ...draft, orgWide: e.target.checked })} /> All business lines</label>}
          <button className="btn sm">Add label</button>
        </form>
      )}
      {list?.map((l) => (
        <div key={l.id} className="row" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
          <span className="row" style={{ gap: 8 }}>
            <span className="lbl" style={{ background: l.color, fontSize: 12 }}>{l.name}</span>
            <span className="small muted">{l.workspaceId ? 'This business line' : 'All business lines'}</span>
          </span>
          {canEdit(l) && (
            <span className="row" style={{ gap: 2 }}>
              {!l.isArchived && <button className="btn sm ghost" onClick={async () => { const n = await askText('Rename label', l.name); if (n && n !== l.name) run(() => api(`/api/v1/labels/${l.id}`, { method: 'PATCH', workspace: ws.id, body: { name: n } }), 'Label renamed.'); }}>Rename</button>}
              <button className="btn sm ghost" onClick={() => run(() => api(`/api/v1/labels/${l.id}`, { method: 'PATCH', workspace: ws.id, body: { isArchived: !l.isArchived } }), l.isArchived ? 'Label restored.' : 'Label archived (kept on old leads).')}>{l.isArchived ? 'Restore' : 'Archive'}</button>
            </span>
          )}
        </div>
      ))}
      {list && !list.length && <div className="empty">No labels yet.</div>}
    </div>
  );
}

/** Call scripts shown in the Log-call panel — one per stage, or a general one. */
export function CallScripts({ ws, readOnly }: { ws: WorkspaceSettings; readOnly: boolean }) {
  const [list, setList] = useState<Script[] | null>(null);
  const [editing, setEditing] = useState<Script | 'new' | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const stages = ws.pipelines.flatMap((p) => p.stages.filter((s) => !s.isWon && !s.isLost).map((s) => ({ id: s.id!, name: ws.pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name, color: s.color })));
  const load = useCallback(() => api<Script[]>(`/api/v1/call-scripts?workspaceId=${ws.id}`, { workspace: ws.id }).then(setList).catch((e) => setMsg({ type: 'error', text: e.message })), [ws.id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); await load(); setMsg({ type: 'notice', text }); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  };

  return (
    <>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Call scripts</h2>
          <div className="small muted">What to say at each stage. The script for the lead’s current stage (or the general one) appears when logging a call.</div>
        </div>
        {!readOnly && <button className="btn" onClick={() => setEditing('new')}>+ Add script</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        {list?.map((s) => {
          const st = stages.find((x) => x.id === s.stageId);
          return (
            <div key={s.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{s.title}</b>
                <span className="badge" style={st ? { background: st.color ?? undefined } : undefined}>{st ? st.name : 'General'}</span>
              </div>
              <div className="script-body" style={{ maxHeight: 160, overflow: 'auto' }}>{s.body}</div>
              {!readOnly && (
                <div className="row end" style={{ marginTop: 8 }}>
                  <button className="btn sm ghost" onClick={() => setEditing(s)}>Edit</button>
                  <button className="btn sm ghost" onClick={() => run(() => api(`/api/v1/call-scripts/${s.id}`, { method: 'PATCH', workspace: ws.id, body: { isArchived: true } }), 'Script archived.')}>Archive</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {list && !list.length && <div className="card empty">No scripts yet.</div>}
      {editing && (
        <ScriptDialog script={editing === 'new' ? null : editing} stages={stages} onClose={() => setEditing(null)}
          onSave={async (b) => { if (await run(() => (editing === 'new' ? api('/api/v1/call-scripts', { method: 'POST', workspace: ws.id, body: { ...b, workspaceId: ws.id } }) : api(`/api/v1/call-scripts/${editing.id}`, { method: 'PATCH', workspace: ws.id, body: b })), 'Script saved.')) setEditing(null); }} />
      )}
    </>
  );
}

function ScriptDialog({ script, stages, onClose, onSave }: { script: Script | null; stages: { id: string; name: string }[]; onClose: () => void; onSave: (b: { title: string; body: string; stageId: string | null }) => void }) {
  const [f, setF] = useState({ title: script?.title ?? '', body: script?.body ?? '', stageId: script?.stageId ?? '' });
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave({ title: f.title, body: f.body, stageId: f.stageId || null }); }}>
        <h2>{script ? 'Edit script' : 'New call script'}</h2>
        <div className="grid cols-2">
          <div className="field"><label>Title</label><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={2} placeholder="e.g. Book the site visit" /></div>
          <div className="field"><label>Show at stage</label>
            <select className="input" value={f.stageId} onChange={(e) => setF({ ...f, stageId: e.target.value })}>
              <option value="">Any stage (general)</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field"><label>Script</label><textarea className="input" style={{ height: 220, paddingTop: 8 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required placeholder={'1. Greet and confirm the name\n2. Ask about …\n3. Handle the objection “too costly”: …'} /></div>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn">Save script</button></div>
      </form>
    </div>
  );
}

