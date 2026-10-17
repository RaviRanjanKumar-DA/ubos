'use client';

import type { WorkspaceSettings } from '@/lib/workspace';

/** Asks why a lead was lost (workspace lost reasons). */
export function LostDialog({ ws, name, onClose, onPick }: { ws: WorkspaceSettings; name: string; onClose: () => void; onPick: (reason: string) => void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onPick(new FormData(e.currentTarget).get('reason') as string); }}>
        <h2>Why was {name} lost?</h2>
        <div className="field">
          <select name="reason" className="input" required defaultValue="">
            <option value="" disabled>Choose a reason…</option>
            {ws.lostReasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn danger">Mark as lost</button>
        </div>
      </form>
    </div>
  );
}
