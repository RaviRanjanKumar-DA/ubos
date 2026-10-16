'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Assignment { roleId: string; role?: string; workspaceId: string | null; workspace?: string | null; validTo?: string | null }
interface User {
  id: string; name: string; email: string; username: string | null; mobile: string | null; isActive: boolean;
  totpEnabled: boolean; locked: boolean; mustChangePassword: boolean; lastActiveAt: string | null;
  team: { id: string; name: string } | null; reportsTo: { id: string; name: string } | null; roles: Assignment[];
}
interface Role { id: string; name: string }
interface Team { id: string; label: string }

export default function UsersPage() {
  const { me, version } = useShell();
  const [users, setUsers] = useState<User[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
  const [error, setError] = useState('');
  const canManage = me.permissions['org.user.manage'] === 'ORGANIZATION';

  const load = useCallback(() => {
    api<User[]>('/api/v1/users').then(setUsers).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    api<Role[]>('/api/v1/roles').then(setRoles).catch(() => {});
    api<{ branches: { name: string; departments: { name: string; teams: { id: string; name: string }[] }[] }[] }>('/api/v1/org/structure')
      .then((s) => setTeams(s.branches.flatMap((b) => b.departments.flatMap((d) => d.teams.map((t) => ({ id: t.id, label: `${t.name} · ${d.name}, ${b.name}` }))))))
      .catch(() => {});
  }, [version, load]);

  const shown = users?.filter((u) => !q || `${u.name} ${u.email} ${u.username ?? ''} ${u.mobile ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="muted small">{users ? `${users.filter((u) => u.isActive).length} active` : ''} · one person can hold several roles, per workspace or organization-wide</div>
        </div>
        <div className="row">
          <input className="input" style={{ width: 220 }} placeholder="Search name, email, mobile" value={q} onChange={(e) => setQ(e.target.value)} />
          {canManage && <button className="btn" onClick={() => setEditing('new')}>+ Add user</button>}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {secret && (
        <div className="notice">
          Temporary password for <b>{secret.name}</b>: <code style={{ fontSize: 14 }}>{secret.password}</code> — share it privately. It is shown only once; they must change it at first sign-in.
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => setSecret(null)}>Dismiss</button>
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>User</th><th>Roles</th><th>Team</th><th>Status</th><th>Last active</th>{canManage && <th />}</tr></thead>
            <tbody>
              {shown?.map((u) => (
                <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.55 }}>
                  <td>
                    <b>{u.name}</b>
                    <div className="small muted">{u.email}{u.username ? ` · @${u.username}` : ''}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {u.roles.map((r, i) => (
                        <span key={i} className="badge" title={r.validTo ? `until ${new Date(r.validTo).toLocaleDateString('en-IN')}` : undefined}>
                          {r.role} · {r.workspace ?? 'All workspaces'}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="small">{u.team?.name ?? <span className="muted">—</span>}{u.reportsTo && <div className="muted">reports to {u.reportsTo.name}</div>}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {!u.isActive ? <span className="badge grey">Inactive</span> : u.locked ? <span className="badge bad">Locked</span> : <span className="badge ok">Active</span>}
                      {u.totpEnabled && <span className="badge grey">2FA</span>}
                      {u.mustChangePassword && u.isActive && <span className="badge warn">Invited</span>}
                    </div>
                  </td>
                  <td className="small muted">{u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString('en-IN') : 'Never'}</td>
                  {canManage && <td style={{ textAlign: 'right' }}><button className="btn sm outline" onClick={() => setEditing(u)}>Manage</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {!users && !error && <div className="empty">Loading…</div>}
        </div>
      </div>
      {editing && (
        <UserForm
          user={editing === 'new' ? null : editing}
          roles={roles}
          teams={teams}
          users={users ?? []}
          workspaces={me.workspaces}
          isSelf={editing !== 'new' && editing.id === me.user.id}
          onClose={() => setEditing(null)}
          onSaved={(s) => { setEditing(null); if (s) setSecret(s); load(); }}
        />
      )}
    </>
  );
}

function UserForm(props: {
  user: User | null; roles: Role[]; teams: Team[]; users: User[]; workspaces: { id: string; name: string }[]; isSelf: boolean;
  onClose: () => void; onSaved: (secret?: { name: string; password: string }) => void;
}) {
  const { user } = props;
  const [f, setF] = useState({
    name: user?.name ?? '', email: user?.email ?? '', username: user?.username ?? '', mobile: user?.mobile ?? '',
    teamId: user?.team?.id ?? '', reportsToId: user?.reportsTo?.id ?? '', sendInvite: true,
  });
  const [assign, setAssign] = useState<Assignment[]>(user?.roles.map((r) => ({ roleId: r.roleId, workspaceId: r.workspaceId })) ?? [{ roleId: props.roles.find((r) => r.name === 'RM')?.id ?? '', workspaceId: props.workspaces[0]?.id ?? null }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); setBusy(false); }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const profile = { name: f.name, username: f.username || null, mobile: f.mobile || null, teamId: f.teamId || null, reportsToId: f.reportsToId || null };
      const roles = assign.filter((a) => a.roleId);
      if (!user) {
        const r = await api<{ temporaryPassword: string }>('/api/v1/users', { method: 'POST', noWorkspace: true, body: { ...profile, email: f.email, roles, sendInvite: f.sendInvite } });
        props.onSaved({ name: f.name, password: r.temporaryPassword });
      } else {
        await api(`/api/v1/users/${user.id}`, { method: 'PATCH', noWorkspace: true, body: profile });
        await api(`/api/v1/users/${user.id}/roles`, { method: 'PUT', noWorkspace: true, body: { roles } });
        props.onSaved();
      }
    });
  };

  return (
    <div className="modal-bg" onClick={props.onClose}>
      <form className="modal" style={{ maxWidth: 600, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{user ? `Manage ${user.name}` : 'Add user'}</h2>
        {error && <div className="error">{error}</div>}
        <div className="grid cols-2">
          <div className="field"><label>Full name</label><input className="input" value={f.name} onChange={set('name')} required /></div>
          <div className="field"><label>Email</label><input className="input" type="email" value={f.email} onChange={set('email')} required disabled={!!user} /></div>
          <div className="field"><label>Username (optional)</label><input className="input" value={f.username} onChange={set('username')} placeholder="e.g. pooja" /></div>
          <div className="field"><label>Mobile (optional)</label><input className="input" value={f.mobile} onChange={set('mobile')} placeholder="98765 43210" /></div>
          <div className="field">
            <label>Team</label>
            <select className="input" value={f.teamId} onChange={set('teamId')}>
              <option value="">— none —</option>
              {props.teams.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Reports to</label>
            <select className="input" value={f.reportsToId} onChange={set('reportsToId')}>
              <option value="">— none —</option>
              {props.users.filter((u) => u.id !== user?.id && u.isActive).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>

        <h2 style={{ fontSize: 14, marginTop: 4 }}>Roles</h2>
        {assign.map((a, i) => (
          <div key={i} className="row" style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
            <select className="input" value={a.roleId} onChange={(e) => setAssign(assign.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)))}>
              <option value="">Choose role…</option>
              {props.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <span className="muted small">in</span>
            <select className="input" value={a.workspaceId ?? ''} onChange={(e) => setAssign(assign.map((x, j) => (j === i ? { ...x, workspaceId: e.target.value || null } : x)))}>
              <option value="">All workspaces</option>
              {props.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <button type="button" className="btn sm ghost" aria-label="Remove role" onClick={() => setAssign(assign.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="btn sm outline" onClick={() => setAssign([...assign, { roleId: '', workspaceId: null }])}>+ Add another role</button>

        {!user && (
          <label className="row small" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={f.sendInvite} onChange={(e) => setF({ ...f, sendInvite: e.target.checked })} /> Email an invitation
          </label>
        )}

        {user && !props.isSelf && (
          <div className="row" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
            <button type="button" className="btn sm outline" disabled={busy}
              onClick={() => run(async () => {
                const r = await api<{ temporaryPassword: string }>(`/api/v1/users/${user.id}/reset-password`, { method: 'POST', noWorkspace: true });
                props.onSaved({ name: user.name, password: r.temporaryPassword });
              })}>Reset password</button>
            {user.locked && (
              <button type="button" className="btn sm outline" disabled={busy}
                onClick={() => run(async () => { await api(`/api/v1/users/${user.id}/unlock`, { method: 'POST', noWorkspace: true }); props.onSaved(); })}>Unlock</button>
            )}
            <button type="button" className={`btn sm ${user.isActive ? 'danger' : 'outline'}`} disabled={busy}
              onClick={() => run(async () => {
                if (user.isActive && !confirm(`Deactivate ${user.name}? They will be signed out everywhere.`)) return setBusy(false);
                await api(`/api/v1/users/${user.id}`, { method: 'PATCH', noWorkspace: true, body: { isActive: !user.isActive } });
                props.onSaved();
              })}>{user.isActive ? 'Deactivate' : 'Reactivate'}</button>
          </div>
        )}

        <div className="row end" style={{ marginTop: 14 }}>
          <button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : user ? 'Save changes' : 'Add user'}</button>
        </div>
      </form>
    </div>
  );
}
