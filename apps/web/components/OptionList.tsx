'use client';

import { useEffect, useState } from 'react';
import type { Option } from '@/lib/workspace';

type Item = Option & { connected?: boolean };

/**
 * Editable, drag-to-reorder list (sources, lost reasons, statuses, call feedback). Removed entries are archived on
 * the server, never deleted, so old records keep their value. Optional "default" and "reached" flags.
 */
export function OptionList({ title, hint, items, readOnly, onSave, withConnected, withDefault, defaultHint }: {
  title: string; hint: string; items: Item[]; readOnly: boolean; withConnected?: boolean; withDefault?: boolean; defaultHint?: string;
  onSave: (options: { id?: string; label: string; connected?: boolean; isDefault?: boolean }[]) => Promise<boolean>;
}) {
  const [list, setList] = useState<Item[]>(items);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  useEffect(() => { setList(items); setDirty(false); }, [items]);
  const change = (next: Item[]) => { setList(next); setDirty(true); };
  const drop = (to: number) => {
    if (drag === null || drag === to) return;
    const next = [...list];
    const [m] = next.splice(drag, 1);
    next.splice(to, 0, m);
    change(next);
    setDrag(null);
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{title} <span className="muted" style={{ fontWeight: 500 }}>({list.length})</span></h2>
      </div>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>{hint}{withDefault && defaultHint ? ` ${defaultHint}` : ''}</p>
      {list.map((o, i) => (
        <div key={o.id ?? `n-${i}`} className="row drag-row" draggable={!readOnly} onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(i)}
          style={{ flexWrap: 'nowrap', marginBottom: 6, background: '#faf9fd', borderRadius: 8, padding: '4px 6px', position: 'relative' }}>
          {!readOnly && <span aria-hidden="true" style={{ color: 'var(--muted)', cursor: 'grab' }}>⠿</span>}
          {readOnly ? <span style={{ flex: 1 }}>{o.label}</span> : (
            <input className="input" style={{ height: 30, flex: 1 }} value={o.label} onChange={(e) => change(list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Name" />
          )}
          {withConnected && (readOnly ? (o.connected && <span className="badge ok">Reached</span>) : (
            <label className="small row" style={{ gap: 4, whiteSpace: 'nowrap' }} title="The customer was actually reached on this call">
              <input type="checkbox" checked={!!o.connected} onChange={(e) => change(list.map((x, j) => (j === i ? { ...x, connected: e.target.checked } : x)))} /> Reached
            </label>
          ))}
          {o.isDefault && <span className="badge">default</span>}
          {!readOnly && (
            <div style={{ position: 'relative' }}>
              <button type="button" className="btn sm ghost" aria-label="More" onClick={() => setMenu(menu === i ? null : i)}>⋮</button>
              {menu === i && (
                <div className="card" style={{ position: 'absolute', right: 0, top: 30, zIndex: 10, padding: 4, minWidth: 150 }} onMouseLeave={() => setMenu(null)}>
                  {withDefault && <button type="button" className="btn sm ghost" style={{ width: '100%' }} onClick={() => { change(list.map((x, j) => ({ ...x, isDefault: j === i ? !x.isDefault : false }))); setMenu(null); }}>{o.isDefault ? 'Remove default' : 'Set as default'}</button>}
                  <button type="button" className="btn sm ghost" style={{ width: '100%', color: 'var(--bad)' }} onClick={() => { change(list.filter((_, j) => j !== i)); setMenu(null); }}>Remove</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {!readOnly && (
        <>
          <form className="row" style={{ flexWrap: 'nowrap', marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { change([...list, { label: draft.trim() }]); setDraft(''); } }}>
            <input className="input" style={{ height: 30 }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add new…" />
            <button className="btn sm outline">⊕ Add</button>
          </form>
          <div className="row end" style={{ marginTop: 10 }}>
            {dirty && <button type="button" className="btn ghost" onClick={() => { setList(items); setDirty(false); }}>Undo</button>}
            <button className="btn" disabled={!dirty} onClick={() => onSave(list.map(({ id, label, connected, isDefault }) => ({
              id, label, ...(withConnected ? { connected: !!connected } : {}), ...(withDefault ? { isDefault: !!isDefault } : {}),
            })))}>Save</button>
          </div>
        </>
      )}
    </div>
  );
}
