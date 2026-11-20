'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm } from '@/components/Dialogs';
import { istDay } from '@/lib/ist';
import { BalanceCards, KIND, MonthGrid, MonthNav, REQ_STATUS, TotalsRow, dayLabel, hhmm, leaveDates, num, type Balance, type DayRow, type LeaveReq, type Totals } from '@/components/hr/attendance';

interface View { employee: { id: string; name: string; employeeCode: string; status: string }; month: string; days: DayRow[]; totals: Totals; balances: Balance[]; requests: LeaveReq[]; can: { fix: boolean; leave: boolean } }
type Fix = { day: string; checkIn: string; checkOut: string; override: string; note: string };

export default function EmployeeAttendance() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const { version } = useShell();
  const today = istDay(new Date());
  const [month, setMonth] = useState(sp.get('month') ?? today.slice(0, 7));
  const [v, setV] = useState<View | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [rec, setRec] = useState<{ leaveTypeId: string; fromOn: string; toOn: string; halfDay: boolean; reason: string } | null>(null);
  const [adj, setAdj] = useState<{ b: Balance; days: string; reason: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const load = useCallback(() => api<View>(`/api/v1/hr/attendance/employees/${id}?month=${month}`).then(setV).catch((e) => setMsg({ type: 'error', text: e.message })), [id, month]);
  useEffect(() => { load(); }, [load, version]);
  const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');
  const submit = async (fn: () => Promise<unknown>, done: string, close: () => void) => { setFormErr(null); try { await fn(); close(); setMsg({ type: 'notice', text: done }); load(); } catch (e) { setFormErr(err(e)); } };
  if (!v) return <>{msg && <div className={msg.type}>{msg.text}</div>}</>;

  const pick = (d: DayRow) => { if (!v.can.fix || d.day > today) return; setFormErr(null); setFix({ day: d.day, checkIn: hhmm(d.checkInAt), checkOut: hhmm(d.checkOutAt), override: d.override ?? '', note: d.note ?? '' }); };
  const recType = v.balances.find((b) => b.leaveTypeId === rec?.leaveTypeId);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small"><Link href="/app/hr/attendance">Attendance</Link> · <Link href={`/app/hr/${v.employee.id}`}>Employee record</Link></div>
          <h1>{v.employee.name}</h1>
          <div className="muted small">{v.employee.employeeCode}</div>
        </div>
        {v.can.leave && v.employee.status !== 'exited' && <button className="btn" onClick={() => { setFormErr(null); setRec({ leaveTypeId: v.balances[0]?.leaveTypeId ?? '', fromOn: today, toOn: today, halfDay: false, reason: '' }); }}>Record leave</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Calendar</h2>
          <MonthNav month={month} onChange={setMonth} />
        </div>
        <MonthGrid days={v.days} today={today} onPick={v.can.fix ? pick : undefined} />
        <TotalsRow t={v.totals} />
        {v.can.fix && <p className="small muted" style={{ marginBottom: 0 }}>Tap a day to correct it.</p>}
      </div>

      <h2 className="hr-sub">Leave balance</h2>
      <BalanceCards items={v.balances} extra={v.can.leave ? (b) => <button className="btn ghost sm" style={{ marginTop: 6, paddingLeft: 0 }} onClick={() => { setFormErr(null); setAdj({ b, days: '', reason: '' }); }}>Adjust</button> : undefined} />

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Leave</h2>
        {!v.requests.length && <div className="muted small">No leave yet.</div>}
        {v.requests.map((r) => (
          <div key={r.id} className="att-req">
            <div><b>{r.type?.name ?? r.leaveType}</b> <span className="muted small">· {num(r.days)} {r.days === 1 ? 'day' : 'days'}</span><div className="small">{leaveDates(r)}</div>{r.reason && <div className="small muted">{r.reason}</div>}</div>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className={`badge ${REQ_STATUS[r.status]?.[0]}`}>{REQ_STATUS[r.status]?.[1]}</span>
              {v.can.leave && (r.status === 'approved' || r.status === 'pending') && <button className="btn ghost sm" onClick={async () => { if (!(await askConfirm('Cancel this leave? The days go back to the balance.', 'Cancel leave'))) return; try { await api(`/api/v1/hr/leave/${r.id}/cancel`, { method: 'POST' }); load(); } catch (e) { setMsg({ type: 'error', text: err(e) }); } }}>Cancel</button>}
            </div>
          </div>
        ))}
      </div>

      {fix && (
        <div className="modal-bg">
          <form className="modal" onSubmit={(e) => { e.preventDefault(); submit(() => api(`/api/v1/hr/attendance/employees/${v.employee.id}/days/${fix.day}`, { method: 'PUT', body: { checkIn: fix.checkIn || null, checkOut: fix.checkOut || null, override: fix.override || null, note: fix.note.trim() || null } }), 'Day saved.', () => setFix(null)); }}>
            <h2>{dayLabel(fix.day, true)}</h2>
            <p className="small muted" style={{ marginTop: -6 }}>Now: {KIND[v.days.find((d) => d.day === fix.day)?.kind ?? '']?.[1] ?? '—'}</p>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="d-in">Check-in</label><input id="d-in" className="input" type="time" value={fix.checkIn} onChange={(e) => setFix({ ...fix, checkIn: e.target.value })} /></div>
              <div className="field"><label htmlFor="d-out">Check-out</label><input id="d-out" className="input" type="time" value={fix.checkOut} onChange={(e) => setFix({ ...fix, checkOut: e.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor="d-ov">Mark as</label>
              <select id="d-ov" className="input" value={fix.override} onChange={(e) => setFix({ ...fix, override: e.target.value })}>
                <option value="">Work it out from the times</option><option value="present">Present</option><option value="on_duty">On duty (out of office)</option><option value="half_day">Half day</option><option value="absent">Absent</option>
              </select>
            </div>
            <div className="field"><label htmlFor="d-n">Note (optional)</label><input id="d-n" className="input" maxLength={300} value={fix.note} onChange={(e) => setFix({ ...fix, note: e.target.value })} /></div>
            {formErr && <div className="error">{formErr}</div>}
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setFix(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
      {rec && (
        <div className="modal-bg">
          <form className="modal" onSubmit={(e) => { e.preventDefault(); submit(() => api('/api/v1/hr/leave', { method: 'POST', body: { employeeId: v.employee.id, ...rec, halfDay: rec.halfDay && rec.fromOn === rec.toOn, reason: rec.reason.trim() || undefined } }), 'Leave recorded.', () => setRec(null)); }}>
            <h2>Record leave</h2>
            <p className="small muted" style={{ marginTop: -6 }}>Recorded leave is approved straight away.</p>
            <div className="field"><label htmlFor="r-t">Type</label><select id="r-t" className="input" value={rec.leaveTypeId} onChange={(e) => setRec({ ...rec, leaveTypeId: e.target.value, halfDay: false })}>{v.balances.map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{b.name}{b.unlimited ? '' : ` (${num(b.available)} left)`}</option>)}</select></div>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="r-f">From</label><input id="r-f" className="input" type="date" required value={rec.fromOn} onChange={(e) => setRec({ ...rec, fromOn: e.target.value, toOn: e.target.value > rec.toOn ? e.target.value : rec.toOn })} /></div>
              <div className="field"><label htmlFor="r-to">To</label><input id="r-to" className="input" type="date" required min={rec.fromOn} value={rec.toOn} onChange={(e) => setRec({ ...rec, toOn: e.target.value })} /></div>
            </div>
            {recType?.allowHalfDay && rec.fromOn === rec.toOn && <label className="row small" style={{ gap: 8, marginBottom: 12 }}><input type="checkbox" checked={rec.halfDay} onChange={(e) => setRec({ ...rec, halfDay: e.target.checked })} />Half day</label>}
            <div className="field"><label htmlFor="r-r">Reason (optional)</label><input id="r-r" className="input" maxLength={500} value={rec.reason} onChange={(e) => setRec({ ...rec, reason: e.target.value })} /></div>
            {formErr && <div className="error">{formErr}</div>}
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setRec(null)}>Go back</button><button className="btn">Record</button></div>
          </form>
        </div>
      )}
      {adj && (
        <div className="modal-bg">
          <form className="modal" onSubmit={(e) => { e.preventDefault(); const n = Number(adj.days); if (!n || Math.abs(n * 2) % 1) return setFormErr('Enter whole or half days, e.g. 2, 1.5 or -1'); submit(() => api('/api/v1/hr/leave/adjust', { method: 'POST', body: { employeeId: v.employee.id, leaveTypeId: adj.b.leaveTypeId, days: n, reason: adj.reason } }), 'Balance adjusted.', () => setAdj(null)); }}>
            <h2>Adjust {adj.b.name.toLowerCase()}</h2>
            <p className="small muted" style={{ marginTop: -6 }}>Add days (comp off, opening balance) or take them away with a minus sign. Counts in the {adj.b.year} leave year.</p>
            <div className="field"><label htmlFor="a-d">Days</label><input id="a-d" className="input" inputMode="decimal" required placeholder="e.g. 2 or -1" value={adj.days} onChange={(e) => setAdj({ ...adj, days: e.target.value })} /></div>
            <div className="field"><label htmlFor="a-r">Reason</label><input id="a-r" className="input" required minLength={3} maxLength={300} placeholder="e.g. Comp off for Sunday work" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></div>
            {formErr && <div className="error">{formErr}</div>}
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setAdj(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
