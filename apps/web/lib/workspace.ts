// Shared types for workspace settings (used by the settings page and the lead forms).

export interface Stage { id?: string; name: string; isWon: boolean; isLost: boolean; leadCount?: number }
export interface Pipeline { id: string; name: string; stages: Stage[] }
export interface Field { id: string; key: string; label: string; type: string; options: string[]; required: boolean; isArchived: boolean }
export interface Option { id?: string; value?: string; label: string }

export interface WorkspaceSettings {
  id: string;
  name: string;
  template: string | null;
  isArchived: boolean;
  canManage: boolean;
  pipelines: Pipeline[];
  fields: Field[];
  sources: Option[];
  lostReasons: Option[];
}

export const FIELD_TYPE_LABELS: Record<string, string> = {
  text: 'Short text', textarea: 'Long text', number: 'Number', currency: 'Amount (₹)', date: 'Date',
  dropdown: 'Dropdown (pick one)', multiselect: 'Multi-select (pick many)', checkbox: 'Yes / No',
  phone: 'Phone', email: 'Email', url: 'Website link',
};

/** Human-readable value for tables. */
export function showValue(f: Field | undefined, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.join(', ');
  if (f?.type === 'checkbox') return v ? 'Yes' : 'No';
  if (f?.type === 'currency') return '₹' + Number(v).toLocaleString('en-IN');
  if (f?.type === 'date') return new Date(String(v)).toLocaleDateString('en-IN');
  return String(v);
}
