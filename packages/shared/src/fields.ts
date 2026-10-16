// Custom lead fields per workspace: definitions, key generation and value validation.
// Used by the API (authoritative) and the web form (instant feedback).

export const FIELD_TYPES = {
  text: 'Short text',
  textarea: 'Long text',
  number: 'Number',
  currency: 'Amount (₹)',
  date: 'Date',
  dropdown: 'Dropdown (pick one)',
  multiselect: 'Multi-select (pick many)',
  checkbox: 'Yes / No',
  phone: 'Phone',
  email: 'Email',
  url: 'Website link',
} as const;
export type FieldType = keyof typeof FIELD_TYPES;
export const FIELD_TYPE_KEYS = Object.keys(FIELD_TYPES) as FieldType[];

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType | string;
  options: string[];
  required: boolean;
  isArchived?: boolean;
}

export type FieldValue = string | number | boolean | string[] | null;

/** "Property Type (Residential?)" → "property_type_residential" */
export function fieldKey(label: string, taken: string[] = []): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
  let key = /^[a-z]/.test(base) ? base : `f_${base}`;
  for (let i = 2; taken.includes(key); i++) key = `${base.slice(0, 36)}_${i}`;
  return key;
}

const isBlank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Validates and normalises custom-field values against the workspace's definitions.
 * - Unknown keys and archived fields are dropped (archived values already stored are kept by the caller).
 * - Required fields must be present (unless `partial`, used for edits that only touch some fields).
 */
export function validateCustomFields(
  defs: FieldDef[],
  input: Record<string, unknown> | null | undefined,
  opts: { partial?: boolean } = {},
): { values: Record<string, FieldValue>; errors: Record<string, string> } {
  const values: Record<string, FieldValue> = {};
  const errors: Record<string, string> = {};
  const data = input ?? {};

  for (const d of defs) {
    if (d.isArchived) continue;
    const present = Object.prototype.hasOwnProperty.call(data, d.key);
    const raw = data[d.key];
    if (isBlank(raw)) {
      if (d.required && (!opts.partial || present)) errors[d.key] = `${d.label} is required`;
      else if (present) values[d.key] = null;
      continue;
    }
    switch (d.type) {
      case 'text':
      case 'textarea': {
        const s = String(raw).trim();
        const max = d.type === 'text' ? 200 : 4000;
        if (s.length > max) errors[d.key] = `${d.label} is too long (max ${max} characters)`;
        else values[d.key] = s;
        break;
      }
      case 'number':
      case 'currency': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s₹]/g, ''));
        if (!Number.isFinite(n)) errors[d.key] = `${d.label} must be a number`;
        else if (d.type === 'currency' && n < 0) errors[d.key] = `${d.label} cannot be negative`;
        else values[d.key] = d.type === 'currency' ? Math.round(n * 100) / 100 : n;
        break;
      }
      case 'date': {
        const s = String(raw).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) errors[d.key] = `${d.label} must be a date (YYYY-MM-DD)`;
        else values[d.key] = s;
        break;
      }
      case 'dropdown': {
        const s = String(raw);
        if (!d.options.includes(s)) errors[d.key] = `${d.label}: choose one of the listed options`;
        else values[d.key] = s;
        break;
      }
      case 'multiselect': {
        const arr = (Array.isArray(raw) ? raw : [raw]).map(String);
        const bad = arr.filter((x) => !d.options.includes(x));
        if (bad.length) errors[d.key] = `${d.label}: unknown option(s) ${bad.join(', ')}`;
        else values[d.key] = [...new Set(arr)];
        break;
      }
      case 'checkbox': {
        if (typeof raw === 'boolean') values[d.key] = raw;
        else if (['true', 'yes', '1'].includes(String(raw).toLowerCase())) values[d.key] = true;
        else if (['false', 'no', '0'].includes(String(raw).toLowerCase())) values[d.key] = false;
        else errors[d.key] = `${d.label} must be yes or no`;
        break;
      }
      case 'phone': {
        const digits = String(raw).replace(/[^\d+]/g, '');
        if (digits.replace('+', '').length < 7 || digits.length > 16) errors[d.key] = `${d.label} must be a valid phone number`;
        else values[d.key] = digits;
        break;
      }
      case 'email': {
        const s = String(raw).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) errors[d.key] = `${d.label} must be a valid email`;
        else values[d.key] = s;
        break;
      }
      case 'url': {
        const s = String(raw).trim();
        const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
        try {
          new URL(withScheme);
          values[d.key] = withScheme;
        } catch {
          errors[d.key] = `${d.label} must be a valid link`;
        }
        break;
      }
      default:
        values[d.key] = String(raw);
    }
  }
  return { values, errors };
}
