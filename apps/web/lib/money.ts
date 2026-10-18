/** ₹ amount from paise, Indian grouping. */
export const inr = (paise: number | null | undefined, digits = 0) =>
  `₹${((paise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`;

/** Paise from a rupee amount typed by the user (empty → null). */
export const toPaise = (rupees: string | number) => {
  const n = Number(rupees);
  return Number.isFinite(n) && String(rupees).trim() !== '' ? Math.round(n * 100) : null;
};

export const QUOTE_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'grey' },
  pending_approval: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved — ready to send', tone: '' },
  sent: { label: 'Sent', tone: '' },
  accepted: { label: 'Accepted', tone: 'ok' },
  rejected: { label: 'Declined', tone: 'bad' },
};
