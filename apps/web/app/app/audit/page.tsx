'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Log {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  actor: string;
  ip: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
}

const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const words = (s: string) => { const t = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const area = (action: string) => words(action.split('.')[0]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.length ? v.map(show).join(', ') : 'empty';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

/** Turns stored old and new values into plain "Field: old → new" lines. */
function Changes({ oldValue, newValue }: { oldValue: unknown; newValue: unknown }) {
  if (!isObj(oldValue) && !isObj(newValue)) {
    if (oldValue == null && newValue == null) return <span className="muted">No details</span>;
    return <span>{oldValue != null ? `${show(oldValue)} → ` : ''}{show(newValue)}</span>;
  }
  const before = isObj(oldValue) ? oldValue : {};
  const after = isObj(newValue) ? newValue : {};
  const both = isObj(oldValue) && isObj(newValue);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !both || JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (!keys.length) return <span className="muted">No changes</span>;
  const line = (k: string) => (
    <div key={k} className="audit-line">
      <span className="muted">{words(k)}:</span>{' '}
      {both ? <>{show(before[k])} → {show(after[k])}</> : show(k in after ? after[k] : before[k])}
    </div>
  );
  if (keys.length <= 4) return <>{keys.map(line)}</>;
  return (
    <>
      {keys.slice(0, 3).map(line)}
      <details className="audit-more"><summary>{keys.length - 3} more</summary>{keys.slice(3).map(line)}</details>
    </>
  );
}

export default function AuditPage() {
  const { version } = useShell();
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [chain, setChain] = useState<{ valid: boolean; checked: number } | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');
  const [what, setWhat] = useState('');

  useEffect(() => {
    api<Log[]>('/api/v1/audit-logs', { noWorkspace: true }).then(setLogs).catch((e) => setError(e.message));
    api('/api/v1/audit-logs/verify', { noWorkspace: true }).then(setChain as (v: unknown) => void).catch(() => {});
  }, [version]);

  const people = useMemo(() => [...new Set(logs?.map((l) => l.actor))].sort(), [logs]);
  const areas = useMemo(() => [...new Set(logs?.map((l) => area(l.action)))].sort(), [logs]);
  const shown = useMemo(() => logs?.filter((l) =>
    (!who || l.actor === who) && (!what || area(l.action) === what) &&
    (!q || `${l.action} ${l.actor} ${JSON.stringify(l.newValue)} ${JSON.stringify(l.oldValue)}`.toLowerCase().includes(q.toLowerCase()))), [logs, who, what, q]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit Log</h1>
          <div className="muted small">Who did what and when. Entries cannot be edited or deleted.</div>
        </div>
        {chain && (
          <span className={`badge ${chain.valid ? 'ok' : 'bad'}`}>
            <span className="dot" />{chain.valid ? `Integrity verified (${chain.checked} entries)` : 'Integrity check FAILED'}
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card audit-filters">
        <input className="input" placeholder="Search actions, people or values" aria-label="Search the audit log" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" aria-label="Person" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Everyone</option>
          {people.map((p) => <option key={p} value={p}>{p === 'system' ? 'System' : p}</option>)}
        </select>
        <select className="input" aria-label="Area" value={what} onChange={(e) => setWhat(e.target.value)}>
          <option value="">All areas</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {shown?.map((l) => (
                <tr key={l.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{when(l.createdAt)}</td>
                  <td>{l.actor === 'system' ? 'System' : l.actor}</td>
                  <td><span className="badge">{words(l.action)}</span></td>
                  <td className="small audit-detail"><div><Changes oldValue={l.oldValue} newValue={l.newValue} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs && !shown?.length && <div className="empty">{logs.length ? 'No entries match these filters.' : 'No audit entries yet.'}</div>}
        </div>
      </div>
      {logs && logs.length >= 200 && <p className="small muted">Showing the latest 200 entries.</p>}
    </>
  );
}
