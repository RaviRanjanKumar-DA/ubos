'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fromIstInput, toIstInput } from '@/lib/ist';

export interface TaskRow {
  id: string; type: 'task' | 'meeting' | 'call'; title: string; notes: string | null; dueAt: string; durationMin: number | null; location: string | null;
  leadId: string | null; leadName: string | null; assigneeId: string; assignee: string | null; createdBy: string | null; doneAt: string | null; overdue: boolean;
}
type Person = { id: string; name: string };

/** Create or edit a task / meeting / planned call, optionally on a lead, with @mentions. */
export function TaskDialog({ task, leadId, leadName, people, canAssign, meId, defaultDate, onClose, onSaved }: {
  task?: TaskRow | null; leadId?: string; leadName?: string; people: Person[]; canAssign: boolean; meId: string; defaultDate?: Date;
  onClose: () => void; onSaved: () => void;
}) {
  const start = defaultDate ?? fromIstInput(`${toIstInput(new Date(Date.now() + 3_600_000)).slice(0, 14)}00`);
  const [f, setF] = useState({
    type: task?.type ?? 'task', title: task?.title ?? '', notes: task?.notes ?? '', dueAt: toIstInput(task ? new Date(task.dueAt) : start),
    durationMin: String(task?.durationMin ?? 30), location: task?.location ?? '', assigneeId: task?.assigneeId ?? meId,
  });
  const [mentions, setMentions] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const body = {
      type: f.type, title: f.title, notes: f.notes || null, dueAt: fromIstInput(f.dueAt).toISOString(),
      durationMin: f.type === 'task' ? null : Number(f.durationMin) || null, location: f.location || null, assigneeId: f.assigneeId,
      ...(task ? {} : { leadId: leadId ?? null, mentionIds: mentions }),
    };
    try {
      await api(task ? `/api/v1/tasks/${task.id}` : '/api/v1/tasks', { method: task ? 'PATCH' : 'POST', body });
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed'); setBusy(false); }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 560, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{task ? 'Edit' : 'New'} {f.type === 'meeting' ? 'meeting' : f.type === 'call' ? 'planned call' : 'task'}{leadName ? ` · ${leadName}` : ''}</h2>
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ gap: 0, border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', width: 'fit-content', marginBottom: 12 }}>
          {(['task', 'meeting', 'call'] as const).map((t) => (
            <button type="button" key={t} className={`btn sm ${f.type === t ? '' : 'ghost'}`} style={{ borderRadius: 0 }} onClick={() => setF({ ...f, type: t })}>
              {t === 'task' ? '✔ Task' : t === 'meeting' ? '👥 Meeting' : '📞 Call'}
            </button>
          ))}
        </div>
        <div className="field"><label>Title</label><input className="input" value={f.title} onChange={set('title')} required minLength={2} autoFocus placeholder={f.type === 'meeting' ? 'e.g. Site visit with family' : 'e.g. Send the brochure'} /></div>
        <div className="grid cols-2">
          <div className="field"><label>When</label><input className="input" type="datetime-local" value={f.dueAt} onChange={set('dueAt')} required /></div>
          {f.type !== 'task' && (
            <div className="field">
              <label>Duration</label>
              <select className="input" value={f.durationMin} onChange={set('durationMin')}>
                {[15, 30, 45, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
              </select>
            </div>
          )}
          {f.type === 'meeting' && <div className="field" style={{ gridColumn: '1 / -1' }}><label>Place or meeting link</label><input className="input" value={f.location} onChange={set('location')} placeholder="Address, Google Meet or Zoom link" /></div>}
          <div className="field">
            <label>Assigned to</label>
            {canAssign && people.length ? (
              <select className="input" value={f.assigneeId} onChange={set('assigneeId')}>
                {!people.some((p) => p.id === meId) && <option value={meId}>Me</option>}
                {people.map((p) => <option key={p.id} value={p.id}>{p.id === meId ? 'Me' : p.name}</option>)}
              </select>
            ) : <input className="input" value="Me" disabled />}
          </div>
        </div>
        <div className="field"><label>Notes</label><textarea className="input" style={{ height: 70, paddingTop: 8 }} value={f.notes} onChange={set('notes')} /></div>
        {!task && people.length > 0 && (
          <div className="field">
            <label>Mention people (they get a notification)</label>
            <div className="chips">
              {people.filter((p) => p.id !== meId).map((p) => (
                <button type="button" key={p.id} className={`chip ${mentions.includes(p.id) ? 'on' : ''}`} onClick={() => setMentions(mentions.includes(p.id) ? mentions.filter((x) => x !== p.id) : [...mentions, p.id])}>@{p.name}</button>
              ))}
            </div>
          </div>
        )}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
