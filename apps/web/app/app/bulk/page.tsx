'use client';

import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { useState } from 'react';

interface Tool { title: string; text: string; icon: string; href?: string; onClick?: () => void; perm: string; needsLine?: boolean }

/** Every bulk tool in one place; most open the page that does the work. */
export default function BulkTools() {
  const { can, me } = useShell();
  const [err, setErr] = useState('');
  const line = !!me.currentWorkspaceId;
  const usersExport = async () => {
    try { const b = await api<Blob>('/api/v1/users/export', { noWorkspace: true }); const u = URL.createObjectURL(new Blob([b], { type: 'text/csv' })); Object.assign(document.createElement('a'), { href: u, download: 'users.csv' }).click(); URL.revokeObjectURL(u); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  };
  const tools: Tool[] = [
    { title: 'Bulk edit leads', text: 'Select leads on the Leads list, then assign, change stage or status, add remarks, follow-ups or labels.', icon: 'edit', href: '/app/leads', perm: 'crm.lead.update' },
    { title: 'Excel bulk edit', text: 'Download your leads, change stage, status, owner, labels or fields in Excel, and upload back.', icon: 'upload', href: '/app/leads/update', perm: 'crm.lead.import', needsLine: true },
    { title: 'Bulk upload leads', text: 'Add many leads from Excel or CSV with duplicate checks.', icon: 'leads', href: '/app/leads/import', perm: 'crm.lead.import', needsLine: true },
    { title: 'Bulk add actions', text: 'Import past calls and remarks (from another CRM) onto leads.', icon: 'history', href: '/app/leads/update', perm: 'crm.lead.import', needsLine: true },
    { title: 'Bulk upload tasks', text: 'Create many tasks and meetings from a sheet, with a check before saving.', icon: 'calendar', href: '/app/bulk/tasks', perm: 'crm.lead.import' },
    { title: 'Bulk cancel tasks', text: 'Pick open tasks by person or date and cancel them together.', icon: 'close', href: '/app/bulk/tasks', perm: 'crm.lead.view' },
    { title: 'Delete leads', text: 'Select leads on the Leads list and delete them. They are kept and can be restored.', icon: 'trash', href: '/app/leads', perm: 'crm.lead.delete' },
    { title: 'Deleted leads', text: 'See who deleted what and when, and restore leads.', icon: 'refresh', href: '/app/reports/deleted', perm: 'crm.lead.delete' },
    { title: 'Bulk user upload', text: 'Add many users at once with roles and teams.', icon: 'hr', href: '/app/users', perm: 'org.user.manage' },
    { title: 'Users export', text: 'Download every user with role, team, status and last sign-in.', icon: 'download', onClick: usersExport, perm: 'org.user.view' },
  ];
  const shown = tools.filter((t) => can(t.perm));
  return (
    <>
      <div className="page-head"><div><h1>Bulk tools</h1><div className="muted small">Change many records at once. Every bulk change is checked first where it can be, and kept in the audit log.</div></div></div>
      {err && <div className="error">{err}</div>}
      <div className="report-grid">
        {shown.map((t) => {
          const off = t.needsLine && !line;
          const inner = <><span className="report-ic"><Icon name={t.icon} className="ic" /></span><b>{t.title}</b><span className="small muted">{t.text}</span>{off && <span className="small muted">Choose a business line at the top first.</span>}</>;
          if (t.onClick) return <button key={t.title} type="button" className="card report-card" style={{ textAlign: 'left', font: 'inherit', cursor: 'pointer' }} onClick={t.onClick}>{inner}</button>;
          return off ? <div key={t.title} className="card report-card soon">{inner}</div> : <Link key={t.title} href={t.href!} className="card report-card">{inner}</Link>;
        })}
      </div>
      {!shown.length && <div className="card empty">No bulk tools for your role.</div>}
    </>
  );
}
