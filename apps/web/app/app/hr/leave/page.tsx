'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm, askText } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';
import { istDay } from '@/lib/ist';
import { WEEKDAYS, dayLabel, leaveDates, num, time, type LeaveReq, type Settings } from '@/components/hr/attendance';

interface LeaveType { id: string; code: string; name: string; isPaid: boolean; yearlyDays: number; accrual: string; carryForwardMax: number; allowHalfDay: boolean; allowNegative: boolean; isArchived: boolean }
interface Setup { settings: Settings; year: { label: number; from: string; to: string }; types: LeaveType[]; holidays: { id: string; day: string; name: string }[]; can: { fix: boolean; leave: boolean; approve: boolean; view: boolean } }
interface Queue { leave: (LeaveReq & { balance: { available: number; unlimited: boolean } | null })[]; corrections: { id: string; day: string; checkInAt: string; checkOutAt: string; reason: string; employee: { name: string; employeeCode: string } }[] }
type TypeDraft = Omit<LeaveType, 'id' | 'isArchived'> & { id: string | null; yearly: string; carry: string };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SATURDAYS: [string, string][] = [['none', 'No extra Saturdays'], ['2nd_4th', '2nd and 4th Saturdays'], ['1st_3rd', '1st and 3rd Saturdays']];

export default function LeavePage() {
  const { version } = useShell();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [type, setType] = useState<TypeDraft | null>(null);
  const [shift, setShift] = useState<Settings | null>(null);
  const [hol, setHol] = useState({ day: '', name: '' });
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const today = istDay(new Date());
  const load = useCallback(async () => {
    try {
      const s = await api<Setup>('/api/v1/hr/leave/setup');
      setSetup(s); setShift(s.settings);
      setTab((t) => t ?? (s.can.approve ? 'approvals' : 'holidays'));
      if (s.can.approve) setQueue(await api<Queue>('/api/v1/hr/approvals'));
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed' }); }
  }, []);
  useEffect(() => { load(); }, [load, version]);
  const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');
  const act = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); load(); return true; } catch (e) { setMsg({ type: 'error', text: err(e) }); return false; } };
  const decide = async (kind: 'leave' | 'corrections', id: string, approve: boolean) => {
    const note = approve ? undefined : await askText('Reason for not approving (the employee sees this)');
    if (!approve && note === null) return;
    act(() => api(`/api/v1/hr/${kind}/${id}/decide`, { method: 'POST', body: { approve, note: note || undefined } }), approve ? 'Approved.' : 'Not approved.');
  };
  const saveType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!type) return;
    setFormErr(null);
    const yearlyDays = Number(type.yearly), carryForwardMax = Number(type.carry || 0);
    if (Number.isNaN(yearlyDays) || Number.isNaN(carryForwardMax)) return setFormErr('Enter the days as numbers');
    const body = { code: type.code, name: type.name, isPaid: type.isPaid, yearlyDays, accrual: type.accrual, carryForwardMax, allowHalfDay: type.allowHalfDay, allowNegative: type.allowNegative };
    try { await api(type.id ? `/api/v1/hr/leave/types/${type.id}` : '/api/v1/hr/leave/types', { method: type.id ? 'PUT' : 'POST', body }); setType(null); setMsg({ type: 'notice', text: 'Leave type saved.' }); load(); } catch (x) { setFormErr(err(x)); }
  };
  if (!setup) return <>{msg && <div className={msg.type}>{msg.text}</div>}</>;
  const pending = (queue?.leave.length ?? 0) + (queue?.corrections.length ?? 0);
  const tabs: [string, string, boolean][] = [['approvals', 'Approvals', setup.can.approve], ['types', 'Leave types', setup.can.leave], ['holidays', 'Holidays', true], ['shift', 'Shift and weekly offs', setup.can.fix]];

  return (
    <>
      <div className="page-head">
        <div><h1>Leave</h1><div className="muted small">Approvals, leave types, holidays and the working week. Leave year {MONTHS[setup.settings.leaveYearStartMonth - 1]} to {MONTHS[(setup.settings.leaveYearStartMonth + 10) % 12]}.</div></div>
        {setup.can.view && <Link className="btn outline" href="/app/hr/attendance">Attendance</Link>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="chips" style={{ marginBottom: 14 }}>
        {tabs.filter((t) => t[2]).map(([k, l]) => <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}{k === 'approvals' && <span className="count">{pending}</span>}</button>)}
      </div>

      {tab === 'approvals' && queue && (
        <div className="hr-grid">
          <div className="card">
            <h2>Leave requests</h2>
            {!queue.leave.length && <div className="muted small">Nothing waiting.</div>}
            {queue.leave.map((r) => (
              <div key={r.id} className="att-req">
                <div>
                  <b>{r.employee.name}</b> <span className="muted small">· {r.type?.name} · {num(r.days)} {r.days === 1 ? 'day' : 'days'}</span>
                  <div className="small">{leaveDates(r)}</div>
                  {r.reason && <div className="small muted">{r.reason}</div>}
                  {r.balance && !r.balance.unlimited && <div className={`small ${r.balance.available < 0 ? 'kpi-bad' : 'muted'}`}>{num(r.balance.available)} left after this</div>}
                </div>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <button className="btn sm" onClick={() => decide('leave', r.id, true)}>Approve</button>
                  <button className="btn ghost sm" onClick={() => decide('leave', r.id, false)}>Decline</button>
                </div>
              </div>
            ))}
          </div>
          <div className="card">
            <h2>Attendance corrections</h2>
            {!queue.corrections.length && <div className="muted small">Nothing waiting.</div>}
            {queue.corrections.map((c) => (
              <div key={c.id} className="att-req">
                <div><b>{c.employee.name}</b><div className="small">{dayLabel(c.day, true)} · {time(c.checkInAt)} – {time(c.checkOutAt)}</div><div className="small muted">{c.reason}</div></div>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <button className="btn sm" onClick={() => decide('corrections', c.id, true)}>Approve</button>
                  <button className="btn ghost sm" onClick={() => decide('corrections', c.id, false)}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'types' && (
        <>
          <div className="row end" style={{ marginBottom: 12 }}><button className="btn" onClick={() => { setFormErr(null); setType({ id: null, code: '', name: '', isPaid: true, yearlyDays: 0, yearly: '', accrual: 'yearly', carryForwardMax: 0, carry: '0', allowHalfDay: true, allowNegative: false }); }}><Icon name="plus" className="ic" />Add leave type</button></div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Days a year</th><th>Given</th><th>Carry forward</th><th>Paid</th><th /></tr></thead>
                <tbody>
                  {setup.types.map((t) => (
                    <tr key={t.id} style={t.isArchived ? { opacity: 0.55 } : undefined}>
                      <td><b>{t.name}</b><div className="small muted">{t.code}{t.allowHalfDay ? ' · half days allowed' : ''}{t.isArchived ? ' · archived' : ''}</div></td>
                      <td>{t.allowNegative ? 'No limit' : num(t.yearlyDays)}</td>
                      <td className="small">{t.accrual === 'monthly' ? 'Month by month' : 'At the start of the year'}</td>
                      <td>{t.carryForwardMax ? `Up to ${num(t.carryForwardMax)}` : '—'}</td>
                      <td>{t.isPaid ? 'Yes' : 'No'}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn ghost sm" onClick={() => { setFormErr(null); setType({ ...t, yearly: String(t.yearlyDays), carry: String(t.carryForwardMax) }); }}>Edit</button>
                        <button className="btn ghost sm" onClick={async () => { if (t.isArchived || (await askConfirm(`Archive ${t.name}? Nobody can apply for it, but past leave stays.`))) act(() => api(`/api/v1/hr/leave/types/${t.id}`, { method: 'PUT', body: { isArchived: !t.isArchived } }), t.isArchived ? 'Restored.' : 'Archived.'); }}>{t.isArchived ? 'Restore' : 'Archive'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="small muted">People who join mid-year get a share of yearly leave for the months left. Balances can be adjusted on each person&apos;s attendance page.</p>
        </>
      )}

      {tab === 'holidays' && (
        <div className="hr-grid">
          <div className="card">
            <h2>Holidays</h2>
            {!setup.holidays.length && <div className="muted small">No holidays added yet.</div>}
            {setup.holidays.map((h) => (
              <div key={h.id} className="hr-row">
                <span className={h.day < today ? 'muted' : ''}>{h.name}</span>
                <span className="row" style={{ gap: 6 }}>{dayLabel(h.day, true)}{setup.can.fix && <button className="btn ghost sm" aria-label={`Remove ${h.name}`} onClick={async () => { if (await askConfirm(`Remove ${h.name}?`)) act(() => api(`/api/v1/hr/holidays/${h.id}/archive`, { method: 'POST' }), 'Holiday removed.'); }}><Icon name="close" className="ic" /></button>}</span>
              </div>
            ))}
          </div>
          {setup.can.fix && (
            <form className="card" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('/api/v1/hr/holidays', { method: 'POST', body: hol }), 'Holiday added.')) setHol({ day: '', name: '' }); }}>
              <h2>Add a holiday</h2>
              <div className="field"><label htmlFor="h-d">Date</label><input id="h-d" className="input" type="date" required value={hol.day} onChange={(e) => setHol({ ...hol, day: e.target.value })} /></div>
              <div className="field"><label htmlFor="h-n">Name</label><input id="h-n" className="input" required minLength={2} maxLength={80} placeholder="e.g. Diwali" value={hol.name} onChange={(e) => setHol({ ...hol, name: e.target.value })} /></div>
              <button className="btn">Add</button>
            </form>
          )}
        </div>
      )}

      {tab === 'shift' && shift && (
        <form className="card" style={{ maxWidth: 720 }} onSubmit={(e) => { e.preventDefault(); act(() => api('/api/v1/hr/attendance/settings', { method: 'PUT', body: shift }), 'Shift saved.'); }}>
          <h2>Shift and weekly offs</h2>
          <div className="grid cols-3">
            <div className="field"><label htmlFor="s-s">Shift starts</label><input id="s-s" className="input" type="time" required value={shift.workStart} onChange={(e) => setShift({ ...shift, workStart: e.target.value })} /></div>
            <div className="field"><label htmlFor="s-e">Shift ends</label><input id="s-e" className="input" type="time" required value={shift.workEnd} onChange={(e) => setShift({ ...shift, workEnd: e.target.value })} /></div>
            <div className="field"><label htmlFor="s-g">Late after (minutes)</label><input id="s-g" className="input" type="number" min={0} max={240} required value={shift.graceMinutes} onChange={(e) => setShift({ ...shift, graceMinutes: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="s-f">Full day (hours)</label><input id="s-f" className="input" type="number" min={1} max={16} step={0.5} required value={shift.fullDayHours} onChange={(e) => setShift({ ...shift, fullDayHours: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="s-h">Half day (hours)</label><input id="s-h" className="input" type="number" min={0.5} max={12} step={0.5} required value={shift.halfDayHours} onChange={(e) => setShift({ ...shift, halfDayHours: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="s-y">Leave year starts</label><select id="s-y" className="input" value={shift.leaveYearStartMonth} onChange={(e) => setShift({ ...shift, leaveYearStartMonth: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></div>
          </div>
          <div className="field"><label>Weekly off</label>
            <div className="chips">{WEEKDAYS.map((w, i) => <button type="button" key={w} className={`chip ${shift.weeklyOff.includes(i) ? 'on' : ''}`} onClick={() => setShift({ ...shift, weeklyOff: shift.weeklyOff.includes(i) ? shift.weeklyOff.filter((x) => x !== i) : [...shift.weeklyOff, i].sort() })}>{w}</button>)}</div>
          </div>
          {!shift.weeklyOff.includes(6) && <div className="field"><label htmlFor="s-sat">Saturdays off</label><select id="s-sat" className="input" value={shift.saturdayOff === 'alternate' ? '2nd_4th' : shift.saturdayOff} onChange={(e) => setShift({ ...shift, saturdayOff: e.target.value })}>{SATURDAYS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>}
          <label className="row small" style={{ gap: 8, marginBottom: 14 }}><input type="checkbox" checked={shift.requireLocation} onChange={(e) => setShift({ ...shift, requireLocation: e.target.checked })} />Ask for location when people check in and out</label>
          <p className="small muted" style={{ marginTop: 0 }}>Fewer hours than a half day count as absent. Changes apply to how every day is counted, including past days.</p>
          <button className="btn">Save</button>
        </form>
      )}

      {type && (
        <div className="modal-bg">
          <form className="modal" onSubmit={saveType}>
            <h2>{type.id ? 'Edit leave type' : 'Add leave type'}</h2>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="t-n">Name</label><input id="t-n" className="input" required minLength={2} maxLength={60} placeholder="e.g. Maternity leave" value={type.name} onChange={(e) => setType({ ...type, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="t-c">Short code</label><input id="t-c" className="input" required maxLength={8} placeholder="e.g. ML" value={type.code} onChange={(e) => setType({ ...type, code: e.target.value.toUpperCase() })} /></div>
              <div className="field"><label htmlFor="t-y">Days a year</label><input id="t-y" className="input" inputMode="decimal" required disabled={type.allowNegative} value={type.allowNegative ? '0' : type.yearly} onChange={(e) => setType({ ...type, yearly: e.target.value })} /></div>
              <div className="field"><label htmlFor="t-a">Given</label><select id="t-a" className="input" value={type.accrual} onChange={(e) => setType({ ...type, accrual: e.target.value })}><option value="yearly">At the start of the year</option><option value="monthly">Month by month</option></select></div>
              <div className="field"><label htmlFor="t-cf">Carry forward up to (days)</label><input id="t-cf" className="input" inputMode="decimal" value={type.carry} onChange={(e) => setType({ ...type, carry: e.target.value })} /></div>
            </div>
            <label className="row small" style={{ gap: 8, marginBottom: 8 }}><input type="checkbox" checked={type.isPaid} onChange={(e) => setType({ ...type, isPaid: e.target.checked })} />Paid leave</label>
            <label className="row small" style={{ gap: 8, marginBottom: 8 }}><input type="checkbox" checked={type.allowHalfDay} onChange={(e) => setType({ ...type, allowHalfDay: e.target.checked })} />Can be taken as a half day</label>
            <label className="row small" style={{ gap: 8, marginBottom: 14 }}><input type="checkbox" checked={type.allowNegative} onChange={(e) => setType({ ...type, allowNegative: e.target.checked, yearly: e.target.checked ? '0' : type.yearly })} />No limit (like leave without pay)</label>
            {formErr && <div className="error">{formErr}</div>}
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setType(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
