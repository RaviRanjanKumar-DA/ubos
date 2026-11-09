const DAY = 86_400_000, IST = 330 * 60_000;

/** Whole IST day number, so validity counts Indian calendar days whatever the server clock is. */
const dayNum = (d: Date) => Math.floor((d.getTime() + IST) / DAY);
const endOfDay = (n: number) => new Date((n + 1) * DAY - IST - 1000);

export type AccessState = 'lifetime' | 'active' | 'expiring' | 'expired' | 'revoked';
export const ACCESS_KINDS = ['none', 'course', 'software', 'service'] as const;

/** 0 on the last valid day, negative once it has passed. */
export const accessDaysLeft = (expiresAt: Date, now: Date) => dayNum(expiresAt) - dayNum(now);

export function accessState(a: { status: string; expiresAt: Date | null }, now: Date, soonDays = 30): AccessState {
  if (a.status === 'revoked') return 'revoked';
  if (!a.expiresAt) return 'lifetime';
  const left = accessDaysLeft(a.expiresAt, now);
  return left < 0 ? 'expired' : left <= soonDays ? 'expiring' : 'active';
}

/** 1 = renewal window opens, 2 = final week, 3 = expired. Each stage is acted on once. */
export function accessReminderStage(daysLeft: number, renewBeforeDays: number) {
  if (daysLeft < 0) return 3;
  if (daysLeft <= Math.min(7, renewBeforeDays)) return 2;
  return daysLeft <= renewBeforeDays ? 1 : 0;
}

/** The start day counts as the first day: 30 days from 1 January runs to 30 January, end of day IST. */
export const accessExpiry = (startsAt: Date, days: number) => endOfDay(dayNum(startsAt) + days - 1);

/** Renewing early adds to the current end date; renewing after it lapsed starts today, so no one pays for the gap. */
export function renewedExpiry(expiresAt: Date | null, days: number, now: Date) {
  const today = dayNum(now);
  const base = expiresAt ? Math.max(dayNum(expiresAt), today - 1) : today - 1;
  return endOfDay(base + days);
}

/** The last moment of an IST calendar date such as 2026-12-31. */
export const accessEndOfDate = (date: string) => endOfDay(dayNum(new Date(`${date}T12:00:00+05:30`)));
