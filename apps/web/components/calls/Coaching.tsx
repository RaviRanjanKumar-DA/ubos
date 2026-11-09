'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { dur, RecordingPlayer } from './Player';

interface Note { id: string; body: string; atSec: number | null; createdAt: string; authorName: string; mine: boolean }

/** Coaching comments on one call. A comment can be tied to the moment playing in the recording. */
export function CoachingDialog({ callId, title, canListen, canRemoveAny, onClose }: { callId: string; title: string; canListen: boolean; canRemoveAny: boolean; onClose: () => void }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [body, setBody] = useState('');
  const [atTime, setAtTime] = useState(true);
  const [err, setErr] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const load = useCallback(() => api<Note[]>(`/api/v1/calls/${callId}/comments`).then(setNotes).catch((e) => { setNotes([]); setErr(e instanceof ApiError ? e.message : 'Could not load comments'); }), [callId]);
  useEffect(() => { load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    const atSec = atTime && audio.current ? Math.floor(audio.current.currentTime) : null;
    try { await api(`/api/v1/calls/${callId}/comments`, { method: 'POST', body: { body, atSec } }); setBody(''); load(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); }
  };
  const jump = (sec: number) => {
    if (!audio.current) { setErr('Press Play first, then choose a moment.'); return; }
    setErr(''); audio.current.currentTime = sec; audio.current.play().catch(() => undefined);
  };
  const remove = async (id: string) => {
    try { await api(`/api/v1/calls/comments/${id}/archive`, { method: 'POST' }); load(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-label="Call comments" onClick={(e) => e.stopPropagation()}>
        <h2>Comments on {title}</h2>
        {canListen && <div className="coach-player"><RecordingPlayer callId={callId} onAudio={(el) => { audio.current = el; }} /></div>}
        {err && <div className="error">{err}</div>}
        {!notes ? <div className="muted">Loading…</div> : !notes.length ? <p className="small muted">No comments yet.</p> : (
          <ul className="coach-list">
            {notes.map((n) => (
              <li key={n.id}>
                {n.atSec !== null ? <button type="button" className="chip coach-time" onClick={() => jump(n.atSec!)}>{dur(n.atSec)}</button> : <span className="chip coach-time coach-general">Note</span>}
                <div className="coach-body"><b className="small">{n.authorName}</b><div>{n.body}</div></div>
                {(n.mine || canRemoveAny) && <button type="button" className="link-btn small" onClick={() => remove(n.id)}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add}>
          <div className="field"><label htmlFor="coach-body">Add a comment</label><textarea id="coach-body" className="input" rows={2} maxLength={1000} required value={body} onChange={(e) => setBody(e.target.value)} /></div>
          {canListen && <label className="row small coach-check"><input type="checkbox" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} /> Link to the moment playing in the recording</label>}
          <div className="row modal-actions"><button type="button" className="btn ghost" onClick={onClose}>Close</button><button className="btn" disabled={!body.trim()}>Add comment</button></div>
        </form>
      </div>
    </div>
  );
}
