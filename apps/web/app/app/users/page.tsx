'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import readXlsxFile from 'read-excel-file';
import { parseCsv, toCsv } from '@ubos/shared';
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
interface Licences { plan: string | null; status: string | null; licences: number; used: number; available: number; expiresAt: string | null; trialEndsAt: string | null }
type StatusFilter = '' | 'active' | 'inactive' | 'locked' | 'invited';
const PAGE = 20;
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function UsersPage() {
  const { me, version, can } = useShell();
  const [users, setUsers] = useState<User[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [lic, setLic] = useState<Licences | null>(null);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [twoFa, setTwoFa] = useState<'' | 'on' | 'off'>('');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canManage = me.permissions['org.user.manage'] === 'ORGANIZATION';
  const canExport = me.permissions['org.user.view'] === 'ORGANIZATION';

  const load = useCallback(() => {
    api<User[]>('/api/v1/users').then(setUsers).catch((e) => setError(e.message));
    api<Licences>('/api/v1/users/licences', { noWorkspace: true }).then(setLic).catch(() => setLic(null));
  }, []);

  useEffect(() => {
    load();
    api<Role[]>('/api/v1/roles').then(setRoles).catch(() => {});
    api<{ branches: { name: string; departments: { name: string; teams: { id: string; name: string }[] }[] }[] }>('/api/v1/org/structure')
      .then((s) => setTeams(s.branches.flatMap((b) => b.departments.flatMap((d) => d.teams.map((t) => ({ id: t.id, label: `${t.name} · ${d.name}, ${b.name}` }))))))
      .catch(() => {});
  }, [version, load]);
  useEffect(() => setPage(0), [q, role, workspace, status, twoFa]);

  const shown = useMemo(() => users?.filter((u) => {
    if (q && !`${u.name} ${u.email} ${u.username ?? ''} ${u.mobile ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (role && !u.roles.some((r) => r.roleId === role)) return false;
    if (workspace && !u.roles.some((r) => (workspace === 'all' ? r.workspaceId === null : r.workspaceId === workspace))) return false;
    if (status === 'active' && !(u.isActive && !u.locked)) return false;
    if (status === 'inactive' && u.isActive) return false;
    if (status === 'locked' && !u.locked) return false;
    if (status === 'invited' && !(u.mustChangePassword && u.isActive)) return false;
    if (twoFa && (twoFa === 'on') !== u.totpEnabled) return false;
    return true;
  }) ?? [], [users, q, role, workspace, status, twoFa]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const rows = shown.slice(page * PAGE, page * PAGE + PAGE);
  const filtered = !!(q || role || workspace || status || twoFa);
  const expired = lic?.expiresAt && new Date(lic.expiresAt) < new Date();

  async function exportCsv() {
    try {
      const blob = await api<Blob>('/api/v1/users/export', { noWorkspace: true });
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: 'users.csv' }).click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed'); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>User management</h1>
          <div className="muted small">{users ? `${users.filter((u) => u.isActive).length} active of ${users.length}` : ''} · one person can hold several roles, per workspace or organization-wide</div>
        </div>
        <div className="row">
          {canExport && <button className="btn outline" onClick={exportCsv}>Export</button>}
          {canManage && <button className="btn outline" onClick={() => setBulk(true)}>Bulk add</button>}
          {canManage && <button className="btn" onClick={() => setEditing('new')}>+ Add user</button>}
        </div>
      </div>

      {lic && (
        <div className="card row" style={{ justifyContent: 'space-between', marginBottom: 12, padding: 12, borderColor: expired || lic.available === 0 ? 'var(--warn)' : undefined }}>
          <div className="row" style={{ gap: 18 }}>
            <div><div className="small muted">Plan</div><b>{lic.plan ?? 'No plan'}</b> {lic.status === 'trialing' && <span className="badge warn">Trial</span>}</div>
            <div><div className="small muted">Licences used</div><b>{lic.used}</b> / {lic.licences}</div>
            <div><div className="small muted">Available</div><b style={{ color: lic.available === 0 ? 'var(--bad)' : undefined }}>{lic.available}</b></div>
            <div><div className="small muted">{lic.status === 'trialing' ? 'Trial ends' : 'Valid till'}</div><b style={{ color: expired ? 'var(--bad)' : undefined }}>{fmtDate(lic.status === 'trialing' ? lic.trialEndsAt ?? lic.expiresAt : lic.expiresAt)}</b></div>
          </div>
          {can('org.billing.manage') && <Link className="btn sm" href="/app/billing">Buy licences</Link>}
        </div>
      )}

      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="row" style={{ gap: 8 }}>
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Search name, email, username, mobile" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ width: 'auto' }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
            <option value="">All roles</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select className="input" style={{ width: 'auto' }} value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Workspace">
            <option value="">Any workspace</option>
            <option value="all">Organization-wide</option>
            {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
            <option value="">Any status</option><option value="active">Active</option><option value="invited">Invited (not signed in yet)</option>
            <option value="locked">Locked</option><option value="inactive">Inactive</option>
          </select>
          <select className="input" style={{ width: 'auto' }} value={twoFa} onChange={(e) => setTwoFa(e.target.value as '' | 'on' | 'off')} aria-label="Two-factor">
            <option value="">2FA: any</option><option value="on">2FA on</option><option value="off">2FA off</option>
          </select>
          {filtered && <button className="btn sm ghost" onClick={() => { setQ(''); setRole(''); setWorkspace(''); setStatus(''); setTwoFa(''); }}>Clear</button>}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice} <button className="btn sm ghost" onClick={() => setNotice('')}>Dismiss</button></div>}
      {secret && (
        <div className="notice">
          Temporary password for <b>{secret.name}</b>: <code style={{ fontSize: 14 }}>{secret.password}</code> — share it privately. It is shown only once; they must change it at first sign-in.
          <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => setSecret(null)}>Dismiss</button>
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 900 }}>
            <thead><tr><th>User</th><th>Roles</th><th>Team</th><th>Status</th><th>Licence</th><th>Last active</th>{canManage && <th />}</tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.55 }}>
                  <td>
                    <b>{u.name}</b>
                    <div className="small muted">{u.email}{u.username ? ` · @${u.username}` : ''}{u.mobile ? ` · ${u.mobile}` : ''}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {u.roles.map((r, i) => (
                        <span key={i} className="badge" title={r.validTo ? `until ${new Date(r.validTo).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}` : undefined}>
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
                  <td className="small">{u.isActive ? <>{lic?.plan ?? '—'}<div className="muted">till {fmtDate(lic?.expiresAt ?? null)}</div></> : <span className="muted">Not using a licence</span>}</td>
                  <td className="small muted">{u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Never'}</td>
                  {canManage && <td style={{ textAlign: 'right' }}><button className="btn sm outline" onClick={() => setEditing(u)}>Manage</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {!users && !error && <div className="empty">Loading…</div>}
          {users && !rows.length && <div className="empty">No users match these filters.</div>}
        </div>
        {shown.length > PAGE && (
          <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', borderTop: '1px solid var(--line)' }}>
            <span className="small muted">{page * PAGE + 1}–{Math.min(shown.length, page * PAGE + PAGE)} of {shown.length}</span>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</button>
              <span className="small">Page {page + 1} / {pages}</span>
              <button className="btn sm ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next ›</button>
            </div>
          </div>
        )}
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
      {bulk && <BulkUsers onClose={() => setBulk(false)} onDone={(text) => { setBulk(false); setNotice(text); load(); }} />}
    </>
  );
}

const cellText = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const COLUMNS = ['name', 'email', 'mobile', 'username', 'role', 'workspace'] as const;
type BulkRow = Partial<Record<(typeof COLUMNS)[number], string>>;
interface BulkResult { dryRun: boolean; ok: number; errors: number; results: { row: number; status: 'ok' | 'error'; message?: string; name?: string; email?: string }[] }

/** Bulk add: upload CSV / Excel → check every row → add the valid ones and email invitations. */
function BulkUsers({ onClose, onDone }: { onClose: () => void; onDone: (text: string) => void }) {
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [check, setCheck] = useState<BulkResult | null>(null);
  const [sendInvite, setSendInvite] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function template() {
    const csv = toCsv([['Name', 'Email', 'Mobile', 'Username', 'Role', 'Workspace'], ['Pooja Sharma', 'pooja@example.com', '9876543210', 'pooja', 'RM', 'Course / Software'], ['Amit Verma', 'amit@example.com', '', '', 'Manager', 'All']]);
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'users-template.csv' }).click();
    URL.revokeObjectURL(url);
  }

  async function read(file: File) {
    setError(''); setCheck(null);
    try {
      let data: string[][];
      if (/\.xlsx$/i.test(file.name)) data = (await readXlsxFile(file)).map((r) => r.map(cellText));
      else if (/\.(csv|txt)$/i.test(file.name)) data = parseCsv(await file.text());
      else throw new Error('Please choose a .csv or .xlsx file');
      data = data.filter((r) => r.some((c) => c));
      if (data.length < 2) throw new Error('The file needs a header row and at least one person');
      if (data.length - 1 > 500) throw new Error('Up to 500 users per upload');
      const head = data[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
      const idx = Object.fromEntries(COLUMNS.map((c) => [c, head.findIndex((h) => h === c || (c === 'workspace' && /^(workspace|businessline)$/.test(h)) || (c === 'mobile' && /^(phone|mobileno|mobilenumber)$/.test(h)))]));
      if (idx.name < 0 || idx.email < 0 || idx.role < 0) throw new Error('Columns Name, Email and Role are required (download the template)');
      setRows(data.slice(1).map((r) => Object.fromEntries(COLUMNS.filter((c) => idx[c] >= 0).map((c) => [c, r[idx[c]] ?? '']))));
      setFileName(file.name);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the file'); }
  }

  async function run(dryRun: boolean) {
    if (!rows) return;
    setBusy(true); setError('');
    try {
      const r = await api<BulkResult>('/api/v1/users/bulk', { method: 'POST', noWorkspace: true, body: { dryRun, sendInvite, rows } });
      if (dryRun) setCheck(r);
      else onDone(`${r.ok} user(s) added${r.errors ? ` · ${r.errors} row(s) skipped` : ''}${sendInvite && r.ok ? ' · invitations emailed' : ''}.`);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
    setBusy(false);
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 680, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2>Bulk add users</h2>
        <div className="steps" style={{ marginBottom: 12 }}>
          {['Upload file', 'Check', 'Add'].map((s, i) => { const at = !rows ? 0 : !check ? 1 : 2; return <div key={s} className={`step ${at === i ? 'active' : at > i ? 'done' : ''}`}><span className="num">{at > i ? '✓' : i + 1}</span>{s}</div>; })}
        </div>
        {error && <div className="error">{error}</div>}
        <p className="small muted">Columns: <b>Name, Email, Role</b> (required), Mobile, Username, Workspace (a business line name, or “All”). Each person gets a sign-in invitation; nobody receives a password by email.</p>
        <div className="row" style={{ marginBottom: 10 }}>
          <label className="btn outline">Choose CSV / Excel file<input type="file" accept=".csv,.xlsx,.txt" hidden onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} /></label>
          <button className="btn ghost sm" onClick={template}>Download template</button>
          {fileName && <span className="small">{fileName} · {rows?.length} row(s)</span>}
        </div>
        {check && (
          <>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <span className="badge ok">{check.ok} ready</span>
              {check.errors > 0 && <span className="badge bad">{check.errors} with problems</span>}
            </div>
            <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
              <table className="table">
                <thead><tr><th>Row</th><th>Person</th><th>Result</th></tr></thead>
                <tbody>
                  {check.results.map((r) => (
                    <tr key={r.row}><td>{r.row}</td><td>{r.name}<div className="small muted">{r.email}</div></td>
                      <td>{r.status === 'ok' ? <span className="badge ok">OK</span> : <span className="small" style={{ color: 'var(--bad)' }}>{r.message}</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <label className="row small" style={{ marginTop: 10 }}><input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} /> Email an invitation to each new user</label>
        <div className="row end" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {!check ? <button className="btn" disabled={!rows || busy} onClick={() => run(true)}>{busy ? 'Checking…' : 'Check rows'}</button>
            : <button className="btn" disabled={!check.ok || busy} onClick={() => run(false)}>{busy ? 'Adding…' : `Add ${check.ok} user(s)`}</button>}
        </div>
      </div>
    </div>
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
