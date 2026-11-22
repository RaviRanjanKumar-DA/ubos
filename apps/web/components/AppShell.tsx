'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';
import { Icon } from './Icon';
import { Bell } from './Bell';
import { Search, PageLink } from './Search';

export interface Me {
  user: { id: string; name: string; email: string };
  tenant: { name: string; slug: string; status: string; plan?: string; trialEndsAt?: string | null; billing?: { phase: string; endsAt: string; graceEndsAt: string; daysLeft: number } | null };
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
  switchWorkspace: (id: string) => Promise<void>;
}
const Ctx = createContext<ShellCtx | null>(null);
export const useShell = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useShell outside AppShell');
  return c;
};

type NavLink = { href: string; label: string; icon: string; perm: string };
type NavSoon = { label: string; icon: string; phase: number };
type NavGroup = { id: string; title?: string; startClosed?: boolean; items: (NavLink | NavSoon)[] };

// Groups follow how people work. Modules not built yet sit under "Coming soon" so the roadmap stays visible.
const NAV: NavGroup[] = [
  { id: 'work', items: [
    { href: '/app/dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
    { href: '/app/reports', label: 'Reports', icon: 'trend', perm: 'dashboard.view' },
    { href: '/app/bulk', label: 'Bulk tools', icon: 'upload', perm: 'crm.lead.view' },
    { href: '/app/leads', label: 'Leads', icon: 'funnel', perm: 'crm.lead.view' },
    { href: '/app/customers', label: 'Customers', icon: 'hr', perm: 'crm.customer.view' },
    { href: '/app/calendar', label: 'Calendar & Tasks', icon: 'calendar', perm: 'crm.lead.view' },
    { href: '/app/booking', label: 'Booking links', icon: 'clock', perm: 'crm.booking.manage' },
  ] },
  { id: 'comm', title: 'Communication', items: [
    { href: '/app/calls', label: 'Calls', icon: 'calls', perm: 'crm.lead.view' },
    { href: '/app/campaigns', label: 'Call campaigns', icon: 'checklist', perm: 'crm.lead.update' },
    { href: '/app/inbox', label: 'Inbox', icon: 'forum', perm: 'crm.whatsapp.chat' },
    { href: '/app/chatbot', label: 'Chatbot & web chat', icon: 'ai', perm: 'crm.chatbot.manage' },
    { href: '/app/outreach', label: 'SMS & Email', icon: 'mail', perm: 'crm.message.send' },
    { href: '/app/lead-rules', label: 'Lead rules', icon: 'funnel', perm: 'crm.routing.manage' },
  ] },
  { id: 'support', title: 'Help desk', items: [
    { href: '/app/tickets', label: 'Tickets', icon: 'chat', perm: 'support.ticket.view' },
    { href: '/app/knowledge', label: 'Knowledge base', icon: 'form', perm: 'support.ticket.view' },
  ] },
  { id: 'sales', title: 'Sales', items: [
    { href: '/app/products', label: 'Products & prices', icon: 'tag', perm: 'crm.lead.view' },
    { href: '/app/gallery', label: 'Gallery', icon: 'share', perm: 'crm.lead.view' },
    { href: '/app/access', label: 'Access & renewals', icon: 'unlock', perm: 'crm.access.view' },
    { href: '/app/processes', label: 'Processes', icon: 'tree', perm: 'crm.lead.view' },
    { href: '/app/approvals', label: 'Approvals', icon: 'check', perm: 'crm.lead.view' },
    { href: '/app/goals', label: 'Goals', icon: 'flag', perm: 'dashboard.view' },
  ] },
  { id: 'finance', title: 'Finance', items: [
    { href: '/app/invoices', label: 'Invoices', icon: 'receipt', perm: 'finance.invoice.view' },
    { href: '/app/collections', label: 'Collections', icon: 'finance', perm: 'finance.invoice.view' },
    { href: '/app/expenses', label: 'Expenses', icon: 'list', perm: 'finance.expense.manage' },
    { href: '/app/pnl', label: 'Profit & loss', icon: 'trend', perm: 'finance.pnl.view' },
  ] },
  { id: 'people', title: 'People', items: [
    { href: '/app/me/attendance', label: 'My attendance', icon: 'clock', perm: 'feature:module.hrms' },
    { href: '/app/hr', label: 'Employees', icon: 'hr', perm: 'hr.employee.view' },
    { href: '/app/hr/attendance', label: 'Attendance', icon: 'calendar', perm: 'hr.attendance.view' },
    { href: '/app/hr/leave', label: 'Leave', icon: 'checklist', perm: 'hr.leave.approve' },
    { href: '/app/hr/assets', label: 'Assets', icon: 'tag', perm: 'hr.asset.manage' },
  ] },
  { id: 'automations', title: 'Automations', items: [
    { href: '/app/automation/flows', label: 'Workflows', icon: 'tree', perm: 'crm.automation.manage' },
    { href: '/app/automation', label: 'Rules & sequences', icon: 'bolt', perm: 'crm.automation.manage' },
    { href: '/app/automation/schedules', label: 'Schedules', icon: 'calendar', perm: 'dashboard.view' },
    { href: '/app/forms', label: 'Salesform', icon: 'form', perm: 'crm.lead.view' },
    { href: '/app/automation/api-templates', label: 'API templates', icon: 'code', perm: 'crm.automation.manage' },
    { href: '/app/developer', label: 'Webhooks & API', icon: 'share', perm: 'integrations.developer' },
    { href: '/app/integrations', label: 'Apps', icon: 'integrations', perm: 'integrations.view' },
  ] },
  { id: 'org', title: 'Organization', startClosed: true, items: [
    { href: '/app/setup', label: 'Setup Guide', icon: 'checklist', perm: 'org.workspace.manage' },
    { href: '/app/workspaces', label: 'Workspaces', icon: 'workspaces', perm: 'org.workspace.view' },
    { href: '/app/users', label: 'Users', icon: 'leads', perm: 'org.user.view' },
    { href: '/app/roles', label: 'Roles & Permissions', icon: 'audit', perm: 'org.user.view' },
    { href: '/app/org', label: 'Org Structure', icon: 'tenants', perm: 'org.user.view' },
    { href: '/app/connected', label: 'Connected accounts', icon: 'share', perm: 'crm.message.send' },
    { href: '/app/audit', label: 'Audit Log', icon: 'history', perm: 'audit.view' },
    { href: '/app/settings/security', label: 'Security Policy', icon: 'lock', perm: 'org.security.manage' },
    { href: '/app/billing', label: 'Billing & Licences', icon: 'receipt', perm: 'org.billing.manage' },
  ] },
  { id: 'soon', title: 'Coming soon', startClosed: true, items: [
    { label: 'AI Suite', icon: 'ai', phase: 4 },
  ] },
];
const isLink = (i: NavLink | NavSoon): i is NavLink => 'href' in i;

const NAV_KEY = 'ubos.nav';
function readNav(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(NAV_KEY) ?? '{}'); } catch { return {}; }
}

