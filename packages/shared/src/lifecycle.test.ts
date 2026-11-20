import { describe, expect, it } from 'vitest';
import { billingState } from './lifecycle';

const now = new Date('2026-11-20T10:00:00Z');
const d = (days: number) => new Date(now.getTime() + days * 86_400_000);

describe('billing lifecycle', () => {
  it('a trial counts down to its end', () => {
    expect(billingState({ status: 'trialing', trialEndsAt: d(5.5), currentPeriodEnd: d(5.5) }, 7, now)).toMatchObject({ phase: 'trial', daysLeft: 6 });
  });
  it('a paid period is active', () => {
    expect(billingState({ status: 'active', trialEndsAt: null, currentPeriodEnd: d(40) }, 7, now)).toMatchObject({ phase: 'active', daysLeft: 40 });
  });
  it('grace days follow the end', () => {
    expect(billingState({ status: 'trialing', trialEndsAt: d(-2), currentPeriodEnd: d(-2) }, 7, now)).toMatchObject({ phase: 'grace', daysLeft: 5 });
    expect(billingState({ status: 'past_due', trialEndsAt: null, currentPeriodEnd: d(-1) }, 7, now).phase).toBe('grace');
  });
  it('after the grace days the account expires', () => {
    expect(billingState({ status: 'active', trialEndsAt: null, currentPeriodEnd: d(-8) }, 7, now)).toMatchObject({ phase: 'expired', daysLeft: 0 });
    expect(billingState({ status: 'trialing', trialEndsAt: d(-1), currentPeriodEnd: d(-1) }, 0, now).phase).toBe('expired');
  });
});
