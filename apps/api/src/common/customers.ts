import type { Tx } from '@ubos/database';

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const maskPan = (last4: string | null) => (last4 ? `••••••${last4}` : null);

/**
 * Finds the existing active customer for these identifiers (exact matches only — auto-link rule):
 * main or alternate mobile, then PAN, then email. Merged records are never matched.
 */
export async function findCustomer(tx: Tx, ids: { mobile?: string | null; email?: string | null; panHash?: string | null }) {
  const active = { mergedIntoId: null };
  if (ids.mobile) {
    const byMobile = await tx.customer.findFirst({
      where: { ...active, OR: [{ mobile: ids.mobile }, { alternateMobiles: { has: ids.mobile } }] },
      orderBy: { createdAt: 'asc' },
    });
    if (byMobile) return { customer: byMobile, matchedBy: 'mobile' as const };
  }
  if (ids.panHash) {
    const byPan = await tx.customer.findFirst({ where: { ...active, panHash: ids.panHash }, orderBy: { createdAt: 'asc' } });
    if (byPan) return { customer: byPan, matchedBy: 'pan' as const };
  }
  if (ids.email) {
    const byEmail = await tx.customer.findFirst({
      where: { ...active, email: { equals: ids.email, mode: 'insensitive' } },
      orderBy: { createdAt: 'asc' },
    });
    if (byEmail) return { customer: byEmail, matchedBy: 'email' as const };
  }
  return null;
}

/** Next human-readable customer code (C00001…), counted across all customers including merged ones. */
export async function nextCustomerCode(tx: Tx) {
  // Advisory lock per tenant so two simultaneous creates never get the same code.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('customer-code:' || current_setting('app.tenant_id')))`;
  const last = await tx.customer.findFirst({ orderBy: { code: 'desc' }, select: { code: true } });
  const n = last ? Number(last.code.replace(/\D/g, '')) + 1 : 1;
  return `C${String(n).padStart(5, '0')}`;
}
