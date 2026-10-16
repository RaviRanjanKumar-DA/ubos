import { describe, expect, it } from 'vitest';
import { fieldKey, FieldDef, validateCustomFields } from './fields';

const defs: FieldDef[] = [
  { key: 'property_type', label: 'Property type', type: 'dropdown', options: ['Home', 'Office', 'Shop'], required: true },
  { key: 'budget', label: 'Budget', type: 'currency', options: [], required: false },
  { key: 'visit_date', label: 'Visit date', type: 'date', options: [], required: false },
  { key: 'services', label: 'Services', type: 'multiselect', options: ['Logo', 'Brochure', 'Website'], required: false },
  { key: 'gst_registered', label: 'GST registered', type: 'checkbox', options: [], required: false },
  { key: 'website', label: 'Website', type: 'url', options: [], required: false },
  { key: 'old_field', label: 'Old', type: 'text', options: [], required: true, isArchived: true },
];

describe('validateCustomFields', () => {
  it('accepts and normalises valid values', () => {
    const r = validateCustomFields(defs, {
      property_type: 'Office', budget: '₹1,25,000.50', visit_date: '2026-11-02T10:00:00Z',
      services: ['Logo', 'Logo', 'Website'], gst_registered: 'yes', website: 'example.com', unknown: 'x',
    });
    expect(r.errors).toEqual({});
    expect(r.values).toEqual({
      property_type: 'Office', budget: 125000.5, visit_date: '2026-11-02', services: ['Logo', 'Website'],
      gst_registered: true, website: 'https://example.com',
    });
  });

  it('reports required, wrong option, bad number and bad date', () => {
    const r = validateCustomFields(defs, { budget: 'abc', visit_date: '02/11/2026', services: ['Logo', 'Video'] });
    expect(Object.keys(r.errors).sort()).toEqual(['budget', 'property_type', 'services', 'visit_date']);
  });

  it('ignores archived fields, even when required', () => {
    expect(validateCustomFields(defs, { property_type: 'Home' }).errors.old_field).toBeUndefined();
  });

  it('partial mode only checks fields that are sent', () => {
    expect(validateCustomFields(defs, { budget: 5000 }, { partial: true }).errors).toEqual({});
    expect(validateCustomFields(defs, { property_type: '' }, { partial: true }).errors.property_type).toBeDefined();
  });

  it('refuses negative amounts', () => {
    expect(validateCustomFields(defs, { property_type: 'Home', budget: -1 }).errors.budget).toBeDefined();
  });
});

describe('fieldKey', () => {
  it('builds stable machine keys and avoids clashes', () => {
    expect(fieldKey('Property Type (Residential?)')).toBe('property_type_residential');
    expect(fieldKey('2nd phone')).toBe('f_2nd_phone');
    expect(fieldKey('City', ['city'])).toBe('city_2');
    expect(fieldKey('!!!')).toBe('field');
  });
});
