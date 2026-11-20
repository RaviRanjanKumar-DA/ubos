// The trial and renewal lifecycle of a customer organization of UBOS.
import { daysBetween, istClock } from './attendance';

/** Organization statuses in which everything keeps working. "expired" only allows signing in and Billing. */
export const LIVE_TENANT_STATUSES = ['trial', 'active', 'grace'];

export type BillingPhase = 'trial' | 'active' | 'grace' | 'expired';
export interface BillingState { phase: BillingPhase; endsAt: Date; graceEndsAt: Date; daysLeft: number }

const DAY = 86_400_000;

/**
 * Where an organization stands: in its trial or paid period, in the grace days after it ended, or expired.
 * `daysLeft` counts IST calendar days to the end of the period (or of the grace days once in grace), never below 0.
 */
export function billingState(sub: { status: string; trialEndsAt: Date | null; currentPeriodEnd: Date }, graceDays: number, now = new Date()): BillingState {
  const trial = sub.status === 'trialing';
  const endsAt = trial && sub.trialEndsAt ? sub.trialEndsAt : sub.currentPeriodEnd;
  const graceEndsAt = new Date(endsAt.getTime() + graceDays * DAY);
  // Whole IST calendar days, so "ends in 3 days" means the same thing all day long.
  const left = (d: Date) => Math.max(0, daysBetween(istClock(now).day, istClock(d).day));
  if (now < endsAt) return { phase: trial ? 'trial' : 'active', endsAt, graceEndsAt, daysLeft: left(endsAt) };
  if (now < graceEndsAt) return { phase: 'grace', endsAt, graceEndsAt, daysLeft: left(graceEndsAt) };
  return { phase: 'expired', endsAt, graceEndsAt, daysLeft: 0 };
}

/** Days before the end on which admins are reminded to pay. */
export const RENEWAL_REMINDER_DAYS = [7, 3, 1];

/** Organization codes people cannot sign up with. */
export const RESERVED_SLUGS = ['www', 'api', 'app', 'console', 'admin', 'platform', 'mail', 'help', 'support', 'status', 'billing', 'signup', 'login', 'ubos', 'static', 'assets', 'cdn'];
