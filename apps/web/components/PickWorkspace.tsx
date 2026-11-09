'use client';

import { useShell } from './AppShell';
import { Icon } from './Icon';

/** Shown instead of a dead end when a page needs one business line and "All business lines" is selected. */
export function PickWorkspace({ text }: { text: string }) {
  const { me, switchWorkspace } = useShell();
  return (
    <div className="card pick-ws">
      <h2>Choose a business line</h2>
      <p className="muted small">{text}</p>
      <div className="pick-ws-list">
        {me.workspaces.map((w) => (
          <button key={w.id} type="button" className="pick-ws-item" onClick={() => switchWorkspace(w.id)}>
            <Icon name="workspaces" className="ic" /><span>{w.name}</span>
          </button>
        ))}
      </div>
      {!me.workspaces.length && <p className="small muted" style={{ margin: 0 }}>No business line is available to you yet.</p>}
    </div>
  );
}
