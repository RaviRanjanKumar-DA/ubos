/** UBOS shows and exports every date in IST, whatever clock the server runs on. */
const IST = 'Asia/Kolkata';
/** 2026-11-09 */
export const istDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: IST });
/** 2026-11-09 14:30:05 (spreadsheets read this as a date and time) */
export const istStamp = (d: Date) => d.toLocaleString('sv-SE', { timeZone: IST });
/** 9 Nov 2026, 2:30 pm (messages to people) */
export const istText = (d: Date) => d.toLocaleString('en-IN', { timeZone: IST, dateStyle: 'medium', timeStyle: 'short' });
