'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Grant { key: string; scope: string; isDeny?: boolean }
interface Role { id: string; name: string; isProtected: boolean; userCount: number; grants: Grant[] }
interface Catalogue { scopes: string[]; groups: { label: string; permissions: { key: string; description: string }[] }[] }

const SCOPE_LABEL: Record<string, string> = {
  OWN: 'Own records', TEAM: 'Team', DEPARTMENT: 'Department', BRANCH: 'Branch', WORKSPACE: 'Workspace', ORGANIZATION: 'Whole organization',
};

export default function RolesPage() {
  const { me, version } = useShell();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [grants, setGrants] = useState<Record<string, string>>({}); // key → scope | 'DENY' | ''
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const canManage = me.permissions['org.role.manage'] === 'ORGANIZATION';

  const load = (pick?: string) =>
    api<Role[]>('/api/v1/roles', { noWorkspace: true }).then((r) => {
      setRoles(r);
      const target = r.find((x) => x.id === (pick ?? selected)) ?? r[0];
      if (target) open(target);
    });

  useEffect(() => {
    api<Catalogue>('/api/v1/permissions', { noWorkspace: true }).then(setCat).catch((e) => setMsg({ type: 'error', text: e.message }));
    load().catch((e) => setMsg({ type: 'error', text: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  function open(r: Role | 'new') {
    setMsg(null);
    if (r === 'new') {
      setSelected('new');
      setName('');
      setGrants({});
      return;
    }
    setSelected(r.id);
    setName(r.name);
    setGrants(Object.fromEntries(r.grants.map((g) => [g.key, g.isDeny ? 'DENY' : g.scope])));
  }

  const current = roles?.find((r) => r.id === selected);
  const readOnly = !canManage || !!current?.isProtected;

  async function act(fn: () => Promise<unknown>, text: string, pick?: string) {
    setMsg(null);
    try {
      const r = (await fn()) as { id?: string } | undefined;
      await load(pick ?? r?.id);
      setMsg({ type: 'notice', text });
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
    }
  }

  const body = () => ({
    name,
    grants: Object.entries(grants)
      .filter(([, v]) => v)
      .map(([key, v]) => (v === 'DENY' ? { key, scope: 'ORGANIZATION', isDeny: true } : { key, scope: v })),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Roles & Permissions</h1>
          <div className="muted small">Create any role you need. A person can hold several roles; the widest access wins and "Deny" always overrides.</div>
        </div>
        {canManage && <button className="btn" onClick={() => open('new')}>+ New role</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) 1fr', gap: 14, alignItems: 'start' }} className="roles-grid">
        <div className="card" style={{ padding: 6 }}>
          {roles?.map((r) => (
            <button key={r.id} onClick={() => open(r)} className={`nav-item ${selected === r.id ? 'active' : ''}`}
              style={{ width: '100%', border: 0, background: selected === r.id ? undefined : 'transparent', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
              <span style={{ flex: 1 }}>{r.name}</span>
              <span className="badge grey">{r.userCount}</span>
            </button>
          ))}
          {selected === 'new' && <div className="nav-item active">New role</div>}
        </div>

        {(current || selected === 'new') && cat && (
          <form className="card" onSubmit={(e) => {
            e.preventDefault();
            act(() => selected === 'new'
              ? api('/api/v1/roles', { method: 'POST', body: body(), noWorkspace: true })
              : api(`/api/v1/roles/${selected}`, { method: 'PUT', body: body(), noWorkspace: true }), 'Role saved.');
          }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <input className="input" style={{ maxWidth: 320, fontWeight: 600 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Role name, e.g. Content Creator" required disabled={readOnly} />
              {current?.isProtected && <span className="badge">Built-in · full access · cannot be changed</span>}
            </div>
            {cat.groups.map((g) => (
              <div key={g.label} style={{ marginBottom: 14 }}>
                <div className="small" style={{ fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', marginBottom: 6 }}>{g.label}</div>
                {g.permissions.map((p) => (
                  <div key={p.key} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)', flexWrap: 'nowrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div>{p.description}</div>
                      <div className="small muted"><code>{p.key}</code></div>
                    </div>
                    <select className="input" style={{ width: 190, flex: 'none' }} value={grants[p.key] ?? ''} disabled={readOnly}
                      onChange={(e) => setGrants({ ...grants, [p.key]: e.target.value })}>
                      <option value="">No access</option>
                      {cat.scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s] ?? s}</option>)}
                      <option value="DENY">Deny (overrides other roles)</option>
                    </select>
                  </div>
                ))}
              </div>
            ))}
            {!readOnly && (
              <div className="row end">
                {current && (
                  <>
                    <button type="button" className="btn ghost" onClick={() => {
                      const n = prompt('Name for the copy', `${current.name} (copy)`);
                      if (n) act(() => api(`/api/v1/roles/${current.id}/clone`, { method: 'POST', body: { name: n }, noWorkspace: true }), 'Role copied.');
                    }}>Duplicate</button>
                    <button type="button" className="btn danger" onClick={() => {
                      if (confirm(`Delete role "${current.name}"?`)) act(() => api(`/api/v1/roles/${current.id}`, { method: 'DELETE', noWorkspace: true }), 'Role deleted.', '');
                    }}>Delete</button>
                  </>
                )}
                <button className="btn">Save role</button>
              </div>
            )}
            {current?.isProtected && canManage && (
              <div className="row end"><button type="button" className="btn outline" onClick={() => {
                const n = prompt('Name for the copy', 'Admin (custom)');
                if (n) act(() => api(`/api/v1/roles/${current.id}/clone`, { method: 'POST', body: { name: n }, noWorkspace: true }), 'Role copied — you can edit the copy.');
              }}>Duplicate to customise</button></div>
            )}
          </form>
        )}
      </div>
      <style>{`@media (max-width: 860px) { .roles-grid { grid-template-columns: 1fr !important; } }`}</style>
    </>
  );
}
