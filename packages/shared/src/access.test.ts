import { describe, expect, it } from 'vitest';
import { accessDaysLeft, accessEndOfDate, accessExpiry, accessReminderStage, accessState, renewedExpiry } from './access';

const at = (s: string) => new Date(`${s}+05:30`);
const ist = (d: Date) => d.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour12: false }).slice(0, 20);

describe('access validity', () => {
  it('counts the start day as day one and ends at the close of the IST day', () => {
    expect(ist(accessExpiry(at('2026-01-01T10:00:00'), 30))).toBe('2026-01-30, 23:59:59');
    expect(ist(accessExpiry(at('2026-01-01T00:10:00'), 1))).toBe('2026-01-01, 23:59:59');
  });
  it('counts days on the IST calendar, including just after midnight', () => {
    const end = accessEndOfDate('2026-06-10');
    expect(accessDaysLeft(end, at('2026-06-10T23:30:00'))).toBe(0);
    expect(accessDaysLeft(end, at('2026-06-11T00:10:00'))).toBe(-1);
    expect(accessDaysLeft(end, at('2026-06-09T23:59:00'))).toBe(1);
  });
  it('names the state', () => {
    const now = at('2026-06-01T12:00:00');
    expect(accessState({ status: 'active', expiresAt: null }, now)).toBe('lifetime');
    expect(accessState({ status: 'revoked', expiresAt: null }, now)).toBe('revoked');
    expect(accessState({ status: 'active', expiresAt: accessEndOfDate('2026-05-31') }, now)).toBe('expired');
    expect(accessState({ status: 'active', expiresAt: accessEndOfDate('2026-06-01') }, now)).toBe('expiring');
    expect(accessState({ status: 'active', expiresAt: accessEndOfDate('2026-07-01') }, now)).toBe('expiring');
    expect(accessState({ status: 'active', expiresAt: accessEndOfDate('2026-07-02') }, now)).toBe('active');
  });
  it('moves through reminder stages', () => {
    expect(accessReminderStage(31, 30)).toBe(0);
    expect(accessReminderStage(30, 30)).toBe(1);
    expect(accessReminderStage(8, 30)).toBe(1);
    expect(accessReminderStage(7, 30)).toBe(2);
    expect(accessReminderStage(0, 30)).toBe(2);
    expect(accessReminderStage(-1, 30)).toBe(3);
    expect(accessReminderStage(5, 3)).toBe(0);
    expect(accessReminderStage(3, 3)).toBe(2);
  });
  it('adds to the end date when renewed early, and starts today when lapsed', () => {
    const now = at('2026-06-01T12:00:00');
    expect(ist(renewedExpiry(accessEndOfDate('2026-06-20'), 30, now))).toBe('2026-07-20, 23:59:59');
    expect(ist(renewedExpiry(accessEndOfDate('2026-01-01'), 30, now))).toBe('2026-06-30, 23:59:59');
    expect(ist(renewedExpiry(null, 30, now))).toBe('2026-06-30, 23:59:59');
  });
});
