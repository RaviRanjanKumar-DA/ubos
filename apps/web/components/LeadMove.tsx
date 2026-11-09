'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from './AppShell';
import { Icon } from './Icon';

/** Moves a lead to another business line, with a reason. */
export function LeadMove({ leadId, workspace }: { leadId: string; workspace: string }) {
  const { can } = useShell();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) api<{ id: string; name: string }[]>(`/api/v1/leads/${leadId}/transfer-options`, { workspace }).then(setList).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed'));
  }, [open, leadId, workspace]);
  if (!can('crm.lead.transfer')) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api(`/api/v1/leads/${leadId}/transfer`, { method: 'POST', body: { workspaceId: to, reason }, workspace });
      window.location.href = '/app/leads';
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed'); setBusy(false); }
  }
  return (
    <>
      <div className="row end lead-move"><button className="btn sm ghost" onClick={() => setOpen(true)}><Icon name="share" className="ic" />Move to another business line</button></div>
      {open && (
        <div className="modal-bg">
          <form className="modal" onSubmit={submit}>
            <h2>Move this lead</h2>
            <p className="small muted">The stage, status and owner change to those of the new business line. Calls and history stay with the lead.</p>
            {error && <div className="error">{error}</div>}
            <div className="field"><label htmlFor="mv-to">Business line</label><select id="mv-to" className="input" required value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{list.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
            <div className="field"><label htmlFor="mv-why">Reason</label><textarea id="mv-why" className="input" rows={2} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Go back</button><button className="btn" disabled={busy}>{busy ? 'Moving…' : 'Move lead'}</button></div>
          </form>
        </div>
      )}
    </>
  );
}

/** The score badge; click to see where the points came from. */
export function ScoreBadge({ leadId, workspace, score }: { leadId: string; workspace: string; score: number }) {
  const [info, setInfo] = useState<{ score: number; rules: { name: string; points: number }[]; other: number } | null>(null);
  const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));
  return (
    <>
      <button type="button" className={`badge score-btn ${score >= 30 ? 'ok' : 'grey'}`} title="See how this score was reached" onClick={() => api<NonNullable<typeof info>>(`/api/v1/leads/${leadId}/score`, { workspace }).then(setInfo).catch(() => undefined)}>Score {score}</button>
      {info && (
        <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setInfo(null); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Lead score">
            <h2>Score {info.score}</h2>
            {info.rules.map((r) => <div key={r.name} className="score-row"><span>{r.name}</span><b>{fmt(r.points)}</b></div>)}
            {info.other !== 0 && <div className="score-row"><span>Custom actions</span><b>{fmt(info.other)}</b></div>}
            {!info.rules.length && info.other === 0 && <p className="small muted">No points yet.</p>}
            <div className="row end" style={{ marginTop: 14 }}><button className="btn ghost" onClick={() => setInfo(null)}>Close</button></div>
          </div>
        </div>
      )}
    </>
  );
}
