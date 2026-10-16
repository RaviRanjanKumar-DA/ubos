'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';
import { Icon } from './Icon';

export interface Me {
  user: { id: string; name: string; email: string };
  tenant: { name: string; slug: string; status: string; plan?: string; trialEndsAt?: string | null };
  roles: { role: string; workspaceId: string | null }[];
  workspaces: { id: string; name: string; slug: string }[];
  currentWorkspaceId: string | null;
  permissions: Record<string, string>;
  features: string[];
  security: { totpEnabled: boolean; mustChangePassword: boolean; mfaSetupRequired: boolean };
}

interface ShellCtx {
  me: Me;
  can: (perm: string) => boolean;
  /** Changes whenever the workspace switches, so pages can refetch. */
  version: number;
}
const Ctx = createContext<ShellCtx | null>(null);
export const useShell = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useShell outside AppShell');
  return c;
};

// Live modules link to pages; the rest are shown as "coming in Phase N" so the roadmap is visible.
const NAV = [
  { section: 'Work' },
  { href: '/app/dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
  { href: '/app/leads', label: 'Leads', icon: 'leads', perm: 'crm.lead.view' },
  { label: 'Calls', icon: 'calls', phase: 2 },
  { label: 'WhatsApp Inbox', icon: 'chat', phase: 2 },
  { section: 'Business' },
  { label: 'HR & People', icon: 'hr', phase: 3 },
  { label: 'Finance', icon: 'finance', phase: 3 },
  { label: 'AI Suite', icon: 'ai', phase: 4 },
  { section: 'Organization' },
  { href: '/app/workspaces', label: 'Workspaces', icon: 'workspaces', perm: 'org.workspace.view' },
  { href: '/app/users', label: 'Users', icon: 'hr', perm: 'org.user.view' },
  { href: '/app/roles', label: 'Roles & Permissions', icon: 'audit', perm: 'org.user.view' },
  { href: '/app/org', label: 'Org Structure', icon: 'tenants', perm: 'org.user.view' },
  { href: '/app/integrations', label: 'Integrations', icon: 'integrations', perm: 'integrations.view' },
  { href: '/app/audit', label: 'Audit Log', icon: 'audit', perm: 'audit.view' },
  { href: '/app/settings/security', label: 'Security Policy', icon: 'lock', perm: 'org.security.manage' },
  { section: 'Account' },
  { href: '/app/security', label: 'My Security', icon: 'lock', perm: null },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    if (!session.get()) return router.replace('/login');
    try {
      const m = await api<Me>('/api/v1/auth/me');
      // Users whose roles are all workspace-limited have no organization view: open their first workspace.
      if (!m.currentWorkspaceId && !m.roles.some((r) => r.workspaceId === null) && m.workspaces.length) {
        session.setWorkspace(m.workspaces[0].id);
        return load();
      }
      setMe(m);
      // Organization policy: a new password or 2FA setup comes before any other screen.
      if ((m.security.mustChangePassword || m.security.mfaSetupRequired) && !window.location.pathname.startsWith('/app/security')) {
        router.replace(`/app/security?reason=${m.security.mustChangePassword ? 'password' : 'mfa'}`);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.code === 'TENANT_SUSPENDED' || e.code === 'IP_NOT_ALLOWED')) {
        session.set(null);
        return router.replace('/login');
      }
      if (e instanceof ApiError && e.code === 'WORKSPACE_FORBIDDEN') {
        session.setWorkspace(null);
        return load();
      }
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function switchWorkspace(id: string) {
    session.setWorkspace(id || null);
    await load();
    setVersion((v) => v + 1);
  }

  async function logout() {
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    session.set(null);
    router.replace('/login');
  }

  if (error) return <div className="content"><div className="error">{error}</div></div>;
  if (!me) return <div className="content muted">Loading…</div>;

  const can = (perm: string) => !!me.permissions[perm];
  const hasOrgRole = me.roles.some((r) => r.workspaceId === null);

  return (
    <Ctx.Provider value={{ me, can, version }}>
      <div className="shell">
        <aside className={`sidebar ${open ? 'open' : ''}`}>
          <div className="brand"><span className="logo">U</span> UBOS</div>
          {NAV.map((item, i) => {
            if ('section' in item) return <div key={i} className="nav-section">{item.section}</div>;
            if ('phase' in item) {
              return (
                <div key={i} className="nav-item locked" title={`Coming in Phase ${item.phase}`}>
                  <Icon name={item.icon} /> {item.label}
                  <span className="badge grey" style={{ marginLeft: 'auto', fontSize: 10.5 }}>P{item.phase}</span>
                </div>
              );
            }
            if (item.perm && !can(item.perm)) return null;
            return (
              <Link key={i} href={item.href} className={`nav-item ${pathname.startsWith(item.href) ? 'active' : ''}`} onClick={() => setOpen(false)}>
                <Icon name={item.icon} /> {item.label}
              </Link>
            );
          })}
        </aside>
        <div className="main">
          <header className="topbar">
            <button className="btn ghost sm menu-btn" onClick={() => setOpen(!open)} aria-label="Menu"><Icon name="menu" /></button>
            <div className="ws-switch">
              <span className="small muted hide-sm">Workspace</span>
              <select value={me.currentWorkspaceId ?? ''} onChange={(e) => switchWorkspace(e.target.value)} aria-label="Switch workspace">
                {hasOrgRole && <option value="">All business lines</option>}
                {!hasOrgRole && !me.currentWorkspaceId && <option value="">Select a workspace…</option>}
                {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <div className="spacer" />
            <span className="small muted hide-sm">{me.tenant.name} · {me.tenant.plan}</span>
            <div className="avatar" title={`${me.user.name} (${me.roles.map((r) => r.role).join(', ')})`}>
              {me.user.name.slice(0, 1).toUpperCase()}
            </div>
            <button className="btn ghost sm" onClick={logout} title="Sign out"><Icon name="logout" /></button>
          </header>
          <div className="content">{children}</div>
        </div>
      </div>
    </Ctx.Provider>
  );
}
