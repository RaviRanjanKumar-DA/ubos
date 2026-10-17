'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Customer {
  id: string; code: string; name: string; mobile: string | null; email: string | null; city: string | null;
  workspaces: string[]; leadCount: number; lastActivityAt: string; primaryRm: string | null;
}

export default function CustomersPage() {
  const { me, version } = useShell();
  const [list, setList] = useState<Customer[] | null>(null);
  const [dupCount, setDupCount] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const canMerge = me.permissions['crm.customer.merge'] === 'ORGANIZATION';

  const load = useCallback(() => {
    api<Customer[]>(`/api/v1/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setList).catch((e) => setError(e.message));
  }, [q]);

  useEffect(() => {
    load();
    if (canMerge) api<unknown[]>('/api/v1/customers/duplicates', { noWorkspace: true }).then((d) => setDupCount(d.length)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <div className="muted small">One record per person across every business line — matched by mobile, alternate mobile, email or PAN.</div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); load(); }}>
          <input className="input" style={{ width: 260 }} placeholder="Search name, mobile, email or C-number" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>
      {!!dupCount && (
        <div className="notice row" style={{ justifyContent: 'space-between' }}>
          <span>{dupCount} possible duplicate customer{dupCount > 1 ? 's' : ''} found.</span>
          <Link className="btn sm" href="/app/customers/duplicates">Review duplicates</Link>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 720 }}>
            <thead><tr><th>Customer</th><th>Mobile</th><th>Business lines</th><th>Leads</th><th>Primary RM</th><th>Last activity</th></tr></thead>
            <tbody>
              {list?.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/app/customers/${c.id}`}><b>{c.name}</b></Link>
                    <div className="small muted">{c.code}{c.email ? ` · ${c.email}` : ''}{c.city ? ` · ${c.city}` : ''}</div>
                  </td>
                  <td>{c.mobile}</td>
                  <td><div className="row" style={{ gap: 4 }}>{c.workspaces.map((w) => <span key={w} className="badge">{w}</span>)}{!c.workspaces.length && <span className="muted small">—</span>}</div></td>
                  <td>{c.leadCount}</td>
                  <td className="small">{c.primaryRm ?? <span className="muted">—</span>}</td>
                  <td className="small muted">{new Date(c.lastActivityAt).toLocaleDateString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list && !list.length && <div className="empty">No customers found.</div>}
          {!list && !error && <div className="empty">Loading…</div>}
        </div>
      </div>
    </>
  );
}
