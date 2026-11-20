'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';
import { BalanceCards, KIND, MonthGrid, MonthNav, REQ_STATUS, TotalsRow, dayLabel, hhmm, leaveDates, num, time, type Balance, type DayRow, type LeaveReq, type Settings, type Totals } from '@/components/hr/attendance';

interface Me {
  employee: { id: string; name: string; employeeCode: string } | null; settings: Settings; types: { id: string; code: string; name: string; allowHalfDay: boolean; unlimited: boolean }[]; holidays: { day: string; name: string }[];
  today?: string; record?: { checkInAt: string | null; checkOutAt: string | null } | null; month?: string; days?: DayRow[]; totals?: Totals; balances?: Balance[]; requests?: LeaveReq[];
  corrections?: { id: string; day: string; checkInAt: string; checkOutAt: string; reason: string; status: string; decisionNote: string | null }[];
}
type LeaveDraft = { leaveTypeId: string; fromOn: string; toOn: string; halfDay: boolean; reason: string };

/** Where the browser says you are, if you allow it. Gives up after 8 seconds. */
const where = () => new Promise<{ lat?: number; lng?: number }>((resolve) => {
  if (!navigator.geolocation) return resolve({});
  navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve({}), { timeout: 8000, maximumAge: 60_000 });
});

