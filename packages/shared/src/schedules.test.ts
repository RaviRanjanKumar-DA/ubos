import { describe, expect, it } from 'vitest';
import { fillTemplate, nextRun } from './schedules';

// 22 Nov 2026 is a Sunday; 10:00 IST = 04:30Z
const at = (s: string) => new Date(s);

describe('schedules', () => {
  it('daily runs later today, or tomorrow once the time has passed', () => {
    expect(nextRun({ frequency: 'daily', time: '18:00' }, at('2026-11-22T04:30:00Z')).toISOString()).toBe('2026-11-22T12:30:00.000Z');
    expect(nextRun({ frequency: 'daily', time: '09:00' }, at('2026-11-22T04:30:00Z')).toISOString()).toBe('2026-11-23T03:30:00.000Z');
  });
  it('weekly runs on the chosen weekday', () => {
    expect(nextRun({ frequency: 'weekly', time: '09:00', weekday: 1 }, at('2026-11-22T04:30:00Z')).toISOString()).toBe('2026-11-23T03:30:00.000Z');
    expect(nextRun({ frequency: 'weekly', time: '09:00', weekday: 0 }, at('2026-11-22T04:30:00Z')).toISOString()).toBe('2026-11-29T03:30:00.000Z');
  });
  it('monthly runs on the chosen day', () => {
    expect(nextRun({ frequency: 'monthly', time: '08:00', monthDay: 1 }, at('2026-11-22T04:30:00Z')).toISOString()).toBe('2026-12-01T02:30:00.000Z');
    expect(nextRun({ frequency: 'monthly', time: '23:00', monthDay: 22 }, at('2026-11-22T04:30:00Z')).toISOString()).toBe('2026-11-22T17:30:00.000Z');
  });
  it('fills placeholders safely', () => {
    const v = { 'lead.name': 'Ravi "R" Kumar', 'lead.mobile': '+919876543210' };
    expect(fillTemplate('https://x.test/?m={lead.mobile}', v, 'url')).toBe('https://x.test/?m=%2B919876543210');
    expect(JSON.parse(fillTemplate('{"name":"{lead.name}","x":"{nope}"}', v, 'json'))).toEqual({ name: 'Ravi "R" Kumar', x: '' });
    expect(fillTemplate('Hi {lead.name}', v, 'text')).toBe('Hi Ravi "R" Kumar');
  });
});
