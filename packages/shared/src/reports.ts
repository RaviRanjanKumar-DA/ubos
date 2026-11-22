// The Reports hub: every report type, what it shows, and whether it lists individual leads (downloading those needs "Export leads").

export type ReportKey = 'leaderboard' | 'calls' | 'call_log' | 'leads' | 'tasks' | 'sales' | 'actions' | 'duplicates' | 'facebook';
export interface ReportDef { key: ReportKey | string; title: string; group: 'Team' | 'Leads' | 'Calls' | 'Sales' | 'AI'; description: string; detail: boolean; ready: boolean }

export const REPORTS: ReportDef[] = [
  { key: 'leaderboard', title: 'Leaderboard', group: 'Team', description: 'Each person: leads, calls, connect rate, talk time, wins, value and follow-ups.', detail: false, ready: true },
  { key: 'actions', title: 'Actions', group: 'Team', description: 'What each person did: calls, remarks, stage moves, follow-ups and custom actions.', detail: false, ready: true },
  { key: 'tasks', title: 'Tasks', group: 'Team', description: 'Tasks due in the period, done, open and overdue, by person.', detail: true, ready: true },
  { key: 'calls', title: 'Call report', group: 'Calls', description: 'Each person: calls made and received, answered, missed, talk time.', detail: false, ready: true },
  { key: 'call_log', title: 'Call log', group: 'Calls', description: 'Every call with time, person, number, lead, duration and outcome.', detail: true, ready: true },
  { key: 'leads', title: 'Leads', group: 'Leads', description: 'All leads with stage, status, owner, source, score and dates.', detail: true, ready: true },
  { key: 'duplicates', title: 'Duplicate leads', group: 'Leads', description: 'Repeat enquiries from people already in UBOS, and customers with more than one open lead.', detail: true, ready: true },
  { key: 'facebook', title: 'Facebook data', group: 'Leads', description: 'Leads from Facebook and Instagram lead forms with every answer.', detail: true, ready: true },
  { key: 'sales', title: 'Sales', group: 'Sales', description: 'Leads won in the period with value, invoiced and received amounts.', detail: true, ready: true },
  { key: 'deleted', title: 'Deleted leads', group: 'Leads', description: 'Leads that were deleted, who deleted them and when; restore them.', detail: true, ready: true },
  { key: 'ai_insights', title: 'AI insights', group: 'AI', description: 'Plain-language findings about the pipeline and the team.', detail: false, ready: false },
  { key: 'call_summaries', title: 'Call summarization', group: 'AI', description: 'Short summaries of recorded calls.', detail: true, ready: false },
];

export interface ReportColumn { key: string; label: string; format?: 'count' | 'number' | 'percent' | 'currency' | 'datetime' | 'date' | 'minutes' | 'text' }
export interface ReportResult { key: string; title: string; period: { from: string; to: string; label: string }; columns: ReportColumn[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown>; truncated?: boolean }

/** One CSV cell as text, the way people expect to read it in Excel (IST dates, rupees, percent). */
export function reportCell(v: unknown, format: ReportColumn['format'], tz = 'Asia/Kolkata') {
  if (v === null || v === undefined || v === '') return '';
  if (format === 'currency') return (Number(v) / 100).toFixed(2);
  if (format === 'percent') return `${v}%`;
  if (format === 'datetime') return new Date(String(v)).toLocaleString('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
  if (format === 'date') return new Date(String(v)).toLocaleDateString('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
  return String(v);
}
