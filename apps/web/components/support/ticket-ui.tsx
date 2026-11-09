'use client';

export interface Sla { first: string; resolution: string; overdue: boolean }
export interface TicketRow {
  id: string; number: number; subject: string; status: string; priority: string; category: string | null; customerId: string; customerName: string; assigneeId: string | null; assignee: string | null; sla: Sla; resolutionDueAt: string; createdAt: string;
}
export const STATUS: Record<string, string> = { open: 'Open', pending: 'Waiting on customer', resolved: 'Resolved', closed: 'Closed' };
export const PRIORITY: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const PRIORITY_TONE: Record<string, string> = { low: 'grey', normal: '', high: 'warn', urgent: 'bad' };
export const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** One plain label for where a ticket stands against its targets. */
export function SlaBadge({ sla, status }: { sla: Sla; status: string }) {
  if (status === 'resolved' || status === 'closed') return sla.resolution === 'met' ? <span className="badge ok">Met</span> : <span className="badge bad">Missed</span>;
  if (sla.overdue) return <span className="badge bad">Past target</span>;
  if (sla.resolution === 'paused') return <span className="badge grey">Clock stopped</span>;
  if (sla.resolution === 'at_risk') return <span className="badge warn">Due soon</span>;
  return <span className="badge ok">On time</span>;
}
