'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Grant { key: string; scope: string; isDeny?: boolean }
interface Role { id: string; name: string; isProtected: boolean; userCount: number; grants: Grant[] }
interface Catalogue { scopes: string[]; groups: { label: string; permissions: { key: string; description: string }[] }[] }

/** Access levels from narrowest to widest, then Deny. '' = no access. */
const LEVELS: { value: string; short: string; long: string }[] = [
  { value: '', short: 'None', long: 'No access' },
  { value: 'OWN', short: 'Own', long: 'Only records they own' },
  { value: 'TEAM', short: 'Team', long: 'Records of their team' },
  { value: 'DEPARTMENT', short: 'Dept', long: 'Records of their department' },
  { value: 'BRANCH', short: 'Branch', long: 'Records of their branch' },
  { value: 'WORKSPACE', short: 'Business line', long: 'Everything in the business lines they work in' },
  { value: 'ORGANIZATION', short: 'All', long: 'Whole organization' },
  { value: 'DENY', short: 'Deny', long: 'Blocked, even if another role allows it' },
];
const LEVEL = Object.fromEntries(LEVELS.map((l) => [l.value, l]));

const toMap = (r: Role) => Object.fromEntries(r.grants.map((g) => [g.key, g.isDeny ? 'DENY' : g.scope])) as Record<string, string>;
function summary(grants: Record<string, string>) {
  const vals = Object.values(grants).filter(Boolean);
  const allowed = vals.filter((v) => v !== 'DENY').length;
  const denied = vals.length - allowed;
  return `${allowed} allowed${denied ? ` · ${denied} denied` : ''}`;
}

