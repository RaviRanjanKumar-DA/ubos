/** Collections helpers shared by the API and tests. Days are counted on the IST calendar. */

const IST_MS = 330 * 60_000;
const istDayNumber = (d: Date) => Math.floor((d.getTime() + IST_MS) / 86_400_000);

/** Days past due: 0 on the due date, negative before it. */
export const daysPastDue = (dueAt: Date, now: Date) => istDayNumber(now) - istDayNumber(dueAt);

export const AGE_BUCKETS = ['notDue', 'd1to30', 'd31to60', 'd61to90', 'd90plus'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** An invoice with no due date is not overdue. */
export function ageBucket(dueAt: Date | null, now: Date): AgeBucket {
  if (!dueAt) return 'notDue';
  const d = daysPastDue(dueAt, now);
  return d <= 0 ? 'notDue' : d <= 30 ? 'd1to30' : d <= 60 ? 'd31to60' : d <= 90 ? 'd61to90' : 'd90plus';
}

/** Reminders go 3 days before, on the day, then 3, 7 and 15 days after. */
export const REMINDER_DAYS = [-3, 0, 3, 7, 15] as const;
export const reminderStageFor = (daysPast: number) => REMINDER_DAYS.filter((d) => d <= daysPast).length;

/** The due date of the first instalment not yet covered by what has been paid, or null when all are. */
export function nextInstalmentDue<T extends { dueAt: Date; amountPaise: number }>(plan: T[], paidPaise: number): Date | null {
  let covered = 0;
  for (const i of [...plan].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())) {
    covered += i.amountPaise;
    if (covered > paidPaise) return i.dueAt;
  }
  return null;
}
