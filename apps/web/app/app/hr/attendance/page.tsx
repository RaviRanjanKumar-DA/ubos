'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { istDay } from '@/lib/ist';
import { KIND, MonthNav, dayLabel, num, time, type Totals } from '@/components/hr/attendance';

interface Today { day: string; counts: { total: number; in: number; late: number; onLeave: number; notIn: number }; people: { id: string; name: string; employeeCode: string; designation: string | null; kind: string; late: boolean; checkInAt: string | null; checkOutAt: string | null; leaveCode: string | null; holiday: string | null }[] }
interface Register { month: string; rows: ({ id: string; name: string; employeeCode: string; designation: string | null; status: string } & Totals)[] }

export default function AttendancePage() {
  const { version } = useShell();
  const router = useRouter();
  const [tab, setTab] = useState<'today' | 'register'>('today');
  const [today, setToday] = useState<Today | null>(null);
  const [month, setMonth] = useState(istDay(new Date()).slice(0, 7));
  const [reg, setReg] = useState<Register | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const loadToday = useCallback(() => api<Today>('/api/v1/hr/attendance/today').then(setToday).catch((e) => setMsg(e.message)), []);
  const loadReg = useCallback(() => api<Register>(`/api/v1/hr/attendance/register?month=${month}`).then(setReg).catch((e) => setMsg(e.message)), [month]);
  useEffect(() => { if (tab === 'today') loadToday(); else loadReg(); }, [tab, loadToday, loadReg, version]);
  const download = async () => {
    try { const b = await api<Blob>(`/api/v1/hr/attendance/register.csv?month=${month}`); const u = URL.createObjectURL(new Blob([b], { type: 'text/csv' })); const a = document.createElement('a'); a.href = u; a.download = `attendance-${month}.csv`; a.click(); URL.revokeObjectURL(u); } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Failed'); }
  };
  const open = (id: string) => router.push(`/app/hr/attendance/${id}${tab === 'register' ? `?month=${month}` : ''}`);

  return (
    <>
      <div className="page-head">
        <div><h1>Attendance</h1><div className="muted small">Who is in today, and the monthly register for payroll.</div></div>
        <Link className="btn outline" href="/app/hr/leave">Leave and approvals</Link>
      </div>
      {msg && <div className="error">{msg}</div>}
      <div className="chips" style={{ marginBottom: 14 }}>
        <button className={`chip ${tab === 'today' ? 'on' : ''}`} onClick={() => setTab('today')}>Today</button>
        <button className={`chip ${tab === 'register' ? 'on' : ''}`} onClick={() => setTab('register')}>Monthly register</button>
      </div>

      {tab === 'today' && today && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            {([['Checked in', today.counts.in], ['Late', today.counts.late], ['On leave', today.counts.onLeave], ['Not in yet', today.counts.notIn]] as [string, number][]).map(([l, v]) => <div key={l} className="card kpi"><div className="label">{l}</div><div className="value">{v}</div></div>)}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Today</th><th>In</th><th>Out</th></tr></thead>
                <tbody>
                  {today.people.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => open(p.id)}>
                      <td><Link href={`/app/hr/attendance/${p.id}`}><b>{p.name}</b></Link><div className="small muted">{p.employeeCode}{p.designation ? ` · ${p.designation}` : ''}</div></td>
                      <td>{p.checkOutAt && (p.kind === 'upcoming' || p.kind === 'open') ? <span className="badge grey">Checked out</span> : <span className={`badge ${KIND[p.kind]?.[0] === 'none' ? 'grey' : KIND[p.kind]?.[0]}`}>{p.kind === 'upcoming' ? 'Not in yet' : p.holiday ?? (p.leaveCode ? `${KIND[p.kind]?.[1]} (${p.leaveCode})` : KIND[p.kind]?.[1])}</span>}{p.late && <span className="badge warn" style={{ marginLeft: 6 }}>Late</span>}</td>
                      <td className="small">{time(p.checkInAt)}</td>
                      <td className="small">{time(p.checkOutAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!today.people.length && <div className="empty">No employees yet. Add them under Employees.</div>}
            </div>
          </div>
          <p className="small muted">{dayLabel(today.day, true)}. People without a UBOS login are marked by HR from their calendar.</p>
        </>
      )}

      {tab === 'register' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
            <MonthNav month={month} onChange={setMonth} />
            <button className="btn outline" onClick={download}><Icon name="download" className="ic" />Download CSV</button>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Present</th><th>Half days</th><th>Absent</th><th>Late</th><th>Paid leave</th><th>Without pay</th><th>Payable days</th></tr></thead>
                <tbody>
                  {reg?.rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                      <td><b>{r.name}</b><div className="small muted">{r.employeeCode}</div></td>
                      <td>{num(r.present)}</td><td>{num(r.halfDay)}</td><td className={r.absent ? 'kpi-bad' : ''}>{num(r.absent)}</td><td>{num(r.late)}</td><td>{num(r.paidLeave)}</td><td>{num(r.unpaidLeave)}</td><td><b>{num(r.payable)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {reg && !reg.rows.length && <div className="empty">Nobody was working this month.</div>}
            </div>
          </div>
          <p className="small muted">Counts run up to today. Payable days include weekly offs, holidays and paid leave; absent days and leave without pay are not paid.</p>
        </>
      )}
    </>
  );
}
