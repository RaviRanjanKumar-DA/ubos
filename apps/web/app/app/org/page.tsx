'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface TeamT { id: string; name: string; workspaceId: string | null; members: number }
interface Dept { id: string; name: string; teams: TeamT[] }
interface Branch { id: string; name: string; departments: Dept[] }

export default function OrgPage() {
  const { me, version } = useShell();
  const [data, setData] = useState<{ branches: Branch[]; unassignedUsers: number } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const canEdit = me.permissions['org.structure.manage'] === 'ORGANIZATION';
  const wsName = (id: string | null) => me.workspaces.find((w) => w.id === id)?.name;

  const load = () => api('/api/v1/org/structure', { noWorkspace: true }).then(setData).catch((e) => setMsg({ type: 'error', text: e.message }));
  useEffect(() => { load(); }, [version]);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
    }
  }
  const ask = (label: string, value = '') => prompt(label, value)?.trim();
  const call = (path: string, method: string, body?: unknown) => api(path, { method, body, noWorkspace: true });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Org Structure</h1>
          <div className="muted small">
            Branches → Departments → Teams. Used for Team / Department / Branch access scopes and reporting.
            {data?.unassignedUsers ? ` ${data.unassignedUsers} active user(s) are not in any team yet.` : ''}
          </div>
        </div>
        {canEdit && <button className="btn" onClick={() => { const n = ask('Branch name, e.g. Head Office'); if (n) act(() => call('/api/v1/org/branches', 'POST', { name: n })); }}>+ Branch</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {data && !data.branches.length && <div className="card empty">No branches yet. Start with your head office.</div>}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        {data?.branches.map((b) => (
          <div key={b.id} className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>🏢 {b.name}</h2>
              {canEdit && (
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn sm ghost" onClick={() => { const n = ask('Department name, e.g. Sales'); if (n) act(() => call('/api/v1/org/departments', 'POST', { name: n, branchId: b.id })); }}>+ Department</button>
                  <button className="btn sm ghost" onClick={() => { const n = ask('Rename branch', b.name); if (n) act(() => call(`/api/v1/org/branches/${b.id}`, 'PATCH', { name: n })); }}>Rename</button>
                  <button className="btn sm ghost" onClick={() => confirm(`Delete ${b.name}?`) && act(() => call(`/api/v1/org/branches/${b.id}`, 'DELETE'))}>Delete</button>
                </div>
              )}
            </div>
            {!b.departments.length && <p className="small muted">No departments.</p>}
            {b.departments.map((d) => (
              <div key={d.id} style={{ marginTop: 12, paddingLeft: 12, borderLeft: '3px solid var(--brand-100)' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>{d.name}</b>
                  {canEdit && (
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn sm ghost" onClick={() => { const n = ask('Team name, e.g. Vastu Team'); if (n) act(() => call('/api/v1/org/teams', 'POST', { name: n, departmentId: d.id, workspaceId: null })); }}>+ Team</button>
                      <button className="btn sm ghost" onClick={() => { const n = ask('Rename department', d.name); if (n) act(() => call(`/api/v1/org/departments/${d.id}`, 'PATCH', { name: n })); }}>Rename</button>
                      <button className="btn sm ghost" onClick={() => confirm(`Delete ${d.name}?`) && act(() => call(`/api/v1/org/departments/${d.id}`, 'DELETE'))}>Delete</button>
                    </div>
                  )}
                </div>
                {d.teams.map((t) => (
                  <div key={t.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                    <span>👥 {t.name} <span className="badge grey" style={{ marginLeft: 4 }}>{t.members} members</span></span>
                    <div className="row" style={{ gap: 4 }}>
                      {canEdit ? (
                        <select className="input" style={{ height: 28, width: 190 }} value={t.workspaceId ?? ''} aria-label="Workspace of this team"
                          onChange={(e) => act(() => call(`/api/v1/org/teams/${t.id}`, 'PATCH', { workspaceId: e.target.value || null }))}>
                          <option value="">No specific workspace</option>
                          {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                      ) : (
                        t.workspaceId && <span className="badge">{wsName(t.workspaceId)}</span>
                      )}
                      {canEdit && <button className="btn sm ghost" onClick={() => { const n = ask('Rename team', t.name); if (n) act(() => call(`/api/v1/org/teams/${t.id}`, 'PATCH', { name: n })); }}>Rename</button>}
                      {canEdit && <button className="btn sm ghost" onClick={() => confirm(`Delete ${t.name}?`) && act(() => call(`/api/v1/org/teams/${t.id}`, 'DELETE'))}>Delete</button>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
