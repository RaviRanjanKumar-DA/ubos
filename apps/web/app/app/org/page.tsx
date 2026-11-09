'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm, askText } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';
import { Menu } from '@/components/Menu';

interface TeamT { id: string; name: string; workspaceId: string | null; members: number }
interface Dept { id: string; name: string; teams: TeamT[] }
interface Branch { id: string; name: string; departments: Dept[] }

export default function OrgPage() {
  const { me, version } = useShell();
  const [data, setData] = useState<{ branches: Branch[]; unassignedUsers: number } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const canEdit = me.permissions['org.structure.manage'] === 'ORGANIZATION';
  const wsName = (id: string | null) => me.workspaces.find((w) => w.id === id)?.name;

  const load = () => api('/api/v1/org/structure', { noWorkspace: true }).then(setData as (v: unknown) => void).catch((e) => setMsg({ type: 'error', text: e.message }));
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
  const call = (path: string, method: string, body?: unknown) => api(path, { method, body, noWorkspace: true });

  const add = async (label: string, path: string, extra: object) => { const name = await askText(label); if (name) act(() => call(path, 'POST', { name, ...extra })); };
  const items = (kind: string, path: string, name: string) => [
    { label: 'Rename', icon: 'edit', onClick: async () => { const n = await askText(`Rename ${kind}`, name); if (n && n !== name) act(() => call(path, 'PATCH', { name: n })); } },
    { label: 'Delete', icon: 'trash', onClick: async () => { if (await askConfirm(`Delete ${name}?`)) act(() => call(path, 'DELETE')); } },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Org Structure</h1>
          <div className="muted small">
            Branches, departments and teams. Used for team, department and branch access and for reporting.
            {data?.unassignedUsers ? ` ${data.unassignedUsers} active user(s) are not in any team yet.` : ''}
          </div>
        </div>
        {canEdit && <button className="btn" onClick={() => add('Branch name, e.g. Head Office', '/api/v1/org/branches', {})}><Icon name="plus" className="ic" />Branch</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {data && !data.branches.length && <div className="card empty">No branches yet. Start with your head office.</div>}

      <div className="org-grid">
        {data?.branches.map((b) => (
          <section key={b.id} className="card org-branch">
            <div className="org-head">
              <h2><Icon name="tenants" className="ic" />{b.name}</h2>
              {canEdit && (
                <div className="org-tools">
                  <button className="btn sm outline" onClick={() => add('Department name, e.g. Sales', '/api/v1/org/departments', { branchId: b.id })}><Icon name="plus" className="ic" />Department</button>
                  <Menu sm items={items('branch', `/api/v1/org/branches/${b.id}`, b.name)} />
                </div>
              )}
            </div>
            {!b.departments.length && <p className="small muted" style={{ margin: 0 }}>No departments yet.</p>}
            {b.departments.map((d) => (
              <div key={d.id} className="org-dept">
                <div className="org-head">
                  <b>{d.name}</b>
                  {canEdit && (
                    <div className="org-tools">
                      <button className="btn sm ghost" onClick={() => add('Team name, e.g. Vastu Team', '/api/v1/org/teams', { departmentId: d.id, workspaceId: null })}><Icon name="plus" className="ic" />Team</button>
                      <Menu sm items={items('department', `/api/v1/org/departments/${d.id}`, d.name)} />
                    </div>
                  )}
                </div>
                {d.teams.map((t) => (
                  <div key={t.id} className="org-team">
                    <span className="org-team-name"><Icon name="leads" className="ic" />{t.name} <span className="badge grey">{t.members} {t.members === 1 ? 'member' : 'members'}</span></span>
                    <div className="org-tools">
                      {canEdit ? (
                        <select className="input org-ws" value={t.workspaceId ?? ''} aria-label={`Business line of ${t.name}`}
                          onChange={(e) => act(() => call(`/api/v1/org/teams/${t.id}`, 'PATCH', { workspaceId: e.target.value || null }))}>
                          <option value="">All business lines</option>
                          {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                      ) : (
                        t.workspaceId && <span className="badge">{wsName(t.workspaceId)}</span>
                      )}
                      {canEdit && <Menu sm items={items('team', `/api/v1/org/teams/${t.id}`, t.name)} />}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
