const DAY = 86_400_000, IST = 330 * 60_000;
const ymd = (d: Date) => { const x = new Date(d.getTime() + IST); return [x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()] as const; };
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The next IST date (today included) on which a yearly date comes round, e.g. a birthday. 29 February falls on 28 February in other years. */
export function nextYearly(date: Date, now: Date) {
  const [, m, d] = ymd(date), [ty, tm, td] = ymd(now);
  const on = (y: number) => Date.UTC(y, m, m === 1 && d === 29 && !leap(y) ? 28 : d);
  const today = Date.UTC(ty, tm, td);
  const year = on(ty) >= today ? ty : ty + 1;
  return { year, daysAway: Math.round((on(year) - today) / DAY), date: new Date(on(year)).toISOString().slice(0, 10) };
}

/** Whole IST days from today to a date (negative once past). */
export function daysUntil(date: Date, now: Date) {
  const [y, m, d] = ymd(date), [ty, tm, td] = ymd(now);
  return Math.round((Date.UTC(y, m, d) - Date.UTC(ty, tm, td)) / DAY);
}

export interface HrPerson { id: string; name: string; dateOfBirth: Date | null; joiningDate: Date; probationEnd: Date | null; status: string }
export interface HrEvent { kind: 'birthday' | 'anniversary' | 'probation'; employeeId: string; name: string; date: string; daysAway: number; years?: number }

/** Birthdays, work anniversaries (from the first year) and probation ends in the next `days` days, for people still working. */
export function upcomingHrEvents(people: HrPerson[], now: Date, days = 30): HrEvent[] {
  const out: HrEvent[] = [];
  for (const p of people) {
    if (p.status === 'exited') continue;
    if (p.dateOfBirth) { const n = nextYearly(p.dateOfBirth, now); if (n.daysAway <= days) out.push({ kind: 'birthday', employeeId: p.id, name: p.name, date: n.date, daysAway: n.daysAway }); }
    const a = nextYearly(p.joiningDate, now);
    const years = a.year - ymd(p.joiningDate)[0];
    if (years >= 1 && a.daysAway <= days) out.push({ kind: 'anniversary', employeeId: p.id, name: p.name, date: a.date, daysAway: a.daysAway, years });
    if (p.probationEnd && p.status === 'onboarding') { const left = daysUntil(p.probationEnd, now); if (left >= 0 && left <= days) out.push({ kind: 'probation', employeeId: p.id, name: p.name, date: new Date(p.probationEnd.getTime() + IST).toISOString().slice(0, 10), daysAway: left }); }
  }
  return out.sort((x, y) => x.daysAway - y.daysAway || x.name.localeCompare(y.name));
}

export const DEFAULT_ONBOARDING = ['Offer letter signed', 'ID and address proof collected', 'PAN and bank details collected', 'Laptop and SIM issued', 'Login and email created', 'Introduced to the team'];
export const DEFAULT_EXIT = ['Resignation accepted', 'Handover done', 'Assets returned', 'Logins switched off', 'Full and final settlement', 'Relieving letter issued'];
export const DEFAULT_DOC_TYPES = ['Aadhaar', 'PAN card', 'Offer letter', 'Appointment letter', 'Education certificate', 'Previous employment', 'Bank proof', 'Other'];