export default function MyAttendance() {
  const { version } = useShell();
  const [month, setMonth] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [leave, setLeave] = useState<LeaveDraft | null>(null);
  const [fix, setFix] = useState<{ day: string; checkIn: string; checkOut: string; reason: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const load = useCallback(() => api<Me>(`/api/v1/hr/me${month ? `?month=${month}` : ''}`).then((r) => { setMe(r); if (!month && r.month) setMonth(r.month); }).catch((e) => setMsg({ type: 'error', text: e.message })), [month]);
  useEffect(() => { load(); }, [load, version]);

  const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');
  const punch = async (kind: 'in' | 'out') => {
    setBusy(true); setMsg(null);
    try { await api(`/api/v1/hr/me/check-${kind}`, { method: 'POST', body: await where() }); setMsg({ type: 'notice', text: kind === 'in' ? 'Checked in.' : 'Checked out.' }); load(); } catch (e) { setMsg({ type: 'error', text: err(e) }); }
    setBusy(false);
  };
  const submit = async (fn: () => Promise<unknown>, done: string, close: () => void) => {
    setFormErr(null);
    try { await fn(); close(); setMsg({ type: 'notice', text: done }); load(); } catch (e) { setFormErr(err(e)); }
  };
  const cancel = async (r: LeaveReq) => { if (!(await askConfirm('Cancel this leave request?', 'Cancel it'))) return; try { await api(`/api/v1/hr/me/leave/${r.id}/cancel`, { method: 'POST' }); setMsg({ type: 'notice', text: 'Request cancelled.' }); load(); } catch (e) { setMsg({ type: 'error', text: err(e) }); } };

  if (!me) return <>{msg && <div className={msg.type}>{msg.text}</div>}</>;
  if (!me.employee) {
    return (
      <>
        <div className="page-head"><div><h1>My attendance</h1></div></div>
        <div className="card empty">You do not have an employee record yet. Ask HR to add you, and link it to your login.</div>
      </>
    );
  }
  const s = me.settings, today = me.today!, rec = me.record;
  const pickType = me.types.find((t) => t.id === leave?.leaveTypeId);
  const bal = (id: string) => me.balances?.find((b) => b.leaveTypeId === id);
  const openFix = (d: DayRow) => { if (d.day > today || d.kind === 'holiday' || d.kind === 'weekly_off' || d.kind === 'leave') return; setFormErr(null); setFix({ day: d.day, checkIn: hhmm(d.checkInAt) || s.workStart, checkOut: hhmm(d.checkOutAt) || s.workEnd, reason: '' }); };
  const startLeave = () => { setFormErr(null); setLeave({ leaveTypeId: me.types[0]?.id ?? '', fromOn: today, toOn: today, halfDay: false, reason: '' }); };
  const canCancel = (r: LeaveReq) => r.status === 'pending' || (r.status === 'approved' && r.fromDate.slice(0, 10) > today);

  return (
    <>
      <div className="page-head">
        <div><h1>My attendance</h1><div className="muted small">{me.employee.name} · {me.employee.employeeCode} · shift {s.workStart}–{s.workEnd}</div></div>
        <button className="btn" onClick={startLeave}><Icon name="calendar" className="ic" />Apply for leave</button>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div className="card att-today" style={{ marginBottom: 16 }}>
        <div>
          <div className="muted small">{dayLabel(today, true)}</div>
          {!rec?.checkInAt && <div className="att-clock">Not checked in</div>}
          {rec?.checkInAt && <div className="att-clock">{time(rec.checkInAt)}{rec.checkOutAt ? ` – ${time(rec.checkOutAt)}` : ''}</div>}
          {rec?.checkInAt && me.days?.find((d) => d.day === today)?.late && <span className="badge warn">Late</span>}
          {s.requireLocation && <div className="small muted">Your location is saved when you check in and out.</div>}
        </div>
        <div className="row">
          {!rec?.checkInAt && <button className="btn" disabled={busy} onClick={() => punch('in')}>Check in</button>}
          {rec?.checkInAt && !rec.checkOutAt && <button className="btn" disabled={busy} onClick={() => punch('out')}>Check out</button>}
          {rec?.checkOutAt && <button className="btn ghost" disabled={busy} onClick={() => punch('out')}>Check out again</button>}
        </div>
      </div>

      <h2 className="hr-sub">Leave balance</h2>
      {me.balances && <BalanceCards items={me.balances} />}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Calendar</h2>
          {month && <MonthNav month={month} onChange={setMonth} />}
        </div>
        {me.days && <MonthGrid days={me.days} today={today} onPick={openFix} />}
        {me.totals && <TotalsRow t={me.totals} />}
        <p className="small muted" style={{ marginBottom: 0 }}>Forgot to check in or out? Tap the day to ask for a correction.</p>
      </div>

      <div className="hr-grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>My leave requests</h2>
          {!me.requests?.length && <div className="muted small">No requests yet.</div>}
          {me.requests?.map((r) => (
            <div key={r.id} className="att-req">
              <div>
                <b>{r.type?.name ?? r.leaveType}</b> <span className="muted small">· {num(r.days)} {r.days === 1 ? 'day' : 'days'}</span>
                <div className="small">{leaveDates(r)}</div>
                {r.reason && <div className="small muted">{r.reason}</div>}
                {r.decisionNote && <div className="small muted">Note: {r.decisionNote}</div>}
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <span className={`badge ${REQ_STATUS[r.status]?.[0]}`}>{REQ_STATUS[r.status]?.[1]}</span>
                {canCancel(r) && <button className="btn ghost sm" onClick={() => cancel(r)}>Cancel</button>}
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Holidays this year</h2>
          {!me.holidays.length && <div className="muted small">No holidays added yet.</div>}
          {me.holidays.map((h) => <div key={h.day} className="hr-row"><span>{h.name}</span><span className={h.day < today ? 'muted' : ''}>{dayLabel(h.day)}</span></div>)}
          {!!me.corrections?.length && (
            <>
              <h2 style={{ marginTop: 18 }}>Corrections</h2>
              {me.corrections.map((c) => (
                <div key={c.id} className="hr-row">
                  <span>{dayLabel(c.day)} · {time(c.checkInAt)}–{time(c.checkOutAt)}{c.decisionNote ? <span className="muted"> · {c.decisionNote}</span> : null}</span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className={`badge ${REQ_STATUS[c.status]?.[0]}`}>{REQ_STATUS[c.status]?.[1]}</span>
                    {c.status === 'pending' && <button className="btn ghost sm" onClick={async () => { try { await api(`/api/v1/hr/me/corrections/${c.id}/cancel`, { method: 'POST' }); load(); } catch (e) { setMsg({ type: 'error', text: err(e) }); } }}>Cancel</button>}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {leave && (
        <div className="modal-bg">
          <form className="modal" onSubmit={(e) => { e.preventDefault(); submit(() => api('/api/v1/hr/me/leave', { method: 'POST', body: { ...leave, halfDay: leave.halfDay && leave.fromOn === leave.toOn, reason: leave.reason.trim() || undefined } }), 'Leave requested. Your manager has been told.', () => setLeave(null)); }}>
            <h2>Apply for leave</h2>
            <div className="field"><label htmlFor="lv-t">Type</label>
              <select id="lv-t" className="input" required value={leave.leaveTypeId} onChange={(e) => setLeave({ ...leave, leaveTypeId: e.target.value, halfDay: false })}>
                {me.types.map((t) => { const b = bal(t.id); return <option key={t.id} value={t.id}>{t.name}{t.unlimited ? '' : b ? ` (${num(b.available)} left)` : ''}</option>; })}
              </select>
            </div>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="lv-f">From</label><input id="lv-f" className="input" type="date" required value={leave.fromOn} onChange={(e) => setLeave({ ...leave, fromOn: e.target.value, toOn: e.target.value > leave.toOn ? e.target.value : leave.toOn })} /></div>
              <div className="field"><label htmlFor="lv-to">To</label><input id="lv-to" className="input" type="date" required min={leave.fromOn} value={leave.toOn} onChange={(e) => setLeave({ ...leave, toOn: e.target.value })} /></div>
            </div>
            {pickType?.allowHalfDay && leave.fromOn === leave.toOn && <label className="row small" style={{ gap: 8, marginBottom: 12 }}><input type="checkbox" checked={leave.halfDay} onChange={(e) => setLeave({ ...leave, halfDay: e.target.checked })} />Half day</label>}
            <div className="field"><label htmlFor="lv-r">Reason (optional)</label><input id="lv-r" className="input" maxLength={500} value={leave.reason} onChange={(e) => setLeave({ ...leave, reason: e.target.value })} /></div>
            <p className="small muted" style={{ marginTop: -4 }}>Weekly offs and holidays are not counted.</p>
            {formErr && <div className="error">{formErr}</div>}
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setLeave(null)}>Go back</button><button className="btn">Send request</button></div>
          </form>
        </div>
      )}
      {fix && (
        <div className="modal-bg">
          <form className="modal" onSubmit={(e) => { e.preventDefault(); submit(() => api('/api/v1/hr/me/corrections', { method: 'POST', body: fix }), 'Correction sent for approval.', () => setFix(null)); }}>
            <h2>Correct {dayLabel(fix.day, true)}</h2>
            <p className="small muted" style={{ marginTop: -6 }}>Now: {KIND[me.days?.find((d) => d.day === fix.day)?.kind ?? '']?.[1] ?? '—'}. Your manager approves the change.</p>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="fx-in">Checked in at</label><input id="fx-in" className="input" type="time" required value={fix.checkIn} onChange={(e) => setFix({ ...fix, checkIn: e.target.value })} /></div>
              <div className="field"><label htmlFor="fx-out">Checked out at</label><input id="fx-out" className="input" type="time" required value={fix.checkOut} onChange={(e) => setFix({ ...fix, checkOut: e.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor="fx-r">Reason</label><input id="fx-r" className="input" required minLength={3} maxLength={300} placeholder="e.g. Forgot to check out" value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} /></div>
            {formErr && <div className="error">{formErr}</div>}
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setFix(null)}>Go back</button><button className="btn">Send</button></div>
          </form>
        </div>
      )}
    </>
  );
}
