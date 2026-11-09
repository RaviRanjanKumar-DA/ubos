/** GST helpers shared by the API, the web app and tests. Money is always whole paise. Rates are basis points: 18% = 1800. */

export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

export const GST_RATES_BP = [0, 25, 300, 500, 1200, 1800, 2800, 4000] as const;

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Checks the format, the state code and the check digit of a GSTIN. */
export function validGstin(value: string) {
  const g = value.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) || !GST_STATES[g.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = ALPHABET.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36] === g[14];
}

/** "26-27" for the Indian financial year (April to March) that this moment falls in, in IST. */
export function financialYear(d: Date) {
  const [y, m] = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

export interface GstLineInput { qty: number; unitPaise: number; discountPaise: number; gstBp: number }
export interface GstLine { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }

/** Inside the seller's state tax splits equally into CGST and SGST; otherwise it is IGST. An unregistered seller charges none. */
export function computeLine(l: GstLineInput, o: { intraState: boolean; registered: boolean }): GstLine {
  const taxablePaise = l.qty * l.unitPaise - l.discountPaise;
  const rate = o.registered ? l.gstBp : 0;
  const half = Math.round((taxablePaise * rate) / 20000);
  const cgstPaise = o.intraState ? half : 0;
  const sgstPaise = o.intraState ? half : 0;
  const igstPaise = o.intraState ? 0 : Math.round((taxablePaise * rate) / 10000);
  return { taxablePaise, cgstPaise, sgstPaise, igstPaise, totalPaise: taxablePaise + cgstPaise + sgstPaise + igstPaise };
}

export function computeInvoice(items: GstLineInput[], o: { intraState: boolean; registered: boolean }) {
  const lines = items.map((l) => computeLine(l, o));
  const sum = (f: (l: GstLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  const exact = sum((l) => l.totalPaise);
  const totalPaise = Math.round(exact / 100) * 100;
  return {
    lines, subtotalPaise: items.reduce((s, l) => s + l.qty * l.unitPaise, 0), discountPaise: items.reduce((s, l) => s + l.discountPaise, 0),
    taxablePaise: sum((l) => l.taxablePaise), cgstPaise: sum((l) => l.cgstPaise), sgstPaise: sum((l) => l.sgstPaise), igstPaise: sum((l) => l.igstPaise), roundOffPaise: totalPaise - exact, totalPaise,
  };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const upTo99 = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const upTo999 = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? upTo99(n % 100) : ''].filter(Boolean).join(' ');

/** "Rupees One Lakh Twenty Thousand Only", in the Indian number system. */
export function amountInWords(paise: number) {
  const rupees = Math.floor(Math.abs(paise) / 100), rest = Math.abs(paise) % 100;
  const crore = Math.floor(rupees / 10_000_000), lakh = Math.floor((rupees % 10_000_000) / 100_000), thousand = Math.floor((rupees % 100_000) / 1000), hundreds = rupees % 1000;
  const words = [crore ? `${upTo999(crore)} Crore` : '', lakh ? `${upTo99(lakh)} Lakh` : '', thousand ? `${upTo99(thousand)} Thousand` : '', hundreds ? upTo999(hundreds) : ''].filter(Boolean).join(' ');
  return `Rupees ${words || 'Zero'}${rest ? ` and ${upTo99(rest)} Paise` : ''} Only`;
}
