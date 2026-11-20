// Attendance and leave rules shared by the API and the web app. Days are IST calendar days written as YYYY-MM-DD.

export interface AttendanceSettings {
  workStart: string; // HH:MM, IST
  workEnd: string;
  graceMinutes: number;
  halfDayHours: number; // fewer hours than this is absent
  fullDayHours: number; // at least this many is a full day
  weeklyOff: number[]; // 0 = Sunday … 6 = Saturday, every week
  saturdayOff: 'none' | '2nd_4th' | '1st_3rd' | 'alternate'; // extra Saturdays off (when Saturday is not in weeklyOff)
  requireLocation: boolean;
  leaveYearStartMonth: number; // 1 = January, 4 = April
}

export const DEFAULT_ATTENDANCE: AttendanceSettings = {
  workStart: '09:30', workEnd: '18:30', graceMinutes: 15, halfDayHours: 4, fullDayHours: 8,
  weeklyOff: [0], saturdayOff: '2nd_4th', requireLocation: false, leaveYearStartMonth: 1,
};

export interface LeaveTypeRule { code: string; name: string; isPaid: boolean; yearlyDays: number; accrual: 'yearly' | 'monthly'; carryForwardMax: number; allowHalfDay: boolean; allowNegative: boolean }

/** Common Indian defaults; each organization changes them. Leave without pay has no limit. */
export const DEFAULT_LEAVE_TYPES: LeaveTypeRule[] = [
  { code: 'CL', name: 'Casual leave', isPaid: true, yearlyDays: 12, accrual: 'yearly', carryForwardMax: 0, allowHalfDay: true, allowNegative: false },
  { code: 'SL', name: 'Sick leave', isPaid: true, yearlyDays: 7, accrual: 'yearly', carryForwardMax: 0, allowHalfDay: true, allowNegative: false },
  { code: 'EL', name: 'Earned leave', isPaid: true, yearlyDays: 15, accrual: 'monthly', carryForwardMax: 30, allowHalfDay: false, allowNegative: false },
  { code: 'LWP', name: 'Leave without pay', isPaid: false, yearlyDays: 0, accrual: 'yearly', carryForwardMax: 0, allowHalfDay: true, allowNegative: true },
];

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
export const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && fmt(utc(d)) === d;
export const addDays = (d: string, n: number) => fmt(utc(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY);
export const weekday = (d: string) => new Date(utc(d)).getUTCDay();
/** Today's IST day. */
export const istToday = (now = new Date()) => fmt(now.getTime() + 330 * 60_000);
/** IST day and minutes after midnight of an instant. */
export function istClock(at: Date) {
  const x = new Date(at.getTime() + 330 * 60_000);
  return { day: fmt(x.getTime()), minutes: x.getUTCHours() * 60 + x.getUTCMinutes() };
}
/** The instant of an IST wall-clock time on a day. */
export const istInstant = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const monthDays = (month: string) => { const n = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`); };

/** Weekly off: the fixed weekdays, plus 2nd/4th, 1st/3rd or alternate (2nd, 4th) Saturdays. */
export function isWeeklyOff(d: string, s: Pick<AttendanceSettings, 'weeklyOff' | 'saturdayOff'>) {
  const w = weekday(d);
  if (s.weeklyOff.includes(w)) return true;
  if (w !== 6 || s.saturdayOff === 'none') return false;
  const nth = Math.ceil(Number(d.slice(8, 10)) / 7);
  return s.saturdayOff === '1st_3rd' ? nth === 1 || nth === 3 : nth === 2 || nth === 4;
}

/** Working days a leave takes: weekly offs and holidays are skipped; a half day counts 0.5 (one-day leaves only). */
export function leaveDays(from: string, to: string, halfDay: boolean, s: Pick<AttendanceSettings, 'weeklyOff' | 'saturdayOff'>, holidays: Set<string>) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeeklyOff(d, s) && !holidays.has(d)) n++;
  return halfDay && from === to ? n / 2 : n;
}

/** The leave year that contains a day, e.g. April–March. `label` is the starting calendar year. */
export function leaveYear(d: string, startMonth: number) {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  const label = m >= startMonth ? y : y - 1;
  const from = `${label}-${String(startMonth).padStart(2, '0')}-01`;
  return { label, from, to: addDays(`${label + 1}-${String(startMonth).padStart(2, '0')}-01`, -1) };
}

const half = (n: number) => Math.floor(n * 2 + 1e-9) / 2;
const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

/**
 * Days earned in a leave year. Yearly leave is given up front, pro-rated by the months left when someone joins mid-year
 * (the joining month counts if they join by the 15th). Monthly leave builds up at the start of each month worked, up to `asOf`.
 * Rounded down to half days.
 */
export function entitlement(t: { yearlyDays: number; accrual: string }, year: { from: string; to: string }, joining: string, asOf: string) {
  if (t.yearlyDays <= 0 || joining > year.to) return 0;
  const startMonth = joining <= year.from ? monthIndex(year.from) : monthIndex(joining) + (Number(joining.slice(8, 10)) > 15 ? 1 : 0);
  const last = t.accrual === 'monthly' ? Math.min(monthIndex(asOf < year.to ? asOf : year.to), monthIndex(year.to)) : monthIndex(year.to);
  const months = Math.max(0, last - startMonth + 1);
  return half((t.yearlyDays * months) / 12);
}

export type DayKind = 'present' | 'half_day' | 'absent' | 'leave' | 'half_leave' | 'holiday' | 'weekly_off' | 'upcoming' | 'open' | 'not_employed';
export interface DayInput {
  day: string; today: string; settings: AttendanceSettings;
  checkInAt?: Date | null; checkOutAt?: Date | null; override?: string | null;
  holiday?: boolean; leave?: 0 | 0.5 | 1; leavePaid?: boolean; employed?: boolean;
}
export interface DayResult { kind: DayKind; late: boolean; hours: number | null; missedCheckout: boolean; payable: number; lop: number }

/** What a day counts as, and how much of it is paid. `lop` is loss of pay (0, 0.5 or 1). */
export function dayStatus(i: DayInput): DayResult {
  const r = (kind: DayKind, payable: number, extra: Partial<DayResult> = {}): DayResult => ({ kind, late: false, hours: null, missedCheckout: false, payable, lop: 0, ...extra });
  if (i.employed === false) return r('not_employed', 0);
  const hours = i.checkInAt && i.checkOutAt ? Math.round(((i.checkOutAt.getTime() - i.checkInAt.getTime()) / 3_600_000) * 100) / 100 : null;
  const late = !!i.checkInAt && istClock(i.checkInAt).minutes > mins(i.settings.workStart) + i.settings.graceMinutes;
  const paidLeave = (n: number) => (i.leavePaid === false ? 0 : n);
  if (i.leave === 1) return r('leave', paidLeave(1), { lop: i.leavePaid === false ? 1 : 0 });
  if (i.holiday) return r('holiday', 1);
  if (isWeeklyOff(i.day, i.settings) && !i.checkInAt && !i.override) return r('weekly_off', 1);
  if (i.day > i.today) return r(i.leave === 0.5 ? 'half_leave' : 'upcoming', 0);

  let worked: 0 | 0.5 | 1;
  let missedCheckout = false;
  if (i.override === 'present' || i.override === 'on_duty') worked = 1;
  else if (i.override === 'half_day') worked = 0.5;
  else if (i.override === 'absent') worked = 0;
  else if (!i.checkInAt) worked = 0;
  else if (!i.checkOutAt) {
    if (i.day === i.today) return r('open', 0, { late });
    missedCheckout = true; worked = 1; // counted, but flagged so HR can correct it
  } else worked = hours! >= i.settings.fullDayHours ? 1 : hours! >= i.settings.halfDayHours ? 0.5 : 0;

  if (i.day === i.today && worked === 0 && !i.override) return r(i.leave === 0.5 ? 'half_leave' : 'upcoming', 0);
  if (i.leave === 0.5) {
    const paid = Math.min(1, worked + paidLeave(0.5));
    return r('half_leave', paid, { late, hours, missedCheckout, lop: 1 - paid });
  }
  const kind: DayKind = worked === 1 ? 'present' : worked === 0.5 ? 'half_day' : 'absent';
  return r(kind, worked, { late, hours, missedCheckout, lop: 1 - worked });
}

export interface MonthTotals { present: number; halfDay: number; absent: number; late: number; paidLeave: number; unpaidLeave: number; holidays: number; weeklyOffs: number; missedCheckout: number; payable: number; lop: number }

export function monthTotals(days: (DayResult & { leavePaid?: boolean; leaveDays?: number })[]): MonthTotals {
  const t: MonthTotals = { present: 0, halfDay: 0, absent: 0, late: 0, paidLeave: 0, unpaidLeave: 0, holidays: 0, weeklyOffs: 0, missedCheckout: 0, payable: 0, lop: 0 };
  for (const d of days) {
    if (d.kind === 'present') t.present++;
    if (d.kind === 'half_day') t.halfDay++;
    if (d.kind === 'absent') t.absent++;
    if (d.kind === 'holiday') t.holidays++;
    if (d.kind === 'weekly_off') t.weeklyOffs++;
    if (d.kind === 'leave' || d.kind === 'half_leave') t[d.leavePaid === false ? 'unpaidLeave' : 'paidLeave'] += d.kind === 'leave' ? 1 : 0.5;
    if (d.late) t.late++;
    if (d.missedCheckout) t.missedCheckout++;
    t.payable += d.payable;
    t.lop += d.lop;
  }
  return t;
}
