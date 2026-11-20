'use client';

export interface DayRow { day: string; kind: string; late: boolean; hours: number | null; missedCheckout: boolean; payable: number; lop: number; checkInAt: string | null; checkOutAt: string | null; override: string | null; note: string | null; holiday: string | null; leaveCode: string | null }
export interface Totals { present: number; halfDay: number; absent: number; late: number; paidLeave: number; unpaidLeave: number; holidays: number; weeklyOffs: number; missedCheckout: number; payable: number; lop: number }
export interface Balance { leaveTypeId: string; code: string; name: string; isPaid: boolean; allowHalfDay: boolean; unlimited: boolean; year: number; earned: number; carried: number; adjustment: number; taken: number; pending: number; available: number }
export interface LeaveReq { id: string; employeeId: string; leaveType: string; leaveTypeId: string | null; fromDate: string; toDate: string; halfDay: boolean; days: number; reason: string | null; status: string; decisionNote: string | null; createdAt: string; type: { name: string; code: string } | null; employee: { name: string; employeeCode: string } }
export interface Settings { workStart: string; workEnd: string; graceMinutes: number; halfDayHours: number; fullDayHours: number; weeklyOff: number[]; saturdayOff: string; requireLocation: boolean; leaveYearStartMonth: number }

/** [badge tone, label, short code for the calendar] */
export const KIND: Record<string, [string, string, string]> = {
  present: ['ok', 'Present', 'P'], half_day: ['warn', 'Half day', '½'], absent: ['bad', 'Absent', 'A'], leave: ['brand', 'On leave', 'L'], half_leave: ['brand', 'Half leave', '½L'],
  holiday: ['grey', 'Holiday', 'H'], weekly_off: ['grey', 'Weekly off', 'Off'], upcoming: ['none', 'Not yet', ''], open: ['ok', 'Checked in', 'In'], not_employed: ['none', '', ''],
};
export const REQ_STATUS: Record<string, [string, string]> = { pending: ['warn', 'Waiting'], approved: ['ok', 'Approved'], rejected: ['bad', 'Not approved'], cancelled: ['grey', 'Cancelled'] };
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }) : '—');
export const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
export const dayLabel = (d: string, withYear = false) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
export const isoDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export const monthLabel = (m: string) => new Date(`${m}-15T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
export const shiftMonth = (m: string, n: number) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
export const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));
export const leaveDates = (r: LeaveReq) => { const a = isoDay(r.fromDate), b = isoDay(r.toDate); return a === b ? `${dayLabel(a, true)}${r.halfDay ? ' (half day)' : ''}` : `${dayLabel(a)} – ${dayLabel(b, true)}`; };

export function MonthNav({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <button className="btn ghost sm" aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))}>‹</button>
      <b style={{ minWidth: 130, textAlign: 'center' }}>{monthLabel(month)}</b>
      <button className="btn ghost sm" aria-label="Next month" onClick={() => onChange(shiftMonth(month, 1))}>›</button>
    </div>
  );
}

/** A Monday-first month calendar. Tapping a day calls `onPick`. */
export function MonthGrid({ days, today, onPick }: { days: DayRow[]; today: string; onPick?: (d: DayRow) => void }) {
  if (!days.length) return null;
  const lead = (new Date(`${days[0].day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return (
    <div className="cal">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => <div key={w} className="cal-head">{w}</div>)}
      {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
      {days.map((d) => {
        const [tone, label, code] = KIND[d.kind] ?? ['none', d.kind, ''];
        const title = [dayLabel(d.day, true), label, d.holiday, d.leaveCode, d.checkInAt ? `${time(d.checkInAt)} – ${time(d.checkOutAt)}` : '', d.late ? 'Late' : '', d.missedCheckout ? 'No check-out' : '', d.note].filter(Boolean).join(' · ');
        return (
          <button key={d.day} type="button" title={title} aria-label={title} className={`cal-day t-${tone}${d.day === today ? ' today' : ''}`} disabled={!onPick || d.kind === 'not_employed'} onClick={() => onPick?.(d)}>
            <span className="cal-num">{Number(d.day.slice(8))}</span>
            <span className="cal-code">{d.leaveCode && d.kind !== 'present' ? d.leaveCode : code}{d.late && <i className="cal-dot" />}{d.missedCheckout && <i className="cal-dot warn" />}</span>
            {d.checkInAt && <span className="cal-time">{hhmm(d.checkInAt)}{d.checkOutAt ? `–${hhmm(d.checkOutAt)}` : ''}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TotalsRow({ t }: { t: Totals }) {
  const items: [string, number][] = [['Present', t.present], ['Half days', t.halfDay], ['Absent', t.absent], ['Late', t.late], ['Paid leave', t.paidLeave], ['Without pay', t.unpaidLeave], ['Payable days', t.payable]];
  return <div className="att-totals">{items.map(([l, v]) => <div key={l}><span className="muted small">{l}</span><b>{num(v)}</b></div>)}</div>;
}

export function BalanceCards({ items, extra }: { items: Balance[]; extra?: (b: Balance) => React.ReactNode }) {
  return (
    <div className="att-bal">
      {items.map((b) => (
        <div key={b.leaveTypeId} className="card att-bal-card">
          <div className="muted small">{b.name}</div>
          <div className="att-bal-num">{b.unlimited ? 'No limit' : num(b.available)}</div>
          {!b.unlimited && <div className="small muted">{num(b.earned)} earned{b.carried ? ` + ${num(b.carried)} carried` : ''}{b.adjustment ? ` ${b.adjustment > 0 ? '+' : '−'} ${num(Math.abs(b.adjustment))} adjusted` : ''}</div>}
          <div className="small muted">{num(b.taken)} taken{b.pending ? ` · ${num(b.pending)} waiting` : ''}</div>
          {extra?.(b)}
        </div>
      ))}
    </div>
  );
}
