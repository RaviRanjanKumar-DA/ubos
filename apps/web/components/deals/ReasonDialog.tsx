'use client';

import { useState } from 'react';

/** Small dialog that asks for a reason before an action that is recorded in the audit log. */
export function ReasonDialog({ title, hint, confirm, onClose, onSubmit }: { title: string; hint?: string; confirm: string; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(reason.trim()); }}>
        <h2>{title}</h2>
        {hint && <p className="small muted" style={{ marginTop: -6 }}>{hint}</p>}
        <div className="field"><label htmlFor="reason">Reason</label>
          <textarea id="reason" className="input" style={{ height: 80, paddingTop: 8 }} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} autoFocus />
        </div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={reason.trim().length < 3}>{confirm}</button>
        </div>
      </form>
    </div>
  );
}
