'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { WorkspaceSettings } from '@/lib/workspace';

/** Who receives new leads of a workspace: round-robin pool, one person or the creator; sticky RM. */
export function AssignmentEditor({ ws, readOnly, act }: { ws: WorkspaceSettings; readOnly: boolean; act: (fn: () => Promise<unknown>, text: string) => Promise<boolean> }) {
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [mode, setMode] = useState(ws.assignment.mode);
  const [userIds, setUserIds] = useState<string[]>(ws.assignment.userIds);
  const [sticky, setSticky] = useState(ws.assignment.sticky);
  useEffect(() => { api<{ id: string; name: string }[]>(`/api/v1/workspaces/${ws.id}/assignees`).then(setPeople).catch(() => {}); }, [ws.id]);
  const toggle = (id: string) => setUserIds(mode === 'fixed' ? [id] : userIds.includes(id) ? userIds.filter((x) => x !== id) : [...userIds, id]);

  return (
    <div className="card" style={{ maxWidth: 680 }}>
      <h2>Who gets new leads?</h2>
      <p className="small muted" style={{ marginTop: -4 }}>Applies to leads from bulk uploads (when "use assignment rules" is chosen), website forms and integrations. Leads you add by hand stay with you.</p>
      {([
        ['round_robin', 'Round-robin', 'New leads are shared one by one between the selected people. Select nobody to include everyone in this business line.'],
        ['fixed', 'One person', 'Every new lead goes to one person (e.g. a team leader who distributes them).'],
        ['creator', 'Whoever creates or uploads the lead', ''],
      ] as ['round_robin' | 'fixed' | 'creator', string, string][]).map(([k, l, h]) => (
        <label key={k} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', marginBottom: 8 }}>
          <input type="radio" name="mode" disabled={readOnly} checked={mode === k} onChange={() => { setMode(k); if (k === 'fixed') setUserIds(userIds.slice(0, 1)); }} style={{ marginTop: 3 }} />
          <span><b>{l}</b>{h && <span className="small muted" style={{ display: 'block' }}>{h}</span>}</span>
        </label>
      ))}
      {mode !== 'creator' && (
        <div className="chips" style={{ margin: '4px 0 14px 22px' }}>
          {people.map((p) => <button type="button" key={p.id} disabled={readOnly} className={`chip ${userIds.includes(p.id) ? 'on' : ''}`} onClick={() => toggle(p.id)}>{p.name}</button>)}
        </div>
      )}
      <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', marginBottom: 12 }}>
        <input type="checkbox" disabled={readOnly} checked={sticky} onChange={(e) => setSticky(e.target.checked)} style={{ marginTop: 3 }} />
        <span><b>Sticky RM</b><span className="small muted" style={{ display: 'block' }}>A returning customer goes back to their own Relationship Manager, if that person works in this business line.</span></span>
      </label>
      {!readOnly && (
        <div className="row end">
          <button className="btn" disabled={mode === 'fixed' && !userIds.length}
            onClick={() => act(() => api(`/api/v1/workspaces/${ws.id}/assignment`, { method: 'PUT', body: { mode, userIds, sticky } }), 'Assignment rules saved.')}>Save rules</button>
        </div>
      )}
    </div>
  );
}
