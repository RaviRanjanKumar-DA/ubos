'use client';

import { useEffect, useRef, useState } from 'react';
import { BUSINESS_LINES } from '@ubos/shared';

export interface PickedLine { name: string; template?: string }

/** Multi-select dropdown of ready business lines (grouped, searchable) with the option to add a custom one. */
export function BusinessLinePicker({ value, onChange, max }: { value: PickedLine[]; onChange: (v: PickedLine[]) => void; max: number | null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const picked = (name: string) => value.some((v) => v.name.toLowerCase() === name.toLowerCase());
  const full = max !== null && value.length >= max;
  const toggle = (l: PickedLine) => onChange(picked(l.name) ? value.filter((v) => v.name.toLowerCase() !== l.name.toLowerCase()) : full ? value : [...value, l]);
  const matches = BUSINESS_LINES.filter((l) => !q || `${l.name} ${l.group}`.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(matches.map((l) => l.group))];
  const custom = q.trim().length >= 2 && !BUSINESS_LINES.some((l) => l.name.toLowerCase() === q.trim().toLowerCase()) && !picked(q.trim());

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div className="input" role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === 'Enter' && setOpen(!open)}
        style={{ height: 'auto', minHeight: 38, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '6px 34px 6px 8px', cursor: 'pointer', position: 'relative' }}>
        {!value.length && <span className="muted">Choose business lines…</span>}
        {value.map((v) => (
          <span key={v.name} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {v.name}
            <button type="button" aria-label={`Remove ${v.name}`} onClick={(e) => { e.stopPropagation(); toggle(v); }} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}>✕</button>
          </span>
        ))}
        <span aria-hidden="true" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }}>▾</span>
      </div>
      {open && (
        <div className="card" style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 60, padding: 8, maxHeight: 300, overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,.12)' }}>
          <input className="input" autoFocus placeholder="Search or type a new business line" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (custom && !full) { onChange([...value, { name: q.trim() }]); setQ(''); } } }} style={{ marginBottom: 6 }} />
          {full && <div className="small" style={{ color: 'var(--warn)', padding: '4px 6px' }}>This plan allows {max} business line(s).</div>}
          {custom && (
            <button type="button" className="btn sm ghost" style={{ width: '100%', justifyContent: 'flex-start' }} disabled={full} onClick={() => { onChange([...value, { name: q.trim() }]); setQ(''); }}>
              + Add “{q.trim()}” as a custom business line
            </button>
          )}
          {groups.map((g) => (
            <div key={g}>
              <div className="small muted" style={{ fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.04em', fontSize: 11, padding: '8px 6px 2px' }}>{g}</div>
              {matches.filter((l) => l.group === g).map((l) => (
                <label key={l.name} className="row small" style={{ padding: '5px 6px', borderRadius: 6, cursor: 'pointer', flexWrap: 'nowrap' }}>
                  <input type="checkbox" checked={picked(l.name)} disabled={!picked(l.name) && full} onChange={() => toggle({ name: l.name, template: l.template })} /> {l.name}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
