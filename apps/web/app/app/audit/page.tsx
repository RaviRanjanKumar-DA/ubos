'use client';

import { useEffect, useState } from 'react';
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

const fmt = (v: unknown) => (v === null || v === undefined ? '—' : JSON.stringify(v));

export default function AuditPage() {
  const { version } = useShell();
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [chain, setChain] = useState<{ valid: boolean; checked: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Log[]>('/api/v1/audit-logs', { noWorkspace: true }).then(setLogs).catch((e) => setError(e.message));
    api('/api/v1/audit-logs/verify', { noWorkspace: true }).then(setChain).catch(() => {});
  }, [version]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit Log</h1>
          <div className="muted small">Who did what, when — with old and new values. Rows cannot be edited or deleted.</div>
        </div>
        {chain && (
          <span className={`badge ${chain.valid ? 'ok' : 'bad'}`}>
            <span className="dot" />{chain.valid ? `Integrity verified (${chain.checked} entries)` : 'Integrity check FAILED'}
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Old value</th><th>New value</th></tr></thead>
            <tbody>
              {logs?.map((l) => (
                <tr key={l.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{new Date(l.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                  <td>{l.actor}</td>
                  <td><span className="badge">{l.action}</span></td>
                  <td className="small muted" style={{ maxWidth: 220, overflowWrap: 'anywhere' }}>{fmt(l.oldValue)}</td>
                  <td className="small" style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{fmt(l.newValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs && !logs.length && <div className="empty">No audit entries yet.</div>}
        </div>
      </div>
    </>
  );
}
