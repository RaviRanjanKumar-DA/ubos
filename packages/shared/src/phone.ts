/** Normalises an Indian-default phone number to E.164 (+91XXXXXXXXXX). Returns null if unusable. */
export function normalizeMobile(input: string | null | undefined, defaultCountryCode = '91'): string | null {
  if (!input) return null;
  const hasPlus = input.trim().startsWith('+');
  let digits = input.replace(/\D/g, '');
  if (hasPlus) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 12 && digits.startsWith(defaultCountryCode)) return `+${digits}`;
  return null;
}
