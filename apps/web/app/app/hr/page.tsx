'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { istDay } from '@/lib/ist';
import { EmployeeForm } from '@/components/hr/EmployeeForm';
import { blankDraft, draftBody, hrDate, STATUS, type Emp, type Meta } from '@/components/hr/hr';

interface Upcoming { events: { kind: string; employeeId: string; name: string; date: string; daysAway: number; years?: number }[]; documents: { id: string; employeeId: string; name: string; docType: string; daysAway: number }[] }
const when = (n: number) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? `${-n} days ago` : `in ${n} days`);
const TABS: [string, string][] = [['', 'All'], ['onboarding', 'Joining'], ['active', 'Working'], ['notice', 'On notice'], ['exited', 'Left']];

export default function EmployeesPage() {
  const { version } = useShell();
  const router = useRouter();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [data, setData] = useState<{ rows: Emp[]; counts: Record<string, number> } | null>(null);
  const [up, setUp] = useState<Upcoming | null>(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [lists, setLists] = useState<{ onboarding: string; exit: string; docs: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(() => api<{ rows: Emp[]; counts: Record<string, number> }>(`/api/v1/hr/employees?${new URLSearchParams({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) })}`).then(setData).catch((e) => setMsg({ type: 'error', text: e.message })), [status, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, version]);
  useEffect(() => { api<Meta>('/api/v1/hr/meta').then(setMeta).catch(() => setMeta(null)); api<Upcoming>('/api/v1/hr/upcoming').then(setUp).catch(() => setUp(null)); }, [version]);
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  const saveLists = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lists) return;
    const split = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    try { const r = await api<Meta>('/api/v1/hr/settings', { method: 'PUT', body: { onboardingTasks: split(lists.onboarding), exitTasks: split(lists.exit), docTypes: split(lists.docs) } }); setMeta(meta && { ...meta, ...r }); setLists(null); setMsg({ type: 'notice', text: 'Checklists saved. New employees get them from now on.' }); } catch (x) { setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }); }
  };
  return (
    <>
      <div className="page-head">
        <div><h1>Employees</h1><div className="muted small">Everyone who works here, with or without a UBOS login.</div></div>
        {meta?.can.manage && <div className="row"><button className="btn outline" onClick={() => setLists({ onboarding: meta.onboardingTasks.join('\n'), exit: meta.exitTasks.join('\n'), docs: meta.docTypes.join('\n') })}>Checklists</button><button className="btn" onClick={() => setAdding(true)}><Icon name="plus" className="ic" />Add employee</button></div>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {up && (up.events.length > 0 || up.documents.length > 0) && (
        <div className="card hr-up">
          <h2>Coming up</h2>
          <ul>
            {up.events.slice(0, 8).map((e) => <li key={`${e.kind}${e.employeeId}`}><Link href={`/app/hr/${e.employeeId}`}>{e.name}</Link> {e.kind === 'birthday' ? 'birthday' : e.kind === 'anniversary' ? `${e.years} ${e.years === 1 ? 'year' : 'years'} at work` : 'probation ends'} <span className="muted">{when(e.daysAway)}</span></li>)}
            {up.documents.slice(0, 5).map((d) => <li key={d.id}><Link href={`/app/hr/${d.employeeId}`}>{d.name}</Link> {d.docType} {d.daysAway < 0 ? 'expired' : 'expires'} <span className="muted">{when(d.daysAway)}</span></li>)}
          </ul>
        </div>
      )}
      <div className="chips" style={{ marginBottom: 12 }}>{TABS.map(([k, l]) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{l}<span className="count">{k ? data?.counts[k] ?? 0 : total}</span></button>)}</div>
      <input className="input" style={{ marginBottom: 12 }} aria-label="Search employees" placeholder="Search name, code, mobile or designation" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Employee</th><th>Designation</th><th>Department</th><th>Joined</th><th>Status</th></tr></thead>
            <tbody>
              {data?.rows.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => router.push(`/app/hr/${e.id}`)}>
                  <td><Link href={`/app/hr/${e.id}`}><b>{e.name}</b></Link><div className="small muted">{e.employeeCode}{e.user ? ' · has login' : ''}</div></td>
                  <td className="small">{e.designation ?? '—'}</td>
                  <td className="small">{e.department?.name ?? '—'}</td>
                  <td className="small">{hrDate(e.joiningDate)}</td>
                  <td><span className={`badge ${STATUS[e.status]?.[0] ?? 'grey'}`}>{STATUS[e.status]?.[1] ?? e.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.rows.length && <div className="empty">{total ? 'Nobody matches.' : 'No employees yet.'}</div>}
        </div>
      </div>
      {adding && meta && <EmployeeForm title="Add employee" meta={meta} initial={blankDraft(istDay(new Date()))} linkable={meta.unlinkedUsers} personal onClose={() => setAdding(false)} onSave={async (d) => { try { const e = await api<{ id: string }>('/api/v1/hr/employees', { method: 'POST', body: draftBody(d, true) }); router.push(`/app/hr/${e.id}`); return null; } catch (x) { return x instanceof ApiError ? x.message : 'Failed'; } }} />}
      {lists && (
        <div className="modal-bg">
          <form className="modal hr-modal" onSubmit={saveLists}>
            <h2>Checklists</h2>
            <p className="small muted" style={{ marginTop: -6 }}>One item per line. Joining items go to each new employee, leaving items when someone goes on notice.</p>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="cl-on">When someone joins</label><textarea id="cl-on" className="input" style={{ height: 170, paddingTop: 8 }} value={lists.onboarding} onChange={(e) => setLists({ ...lists, onboarding: e.target.value })} /></div>
              <div className="field"><label htmlFor="cl-ex">When someone leaves</label><textarea id="cl-ex" className="input" style={{ height: 170, paddingTop: 8 }} value={lists.exit} onChange={(e) => setLists({ ...lists, exit: e.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor="cl-doc">Document types</label><textarea id="cl-doc" className="input" style={{ height: 110, paddingTop: 8 }} value={lists.docs} onChange={(e) => setLists({ ...lists, docs: e.target.value })} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setLists(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
