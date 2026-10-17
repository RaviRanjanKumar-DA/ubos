import { describe, expect, it } from 'vitest';
import { guessMapping, parseCsv, parseDateInput, toCsv } from './csv';

describe('parseCsv', () => {
  it('handles quotes, commas inside quotes, escaped quotes, CRLF and BOM', () => {
    const text = '﻿Name,Mobile,Remark\r\n"Sharma, Rohit",98765 00001,"said ""call later"""\r\nPriya,9876500002,\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Mobile', 'Remark'],
      ['Sharma, Rohit', '98765 00001', 'said "call later"'],
      ['Priya', '9876500002', ''],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('round-trips with toCsv', () => {
    const rows = [['x', 'a,b', 'he said "hi"'], ['1', '', 'line\nbreak']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('guessMapping', () => {
  it('maps common header names and custom fields, each target once', () => {
    const map = guessMapping(
      ['Customer Name', 'Phone No.', 'Email ID', 'Property Type', 'Remarks', 'Mobile', 'Unknown'],
      [{ key: 'property_type', label: 'Property type' }],
    );
    expect(map).toEqual(['name', 'mobile', 'email', 'cf:property_type', 'remark', '', '']);
  });
});

describe('parseDateInput', () => {
  it('reads ISO and day-first Indian dates', () => {
    expect(parseDateInput('2026-11-05')?.getDate()).toBe(5);
    const d = parseDateInput('05/11/2026 16:30')!;
    expect([d.getDate(), d.getMonth() + 1, d.getHours(), d.getMinutes()]).toEqual([5, 11, 16, 30]);
    expect(parseDateInput('31/02/2026')).toBeNull();
    expect(parseDateInput('soon')).toBeNull();
  });
});
