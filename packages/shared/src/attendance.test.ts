import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENDANCE as S, dayStatus, entitlement, isDay, isWeeklyOff, istInstant, leaveDays, leaveYear, monthDays, monthTotals } from './attendance';

describe('weekly offs', () => {
  it('Sundays and 2nd/4th Saturdays by default', () => {
    expect(isWeeklyOff('2026-11-01', S)).toBe(true); // Sunday
    expect(isWeeklyOff('2026-11-07', S)).toBe(false); // 1st Saturday
    expect(isWeeklyOff('2026-11-14', S)).toBe(true); // 2nd
    expect(isWeeklyOff('2026-11-28', S)).toBe(true); // 4th
    expect(isWeeklyOff('2026-11-29', S)).toBe(true);
    expect(isWeeklyOff('2026-11-30', S)).toBe(false);
  });
  it('1st/3rd and every Saturday', () => {
    expect(isWeeklyOff('2026-11-07', { ...S, saturdayOff: '1st_3rd' })).toBe(true);
    expect(isWeeklyOff('2026-11-14', { ...S, saturdayOff: '1st_3rd' })).toBe(false);
    expect(isWeeklyOff('2026-11-07', { ...S, weeklyOff: [0, 6] })).toBe(true);
  });
});

describe('leave days', () => {
  it('skip offs and holidays; half days count 0.5', () => {
    expect(leaveDays('2026-11-13', '2026-11-16', false, S, new Set())).toBe(2); // Fri, 2nd Sat off, Sun off, Mon
    expect(leaveDays('2026-11-13', '2026-11-16', false, S, new Set(['2026-11-16']))).toBe(1);
    expect(leaveDays('2026-11-12', '2026-11-12', true, S, new Set())).toBe(0.5);
    expect(leaveDays('2026-11-15', '2026-11-15', false, S, new Set())).toBe(0);
  });
});

describe('leave year and entitlement', () => {
  it('April to March years', () => {
    expect(leaveYear('2027-02-10', 4)).toEqual({ label: 2026, from: '2026-04-01', to: '2027-03-31' });
    expect(leaveYear('2026-04-01', 4).label).toBe(2026);
    expect(leaveYear('2026-12-31', 1)).toEqual({ label: 2026, from: '2026-01-01', to: '2026-12-31' });
  });
  const y = { from: '2026-01-01', to: '2026-12-31' };
  it('yearly leave is pro-rated for mid-year joiners', () => {
    expect(entitlement({ yearlyDays: 12, accrual: 'yearly' }, y, '2020-05-01', '2026-02-01')).toBe(12);
    expect(entitlement({ yearlyDays: 12, accrual: 'yearly' }, y, '2026-07-10', '2026-07-10')).toBe(6);
    expect(entitlement({ yearlyDays: 12, accrual: 'yearly' }, y, '2026-07-20', '2026-07-20')).toBe(5);
    expect(entitlement({ yearlyDays: 7, accrual: 'yearly' }, y, '2026-07-01', '2026-07-01')).toBe(3.5);
    expect(entitlement({ yearlyDays: 12, accrual: 'yearly' }, y, '2027-01-05', '2026-07-01')).toBe(0);
  });
  it('monthly leave builds up month by month', () => {
    expect(entitlement({ yearlyDays: 15, accrual: 'monthly' }, y, '2020-01-01', '2026-01-15')).toBe(1);
    expect(entitlement({ yearlyDays: 15, accrual: 'monthly' }, y, '2020-01-01', '2026-04-02')).toBe(5);
    expect(entitlement({ yearlyDays: 15, accrual: 'monthly' }, y, '2020-01-01', '2027-03-01')).toBe(15);
  });
});

describe('day status', () => {
  const at = (d: string, t: string) => istInstant(d, t);
  const base = { today: '2026-11-20', settings: S };
  it('full, half, short and late days', () => {
    expect(dayStatus({ ...base, day: '2026-11-19', checkInAt: at('2026-11-19', '09:40'), checkOutAt: at('2026-11-19', '18:30') })).toMatchObject({ kind: 'present', late: false, payable: 1, lop: 0 });
    expect(dayStatus({ ...base, day: '2026-11-19', checkInAt: at('2026-11-19', '09:46'), checkOutAt: at('2026-11-19', '18:30') }).late).toBe(true);
    expect(dayStatus({ ...base, day: '2026-11-19', checkInAt: at('2026-11-19', '10:00'), checkOutAt: at('2026-11-19', '15:00') })).toMatchObject({ kind: 'half_day', payable: 0.5, lop: 0.5 });
    expect(dayStatus({ ...base, day: '2026-11-19', checkInAt: at('2026-11-19', '10:00'), checkOutAt: at('2026-11-19', '12:00') })).toMatchObject({ kind: 'absent', lop: 1 });
  });
  it('no record is absent in the past, waiting today and in the future', () => {
    expect(dayStatus({ ...base, day: '2026-11-18' }).kind).toBe('absent');
    expect(dayStatus({ ...base, day: '2026-11-20' }).kind).toBe('upcoming');
    expect(dayStatus({ ...base, day: '2026-11-20', checkInAt: at('2026-11-20', '09:00') }).kind).toBe('open');
    expect(dayStatus({ ...base, day: '2026-11-23' }).kind).toBe('upcoming');
  });
  it('a missed check-out counts but is flagged', () => {
    expect(dayStatus({ ...base, day: '2026-11-19', checkInAt: at('2026-11-19', '09:00') })).toMatchObject({ kind: 'present', missedCheckout: true, payable: 1 });
  });
  it('offs, holidays, leave and corrections', () => {
    expect(dayStatus({ ...base, day: '2026-11-15' })).toMatchObject({ kind: 'weekly_off', payable: 1 });
    expect(dayStatus({ ...base, day: '2026-11-18', holiday: true })).toMatchObject({ kind: 'holiday', payable: 1 });
    expect(dayStatus({ ...base, day: '2026-11-18', leave: 1 })).toMatchObject({ kind: 'leave', payable: 1 });
    expect(dayStatus({ ...base, day: '2026-11-18', leave: 1, leavePaid: false })).toMatchObject({ kind: 'leave', payable: 0, lop: 1 });
    expect(dayStatus({ ...base, day: '2026-11-18', leave: 0.5, checkInAt: at('2026-11-18', '14:00'), checkOutAt: at('2026-11-18', '18:30') })).toMatchObject({ kind: 'half_leave', payable: 1, lop: 0 });
    expect(dayStatus({ ...base, day: '2026-11-18', leave: 0.5 })).toMatchObject({ kind: 'half_leave', payable: 0.5, lop: 0.5 });
    expect(dayStatus({ ...base, day: '2026-11-18', override: 'on_duty' })).toMatchObject({ kind: 'present', payable: 1 });
    expect(dayStatus({ ...base, day: '2026-11-18', employed: false }).kind).toBe('not_employed');
  });
  it('month totals', () => {
    const t = monthTotals([
      { ...dayStatus({ ...base, day: '2026-11-18', leave: 1, leavePaid: false }), leavePaid: false },
      dayStatus({ ...base, day: '2026-11-17' }),
      dayStatus({ ...base, day: '2026-11-15' }),
    ]);
    expect(t).toMatchObject({ unpaidLeave: 1, absent: 1, weeklyOffs: 1, payable: 1, lop: 2 });
  });
  it('helpers', () => {
    expect(monthDays('2028-02').length).toBe(29);
    expect(isDay('2026-02-30')).toBe(false);
  });
});
