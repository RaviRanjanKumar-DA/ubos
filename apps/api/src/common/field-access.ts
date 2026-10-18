import type { Tx } from '@ubos/database';
import { ADMIN_ROLE } from '@ubos/shared';
import { auth } from './context';

/**
 * Field-level security for lead / customer data. Rules are set per role and per field:
 *   editable (default) > read (cannot change) > masked (partly hidden) > hidden.
 * With several roles the most open rule wins, and a role without a rule for a field leaves it editable.
 * Fields: "mobile", "email" (customer contact) and "cf:<key>" (custom lead fields).
 */
export type Visibility = 'editable' | 'read' | 'masked' | 'hidden';
const RANK: Record<Visibility, number> = { hidden: 0, masked: 1, read: 2, editable: 3 };
export const RULE_FIELDS_BUILT_IN = ['mobile', 'email'];

export interface FieldAccess {
  of(field: string): Visibility;
  /** True when nothing is restricted (admins, roles without rules) — callers can skip work. */
  open: boolean;
}

export async function fieldAccess(tx: Tx): Promise<FieldAccess> {
  const a = auth();
  const names = [...new Set(a.assignments.map((x) => x.roleName))];
  if (names.includes(ADMIN_ROLE)) return { of: () => 'editable', open: true };
  const roles = await tx.role.findMany({ where: { name: { in: names } }, include: { fieldRules: { where: { entity: 'lead' } } } });
  if (!roles.length || roles.some((r) => !r.fieldRules.length)) return { of: () => 'editable', open: true };
  const of = (field: string): Visibility => {
    let best: Visibility = 'hidden';
    for (const r of roles) {
      const rule = r.fieldRules.find((x) => x.field === field);
      const v = (rule?.visibility as Visibility | undefined) ?? 'editable';
      if (RANK[v] > RANK[best]) best = v;
    }
    return best;
  };
  return { of, open: false };
}

export function maskMobile(m: string | null | undefined) {
  if (!m) return m ?? null;
  const d = m.replace(/\D/g, '');
  return d.length <= 4 ? '••••' : `${m.startsWith('+') ? '+' : ''}${d.slice(0, Math.min(4, d.length - 3))}•••••${d.slice(-3)}`;
}
export function maskEmail(e: string | null | undefined) {
  if (!e) return e ?? null;
  const [u, dom] = e.split('@');
  return `${u.slice(0, 1)}•••@${dom ?? ''}`;
}
function maskText(v: unknown) {
  const s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return s ? `${s.slice(0, 1)}•••` : s;
}

/** Applies the rules to a contact value. */
export function contact(fa: FieldAccess, field: 'mobile' | 'email', value: string | null | undefined): string | null {
  const v = fa.of(field);
  if (v === 'hidden') return null;
  if (v === 'masked') return field === 'mobile' ? maskMobile(value) : maskEmail(value);
  return value ?? null;
}
export function contacts(fa: FieldAccess, field: 'mobile' | 'email', values: string[]): string[] {
  const v = fa.of(field);
  if (v === 'hidden') return [];
  return v === 'masked' ? values.map((x) => (field === 'mobile' ? maskMobile(x) : maskEmail(x)) ?? '') : values;
}

/** Applies the rules to custom field values. */
export function customFields(fa: FieldAccess, values: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(values ?? {})) {
    const v = fa.of(`cf:${k}`);
    if (v === 'hidden') continue;
    out[k] = v === 'masked' ? maskText(val) : val;
  }
  return out;
}

/** Fields the user may not change (read, masked or hidden). */
export function lockedFields(fa: FieldAccess, keys: string[]) {
  return fa.open ? [] : keys.filter((k) => fa.of(k) !== 'editable');
}