export default function RolesPage() {
  const { me, version } = useShell();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [grants, setGrants] = useState<Record<string, string>>({}); // key → scope | 'DENY' | ''
  const [saved, setSaved] = useState<{ name: string; grants: Record<string, string> }>({ name: '', grants: {} });
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
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
      setSelected('new'); setName(''); setGrants({}); setSaved({ name: '', grants: {} });
      return;
    }
    const m = toMap(r);
    setSelected(r.id); setName(r.name); setGrants(m); setSaved({ name: r.name, grants: m });
  }

  const current = roles?.find((r) => r.id === selected);
  const readOnly = !canManage || !!current?.isProtected;
  const clean = (m: Record<string, string>) => JSON.stringify(Object.entries(m).filter(([, v]) => v).sort());
  const dirty = name !== saved.name || clean(grants) !== clean(saved.grants);
  const switchTo = (r: Role | 'new') => { if (!dirty || confirm('Discard unsaved changes to this role?')) open(r); };

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
    grants: Object.entries(grants).filter(([, v]) => v).map(([key, v]) => (v === 'DENY' ? { key, scope: 'ORGANIZATION', isDeny: true } : { key, scope: v })),
  });
  const levels = useMemo(() => LEVELS.filter((l) => l.value === '' || l.value === 'DENY' || cat?.scopes.includes(l.value)), [cat]);
  const groups = useMemo(() => cat?.groups.map((g) => ({
    ...g, permissions: g.permissions.filter((p) => !q || `${p.description} ${p.key} ${g.label}`.toLowerCase().includes(q.toLowerCase())),
  })).filter((g) => g.permissions.length) ?? [], [cat, q]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Roles &amp; Permissions</h1>
          <div className="muted small">A role is a set of permissions. A person can hold several roles — the widest access wins, and <b>Deny</b> always wins.</div>
        </div>
        {canManage && <button className="btn" onClick={() => switchTo('new')}>+ New role</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div className="roles-grid">
        <div className="card" style={{ padding: 6 }}>
          <div className="small muted" style={{ padding: '6px 8px', fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 11 }}>Roles</div>
          {roles?.map((r) => (
            <button key={r.id} onClick={() => switchTo(r)} className={`role-item ${selected === r.id ? 'on' : ''}`}>
              <span style={{ minWidth: 0 }}>
                <b>{r.name}</b>{r.isProtected && <span className="badge" style={{ marginLeft: 6 }}>Built-in</span>}
                <span className="small muted" style={{ display: 'block' }}>{r.isProtected ? 'Full access' : summary(toMap(r))}</span>
              </span>
              <span className="badge grey" title="People with this role">{r.userCount} 👤</span>
            </button>
          ))}
          {selected === 'new' && <div className="role-item on"><b>New role</b></div>}
        </div>

        {(current || selected === 'new') && cat && (
          <form onSubmit={(e) => {
            e.preventDefault();
            act(() => selected === 'new'
              ? api('/api/v1/roles', { method: 'POST', body: body(), noWorkspace: true })
              : api(`/api/v1/roles/${selected}`, { method: 'PUT', body: body(), noWorkspace: true }), 'Role saved.');
          }}>
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="field" style={{ margin: 0, flex: 1, minWidth: 220, maxWidth: 380 }}>
                  <label>Role name</label>
                  <input className="input" style={{ fontWeight: 600 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Content Creator" required disabled={readOnly} />
                </div>
                <div className="row">
                  {current && <span className="small muted">{current.userCount} {current.userCount === 1 ? 'person has' : 'people have'} this role · {summary(grants)}</span>}
                  {current && canManage && (
                    <button type="button" className="btn sm outline" onClick={() => {
                      const n = prompt('Name for the copy', `${current.name} (copy)`);
                      if (n) act(() => api(`/api/v1/roles/${current.id}/clone`, { method: 'POST', body: { name: n }, noWorkspace: true }), current.isProtected ? 'Role copied — you can edit the copy.' : 'Role copied.');
                    }}>{current.isProtected ? 'Duplicate to customise' : 'Duplicate'}</button>
                  )}
                  {current && !readOnly && (
                    <button type="button" className="btn sm danger" onClick={() => {
                      if (confirm(`Delete role "${current.name}"?`)) act(() => api(`/api/v1/roles/${current.id}`, { method: 'DELETE', noWorkspace: true }), 'Role deleted.', '');
                    }}>Delete</button>
                  )}
                </div>
              </div>
              {current?.isProtected && <div className="notice small" style={{ marginTop: 10, marginBottom: 0 }}>The Organization Admin role always has full access and cannot be changed. Duplicate it to make a custom admin role.</div>}
              <div className="level-legend">
                {levels.map((l) => <span key={l.value || 'none'}><i className={`lvl lvl-${l.value || 'NONE'}`} />{l.short}<span className="muted"> — {l.long}</span></span>)}
              </div>
            </div>

            <div className="row" style={{ marginBottom: 10 }}>
              <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Search permissions, e.g. export, leads, billing" value={q} onChange={(e) => setQ(e.target.value)} />
              <button type="button" className="btn sm ghost" onClick={() => setClosed(closed.size ? new Set() : new Set(cat.groups.map((g) => g.label)))}>{closed.size ? 'Expand all' : 'Collapse all'}</button>
            </div>

            {groups.map((g) => {
              const isClosed = closed.has(g.label) && !q;
              const allowed = g.permissions.filter((p) => grants[p.key] && grants[p.key] !== 'DENY').length;
              return (
                <div key={g.label} className="card perm-section">
                  <div className="perm-head">
                    <button type="button" className="perm-toggle" onClick={() => { const n = new Set(closed); if (n.has(g.label)) n.delete(g.label); else n.add(g.label); setClosed(n); }} aria-expanded={!isClosed}>
                      <span aria-hidden="true">{isClosed ? '▸' : '▾'}</span> <b>{g.label}</b>
                      <span className={`badge ${allowed ? 'ok' : 'grey'}`} style={{ marginLeft: 8 }}>{allowed} of {g.permissions.length} allowed</span>
                    </button>
                    {!readOnly && (
                      <select className="input" style={{ width: 'auto', height: 30 }} value="" aria-label={`Set all ${g.label} permissions`}
                        onChange={(e) => { if (e.target.value === '_') return; const v = e.target.value === '__none' ? '' : e.target.value; setGrants({ ...grants, ...Object.fromEntries(g.permissions.map((p) => [p.key, v])) }); }}>
                        <option value="_">Set whole section…</option>
                        {levels.map((l) => <option key={l.value || 'none'} value={l.value || '__none'}>{l.long}</option>)}
                      </select>
                    )}
                  </div>
                  {!isClosed && g.permissions.map((p) => {
                    const v = grants[p.key] ?? '';
                    return (
                      <div key={p.key} className="perm-row">
                        <div style={{ minWidth: 0 }} title={p.key}>
                          <div>{p.description}</div>
                          <div className="small muted">{LEVEL[v]?.long ?? v}</div>
                        </div>
                        <div className="seg" role="radiogroup" aria-label={p.description}>
                          {levels.map((l) => (
                            <button type="button" key={l.value || 'none'} role="radio" aria-checked={v === l.value} title={l.long} disabled={readOnly}
                              className={`seg-btn ${v === l.value ? `on lvl-${l.value || 'NONE'}` : ''}`} onClick={() => setGrants({ ...grants, [p.key]: l.value })}>{l.short}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {!groups.length && <div className="empty">No permission matches “{q}”.</div>}

            {!readOnly && (dirty || selected === 'new') && (
              <div className="save-bar">
                <span><b>Unsaved changes</b> to {name || 'this role'}</span>
                <span style={{ flex: 1 }} />
                {selected !== 'new' && <button type="button" className="btn ghost" onClick={() => { setName(saved.name); setGrants(saved.grants); }}>Discard</button>}
                <button className="btn">{selected === 'new' ? 'Create role' : 'Save role'}</button>
              </div>
            )}
          </form>
        )}
      </div>
    </>
  );
}