/** Gives each list cell its column name, so wide tables can show as cards on a phone. Tables with typing boxes (edit grids) stay as tables. */
function stampTables(root: HTMLElement) {
  root.querySelectorAll<HTMLTableElement>('table.table:not(.compact):not(.lb-table)').forEach((t) => {
    const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent?.trim() ?? '');
    if (!heads.length || t.querySelector('tbody input.input')) { t.removeAttribute('data-cards'); return; }
    t.setAttribute('data-cards', '');
    t.querySelectorAll('tbody tr').forEach((row) => {
      let col = 0;
      for (const cell of Array.from(row.children) as HTMLTableCellElement[]) {
        const label = heads[col] ?? '';
        if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label);
        col += cell.colSpan || 1;
      }
    });
  });
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [searching, setSearching] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [navOpen, setNavOpen] = useState<Record<string, boolean>>({});
  const contentRef = useRef<HTMLDivElement>(null);

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
      } else if (m.tenant.status === 'expired' && m.permissions['org.billing.manage'] && !window.location.pathname.startsWith('/app/billing')) {
        // A paused account only opens Billing.
        router.replace('/app/billing');
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

  useEffect(() => { setNavOpen(readNav()); }, []);

  // Ctrl+K (Cmd+K on a Mac) opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearching(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hasMe = !!me;
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    let frame = 0;
    const run = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => stampTables(root)); };
    run();
    const watcher = new MutationObserver(run);
    watcher.observe(root, { childList: true, subtree: true });
    return () => { watcher.disconnect(); cancelAnimationFrame(frame); };
  }, [hasMe]);

  function toggleGroup(id: string, isOpen: boolean) {
    const next = { ...navOpen, [id]: !isOpen };
    setNavOpen(next);
    try { localStorage.setItem(NAV_KEY, JSON.stringify(next)); } catch { /* only a convenience */ }
  }

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

  const can = (perm: string) => (perm.startsWith('feature:') ? me.features.includes(perm.slice(8)) : !!me.permissions[perm]);
  const hasOrgRole = me.roles.some((r) => r.workspaceId === null);

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !isLink(i) || can(i.perm)) })).filter((g) => g.items.length);
  // The closest matching link is the active one, so /app/hr/assets does not also light up /app/hr.
  const activeHref = groups.flatMap((g) => g.items).filter(isLink).map((i) => i.href).filter((h) => pathname === h || pathname.startsWith(`${h}/`)).sort((x, y) => y.length - x.length)[0];
  const pages: PageLink[] = groups.flatMap((g) => g.items.filter(isLink));
  pages.push({ href: '/app/security', label: 'My Security', icon: 'lock' });

  return (
    <Ctx.Provider value={{ me, can, version, switchWorkspace }}>
      <div className="shell">
        <aside className={`sidebar ${open ? 'open' : ''}`}>
          <div className="brand"><span className="logo">U</span> UBOS</div>
          {groups.map((g) => {
            const hasActive = g.items.some((i) => isLink(i) && i.href === activeHref);
            const isOpen = !g.title || hasActive || (navOpen[g.id] ?? !g.startClosed);
            return (
              <div key={g.id}>
                {g.title && (
                  <button className={`nav-section ${isOpen ? '' : 'closed'}`} aria-expanded={isOpen} onClick={() => toggleGroup(g.id, isOpen)}>
                    {g.title} <Icon name="chevron" />
                  </button>
                )}
                {isOpen && g.items.map((item) => (isLink(item) ? (
                  <Link key={item.href} href={item.href} className={`nav-item ${item.href === activeHref ? 'active' : ''}`} onClick={() => setOpen(false)}>
                    <Icon name={item.icon} /> {item.label}
                  </Link>
                ) : (
                  <div key={item.label} className="nav-item locked">
                    <Icon name={item.icon} /> {item.label}
                    <span className="nav-soon">Phase {item.phase}</span>
                  </div>
                )))}
              </div>
            );
          })}
        </aside>
        <div className="drawer-shade" onClick={() => setOpen(false)} />
        <div className="main">
          <header className="topbar">
            <button className="btn ghost sm menu-btn" onClick={() => setOpen(!open)} aria-label="Menu"><Icon name="menu" /></button>
            <div className="ws-switch">
              <select value={me.currentWorkspaceId ?? ''} onChange={(e) => switchWorkspace(e.target.value)} aria-label="Switch workspace">
                {hasOrgRole && <option value="">All business lines</option>}
                {!hasOrgRole && !me.currentWorkspaceId && <option value="">Select a workspace…</option>}
                {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <button className="search-btn" onClick={() => setSearching(true)} aria-label="Search">
              <Icon name="search" /><span>Search leads, customers or pages</span><kbd>Ctrl K</kbd>
            </button>
            <div className="spacer" />
            {can('crm.lead.view') && <Bell version={version} />}
            <div className="user-wrap">
              <button className="avatar" aria-label="Account menu" aria-expanded={userOpen} onClick={() => setUserOpen(!userOpen)}>
                {me.user.name.slice(0, 1).toUpperCase()}
              </button>
              {userOpen && (
                <>
                  <div className="pop-shade" onClick={() => setUserOpen(false)} />
                  <div className="user-menu">
                    <div className="user-who">
                      <b>{me.user.name}</b>
                      <div className="small muted">{me.user.email}</div>
                      <div className="small muted">{me.tenant.name}{me.tenant.plan ? ` · ${me.tenant.plan}` : ''}</div>
                    </div>
                    <Link href="/app/security" className="user-link" onClick={() => setUserOpen(false)}><Icon name="lock" /> My Security</Link>
                    <button className="user-link" onClick={logout}><Icon name="logout" /> Sign out</button>
                  </div>
                </>
              )}
            </div>
          </header>
          <div className="content" ref={contentRef}>
            <BillingBanner me={me} canPay={can('org.billing.manage')} />
            {me.tenant.status === 'expired' && !can('org.billing.manage') ? <div className="card empty">Your organization&apos;s UBOS subscription has ended. Ask your admin to renew it; nothing has been deleted.</div> : children}
          </div>
        </div>
      </div>
      {searching && <Search pages={pages} canLeads={can('crm.lead.view')} canCustomers={can('crm.customer.view')} onClose={() => setSearching(false)} />}
    </Ctx.Provider>
  );
}

/** Trial ending soon, grace days or a paused account: a strip above every page, with a link to Billing for admins. */
function BillingBanner({ me, canPay }: { me: Me; canPay: boolean }) {
  const b = me.tenant.billing;
  if (!b || (b.phase === 'trial' && b.daysLeft > 7) || b.phase === 'active') return null;
  const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
  const text = b.phase === 'trial' ? (b.daysLeft === 0 ? 'Your free trial ends today.' : `Your free trial ends in ${days(b.daysLeft)}.`)
    : b.phase === 'grace' ? `Your subscription has ended. Everything keeps working for ${days(b.daysLeft)} more, then the account pauses.`
    : 'Your account is paused. Renew to open everything again; nothing has been deleted.';
  return (
    <div className={`billing-banner ${b.phase}`}>
      <span>{text}</span>
      {canPay ? <Link href="/app/billing" className="btn sm">{b.phase === 'trial' ? 'Choose licences' : 'Renew now'}</Link> : <span className="small">Ask your admin to renew.</span>}
    </div>
  );
}
