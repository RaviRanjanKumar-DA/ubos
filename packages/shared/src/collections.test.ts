import { describe, expect, it } from 'vitest';
import { ageBucket, daysPastDue, nextInstalmentDue, reminderStageFor } from './collections';

describe('days past due', () => {
  it('counts IST calendar days', () => {
    // 11:59 pm and 12:01 am IST on either side of midnight are one day apart.
    expect(daysPastDue(new Date('2026-11-09T18:29:00Z'), new Date('2026-11-09T18:31:00Z'))).toBe(1);
    expect(daysPastDue(new Date('2026-11-09T18:31:00Z'), new Date('2026-11-10T18:00:00Z'))).toBe(0);
  });
  it('is negative before the due date', () => expect(daysPastDue(new Date('2026-11-12T06:00:00Z'), new Date('2026-11-09T06:00:00Z'))).toBe(-3));
});

describe('ageing', () => {
  const now = new Date('2026-11-09T06:00:00Z');
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  it('sorts by age', () => {
    expect(ageBucket(null, now)).toBe('notDue');
    expect(ageBucket(ago(0), now)).toBe('notDue');
    expect(ageBucket(ago(1), now)).toBe('d1to30');
    expect(ageBucket(ago(30), now)).toBe('d1to30');
    expect(ageBucket(ago(31), now)).toBe('d31to60');
    expect(ageBucket(ago(61), now)).toBe('d61to90');
    expect(ageBucket(ago(91), now)).toBe('d90plus');
  });
});

describe('reminder stages', () => {
  it('moves up on the set days', () => {
    expect(reminderStageFor(-4)).toBe(0);
    expect(reminderStageFor(-3)).toBe(1);
    expect(reminderStageFor(0)).toBe(2);
    expect(reminderStageFor(3)).toBe(3);
    expect(reminderStageFor(20)).toBe(5);
  });
});

describe('next instalment', () => {
  const plan = [{ dueAt: new Date('2026-12-01'), amountPaise: 300 }, { dueAt: new Date('2026-11-01'), amountPaise: 100 }];
  it('skips what is covered', () => {
    expect(nextInstalmentDue(plan, 0)).toEqual(new Date('2026-11-01'));
    expect(nextInstalmentDue(plan, 99)).toEqual(new Date('2026-11-01'));
    expect(nextInstalmentDue(plan, 100)).toEqual(new Date('2026-12-01'));
    expect(nextInstalmentDue(plan, 400)).toBeNull();
  });
});
