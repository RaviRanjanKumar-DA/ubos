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
  statuses: Option[];
  dispositions: (Option & { connected: boolean })[];
  assignment: { mode: 'round_robin' | 'creator' | 'fixed'; userIds: string[]; sticky: boolean };
}

export const STATUS_TONE: Record<string, string> = { hot: 'bad', warm: 'warn', cold: 'grey', fresh: '' };

/** "in 2 h", "3 days ago" — short relative time for lists. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const fmt = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`;
  const v = abs < 3_600_000 ? fmt(Math.max(1, Math.round(abs / 60_000)), 'min') : abs < 86_400_000 ? fmt(Math.round(abs / 3_600_000), 'hour') : fmt(Math.round(abs / 86_400_000), 'day');
  return diff >= 0 ? `in ${v}` : `${v} ago`;
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
