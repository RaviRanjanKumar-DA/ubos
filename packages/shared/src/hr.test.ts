import { describe, expect, it } from 'vitest';
import { daysUntil, nextYearly, upcomingHrEvents } from './hr';

const at = (s: string) => new Date(`${s}+05:30`);

describe('HR dates', () => {
  it('finds the next yearly date on the IST calendar', () => {
    expect(nextYearly(at('1990-11-11T00:00:00'), at('2026-11-11T00:20:00'))).toEqual({ year: 2026, daysAway: 0, date: '2026-11-11' });
    expect(nextYearly(at('1990-11-10T12:00:00'), at('2026-11-11T09:00:00'))).toEqual({ year: 2027, daysAway: 364, date: '2027-11-10' });
    expect(nextYearly(at('1992-02-29T12:00:00'), at('2027-02-20T09:00:00')).date).toBe('2027-02-28');
    expect(nextYearly(at('1992-02-29T12:00:00'), at('2028-02-20T09:00:00')).date).toBe('2028-02-29');
  });
  it('counts days on the IST calendar', () => {
    expect(daysUntil(at('2026-11-12T00:05:00'), at('2026-11-11T23:55:00'))).toBe(1);
    expect(daysUntil(at('2026-11-10T23:00:00'), at('2026-11-11T01:00:00'))).toBe(-1);
  });
  it('lists birthdays, anniversaries from the first year, and probation ends', () => {
    const now = at('2026-11-11T10:00:00');
    const ev = upcomingHrEvents([
      { id: 'a', name: 'Asha', dateOfBirth: at('1995-11-15T00:00:00'), joiningDate: at('2024-11-11T10:00:00'), probationEnd: null, status: 'active' },
      { id: 'b', name: 'Bilal', dateOfBirth: null, joiningDate: at('2026-11-01T10:00:00'), probationEnd: at('2026-11-20T12:00:00'), status: 'onboarding' },
      { id: 'c', name: 'Chetan', dateOfBirth: at('1990-11-12T00:00:00'), joiningDate: at('2020-01-01T10:00:00'), probationEnd: null, status: 'exited' },
      { id: 'd', name: 'Dev', dateOfBirth: at('1990-12-30T00:00:00'), joiningDate: at('2025-11-11T10:00:00'), probationEnd: null, status: 'active' },
    ], now);
    expect(ev.map((e) => `${e.kind}:${e.name}:${e.daysAway}${e.years ? `:${e.years}` : ''}`)).toEqual(['anniversary:Asha:0:2', 'anniversary:Dev:0:1', 'birthday:Asha:4', 'probation:Bilal:9']);
  });
});
