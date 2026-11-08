/** UBOS works in IST: what people type and see follows India time, whatever clock their device is on. */
const IST = 'Asia/Kolkata';
const OFFSET = '+05:30';

/** 2026-11-09, the India date of a moment. */
export const istDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: IST });
/** The moment a day starts in India. */
export const istDayStart = (day: string) => new Date(`${day}T00:00:00${OFFSET}`);
/** Value for a datetime-local box, showing India time. */
export const toIstInput = (d: Date) => d.toLocaleString('sv-SE', { timeZone: IST }).slice(0, 16).replace(' ', 'T');
/** Reads a datetime-local box as India time. */
export const fromIstInput = (v: string) => new Date(`${v.slice(0, 16)}:00${OFFSET}`);
/** A given hour in India, some days from today. */
export const istAt = (hour: number, addDays = 0) => new Date(`${istDay(new Date(Date.now() + addDays * 86_400_000))}T${String(hour).padStart(2, '0')}:00:00${OFFSET}`);
