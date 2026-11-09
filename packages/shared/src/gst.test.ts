import { describe, expect, it } from 'vitest';
import { amountInWords, computeInvoice, computeLine, financialYear, validGstin } from './gst';

describe('GSTIN', () => {
  it('accepts valid numbers', () => { expect(validGstin('27AAPFU0939F1ZV')).toBe(true); expect(validGstin('29GGGGG1314R9ZA')).toBe(true); expect(validGstin('27aapfu0939f1zv')).toBe(true); });
  it('refuses a wrong check digit, format or state', () => { expect(validGstin('27AAPFU0939F1ZA')).toBe(false); expect(validGstin('27AAPFU0939')).toBe(false); expect(validGstin('99AAPFU0939F1ZV')).toBe(false); });
});

describe('financial year', () => {
  it('changes on 1 April in IST', () => {
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toBe('25-26');
    expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('26-27');
    expect(financialYear(new Date('2027-01-15T10:00:00Z'))).toBe('26-27');
  });
});

describe('tax', () => {
  const line = { qty: 2, unitPaise: 50_000, discountPaise: 10_000, gstBp: 1800 };
  it('splits inside the state', () => expect(computeLine(line, { intraState: true, registered: true })).toEqual({ taxablePaise: 90_000, cgstPaise: 8100, sgstPaise: 8100, igstPaise: 0, totalPaise: 106_200 }));
  it('uses IGST across states', () => expect(computeLine(line, { intraState: false, registered: true })).toEqual({ taxablePaise: 90_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 16_200, totalPaise: 106_200 }));
  it('charges nothing when not registered', () => expect(computeLine(line, { intraState: true, registered: false }).totalPaise).toBe(90_000));
  it('rounds the total to the rupee and records the difference', () => {
    const r = computeInvoice([{ qty: 1, unitPaise: 33_333, discountPaise: 0, gstBp: 1800 }], { intraState: true, registered: true });
    expect(r.taxablePaise + r.cgstPaise + r.sgstPaise + r.roundOffPaise).toBe(r.totalPaise);
    expect(r.totalPaise % 100).toBe(0);
  });
});

describe('amount in words', () => {
  it('uses lakh and crore', () => {
    expect(amountInWords(12_000_000)).toBe('Rupees One Lakh Twenty Thousand Only');
    expect(amountInWords(1_250_000_050)).toBe('Rupees One Crore Twenty Five Lakh and Fifty Paise Only');
    expect(amountInWords(99_900)).toBe('Rupees Nine Hundred Ninety Nine Only');
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });
});
