// Scheduled report emails and API templates (outgoing calls with placeholders).
import { addDays, istClock, istInstant, weekday } from './attendance';

export interface ScheduleRule { frequency: 'daily' | 'weekly' | 'monthly'; time: string; weekday?: number | null; monthDay?: number | null }

/** The next IST moment after `after` that matches the rule (daily at a time, a weekday, or a day of the month up to the 28th). */
export function nextRun(rule: ScheduleRule, after: Date): Date {
  let day = istClock(after).day;
  for (let i = 0; i < 400; i++, day = addDays(day, 1)) {
    const ok = rule.frequency === 'daily' || (rule.frequency === 'weekly' && weekday(day) === (rule.weekday ?? 1)) || (rule.frequency === 'monthly' && Number(day.slice(8)) === (rule.monthDay ?? 1));
    if (!ok) continue;
    const at = istInstant(day, rule.time);
    if (at > after) return at;
  }
  throw new Error('No next run');
}

export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;
export const API_PLACEHOLDERS: [string, string][] = [
  ['lead.id', 'Lead ID'], ['lead.name', 'Customer name'], ['lead.mobile', 'Mobile'], ['lead.email', 'Email'], ['lead.city', 'City'], ['lead.source', 'Source'],
  ['lead.stage', 'Stage'], ['lead.status', 'Status'], ['lead.owner', 'Owner name'], ['lead.ownerEmail', 'Owner email'], ['lead.cf.<key>', 'A custom field'], ['org.name', 'Organization name'],
];

/**
 * Fills {placeholders} in a template. In a URL values are URL-encoded; in a JSON body they are escaped so quotes in a
 * customer's name cannot break the JSON. Unknown placeholders become empty.
 */
export function fillTemplate(text: string, values: Record<string, string>, mode: 'url' | 'json' | 'text'): string {
  return text.replace(/\{([a-zA-Z][\w.]*)\}/g, (_, key: string) => {
    const v = values[key] ?? '';
    if (mode === 'url') return encodeURIComponent(v);
    if (mode === 'json') return JSON.stringify(v).slice(1, -1);
    return v;
  });
}
