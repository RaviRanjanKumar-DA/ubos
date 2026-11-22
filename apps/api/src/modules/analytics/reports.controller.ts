import { BadRequestException, Controller, ForbiddenException, Get, Header, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { REPORTS, reportCell, toCsv, type ReportColumn, type ReportResult } from '@ubos/shared';
import type { Prisma } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { dealValue, leaderboard, leadWhere, loadLookups, resolveRange, type Ctx, type Range } from './engine';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Query_ = z.object({
  range: z.enum(['today', 'yesterday', 'this_week', 'last_7_days', 'last_30_days', 'this_month', 'last_month', 'this_quarter', 'this_year', 'custom']).default('this_month'),
  from: day.optional(), to: day.optional(), workspaceId: z.string().uuid().optional(), ownerId: z.string().uuid().optional(), source: z.string().max(60).optional(),
});
const SHOW = 500, DOWNLOAD = 20_000;
const mins = (sec: number) => Math.round(sec / 60);

/**
 * The Reports hub. Every report runs inside the viewer's "View dashboards" scope; reports that list individual leads
 * can only be downloaded with "Export leads". Downloads are audited.
 */
@Controller('api/v1/reports')
@RequirePermission('dashboard.view')
export class ReportsController {
  constructor(private db: DbService) {}

  @Get()
  catalog() {
    const canExport = !!auth().permissions['crm.lead.export' as never];
    return { reports: REPORTS, canExport };
  }

  @Get(':key')
  show(@Param('key') key: string, @Query() q: unknown) {
    return this.db.tenant((tx) => this.build(tx, key, parse(Query_, q), SHOW), { timeoutMs: 30_000 });
  }

  @Get(':key/download')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async download(@Param('key') key: string, @Query() q: unknown) {
    const def = REPORTS.find((r) => r.key === key);
    if (def?.detail && !auth().permissions['crm.lead.export' as never]) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Downloading lead lists needs "Export leads"' });
    const input = parse(Query_, q);
    return this.db.tenant(async (tx) => {
      const r = await this.build(tx, key, input, DOWNLOAD);
      await this.db.audit(tx, { entity: 'report', entityId: key, action: 'report.downloaded', newValue: { report: key, rows: r.rows.length, period: r.period.label, workspaceId: input.workspaceId ?? null, ownerId: input.ownerId ?? null } });
      const tz = 'Asia/Kolkata';
      // A BOM makes Excel read the rupee sign and Indian names correctly.
      return '﻿' + toCsv([r.columns.map((c) => c.label), ...r.rows.map((row) => r.columns.map((c) => reportCell(row[c.key], c.format, tz)))]);
    }, { timeoutMs: 60_000 });
  }

  private async build(tx: Parameters<Parameters<DbService['tenant']>[0]>[0], key: string, q: z.infer<typeof Query_>, limit: number): Promise<ReportResult> {
    const def = REPORTS.find((r) => r.key === key);
    if (!def) throw new BadRequestException({ code: 'UNKNOWN_REPORT', message: 'Unknown report' });
    if (!def.ready) throw new BadRequestException({ code: 'REPORT_COMING', message: `${def.title} is coming soon` });
    if (q.range === 'custom' && (!q.from || !q.to)) throw new BadRequestException({ code: 'DATES_REQUIRED', message: 'Choose both dates' });
    const L = await loadLookups(tx, tenantId());
    const r = resolveRange(q.range, L.tz, q.from, q.to);
    const c: Ctx = { tx, L, scope: await scopeFilter(tx, 'dashboard.view'), tenantId: tenantId(), auditAllowed: false, filters: { ...(q.workspaceId ? { workspaceIds: [q.workspaceId] } : {}), ...(q.ownerId ? { ownerIds: [q.ownerId] } : {}), ...(q.source ? { sources: [q.source] } : {}) } };
    const period = { from: r.from.toISOString(), to: r.to.toISOString(), label: r.label };
    const range = { gte: r.from, lt: r.to };
    const user = (id: string | null | undefined) => (id ? L.users.get(id) ?? 'Former user' : '—');
    const ws = (id: string) => L.workspaces.get(id)?.name ?? '—';
    const stage = (id: string) => L.stages.get(id)?.name ?? '—';
    const label = (kind: 'lead_status' | 'lead_source' | 'call_disposition', v: string | null) => (v ? L.labels[kind].get(v) ?? v : '');
    const out = (columns: ReportColumn[], rows: Record<string, unknown>[], totals?: Record<string, unknown>): ReportResult => ({ key, title: def.title, period, columns, rows: rows.slice(0, limit), totals, truncated: rows.length > limit });
    const sum = (rows: Record<string, unknown>[], keys: string[]) => Object.fromEntries(keys.map((k) => [k, rows.reduce((a, x) => a + (Number(x[k]) || 0), 0)]));

    switch (key) {
      case 'leaderboard': {
        const rows = (await leaderboard(c, r as Range)) as unknown as Record<string, unknown>[];
        const cols: ReportColumn[] = [
          { key: 'name', label: 'Person', format: 'text' }, { key: 'leads', label: 'New leads', format: 'count' }, { key: 'openLeads', label: 'Open leads', format: 'count' },
          { key: 'calls', label: 'Calls', format: 'count' }, { key: 'connected', label: 'Connected', format: 'count' }, { key: 'connectRate', label: 'Connect rate', format: 'percent' },
          { key: 'talkMinutes', label: 'Talk minutes', format: 'minutes' }, { key: 'won', label: 'Won', format: 'count' }, { key: 'winRate', label: 'Win rate', format: 'percent' },
          { key: 'wonValue', label: 'Won value', format: 'currency' }, { key: 'activities', label: 'Activities', format: 'count' }, { key: 'followupsDone', label: 'Follow-ups done', format: 'count' },
        ];
        return out(cols, rows, { name: 'Total', ...sum(rows, ['leads', 'openLeads', 'calls', 'connected', 'talkMinutes', 'won', 'wonValue', 'activities', 'followupsDone']) });
      }
      case 'actions': {
        const acts = await tx.leadActivity.groupBy({ by: ['userId', 'type'], where: { createdAt: range, userId: { not: null }, lead: leadWhere(c) }, _count: true });
        const TYPES: [string, string][] = [['call', 'Calls'], ['remark', 'Remarks'], ['stage', 'Stage moves'], ['status', 'Status changes'], ['follow_up', 'Follow-ups'], ['custom_action', 'Custom actions'], ['assignment', 'Assignments'], ['message', 'Messages']];
        const known = new Set(TYPES.map(([t]) => t));
        const people = new Map<string, Record<string, unknown>>();
        for (const a of acts) {
          const row = people.get(a.userId!) ?? { name: user(a.userId), total: 0, other: 0, ...Object.fromEntries(TYPES.map(([t]) => [t, 0])) };
          const k = known.has(a.type) ? a.type : 'other';
          row[k] = (row[k] as number) + a._count; row.total = (row.total as number) + a._count;
          people.set(a.userId!, row);
        }
        const rows = [...people.values()].sort((a, b) => (b.total as number) - (a.total as number));
        const cols: ReportColumn[] = [{ key: 'name', label: 'Person', format: 'text' }, ...TYPES.map(([k, l]) => ({ key: k, label: l, format: 'count' as const })), { key: 'other', label: 'Other', format: 'count' }, { key: 'total', label: 'Total', format: 'count' }];
        return out(cols, rows, { name: 'Total', ...sum(rows, [...TYPES.map(([t]) => t), 'other', 'total']) });
      }
      case 'calls': {
        const calls = await tx.leadActivity.findMany({ where: { type: 'call', createdAt: range, lead: leadWhere(c) }, select: { userId: true, connected: true, durationSec: true, data: true } });
        const people = new Map<string, { name: string; total: number; outgoing: number; incoming: number; connected: number; missed: number; notConnected: number; talkSec: number }>();
        for (const x of calls) {
          const k = x.userId ?? '—';
          const p = people.get(k) ?? { name: user(x.userId), total: 0, outgoing: 0, incoming: 0, connected: 0, missed: 0, notConnected: 0, talkSec: 0 };
          const inbound = (x.data as { direction?: string } | null)?.direction === 'inbound';
          p.total++; if (inbound) p.incoming++; else p.outgoing++;
          if (x.connected) { p.connected++; p.talkSec += x.durationSec ?? 0; } else if (inbound) p.missed++; else p.notConnected++;
          people.set(k, p);
        }
        const rows = [...people.values()].map((p) => ({ ...p, talkMinutes: mins(p.talkSec), avgTalk: p.connected ? Math.round(p.talkSec / p.connected) : 0, connectRate: p.total ? Math.round((p.connected / p.total) * 100) : null })).sort((a, b) => b.total - a.total);
        const cols: ReportColumn[] = [
          { key: 'name', label: 'Person', format: 'text' }, { key: 'total', label: 'Calls', format: 'count' }, { key: 'outgoing', label: 'Made', format: 'count' }, { key: 'incoming', label: 'Received', format: 'count' },
          { key: 'connected', label: 'Connected', format: 'count' }, { key: 'notConnected', label: 'Not connected', format: 'count' }, { key: 'missed', label: 'Missed', format: 'count' },
          { key: 'connectRate', label: 'Connect rate', format: 'percent' }, { key: 'talkMinutes', label: 'Talk minutes', format: 'minutes' }, { key: 'avgTalk', label: 'Average talk (seconds)', format: 'number' },
        ];
        return out(cols, rows, { name: 'Total', ...sum(rows, ['total', 'outgoing', 'incoming', 'connected', 'notConnected', 'missed', 'talkMinutes']) });
      }
      case 'call_log': {
        const calls = await tx.leadActivity.findMany({ where: { type: 'call', createdAt: range, lead: leadWhere(c) }, orderBy: { createdAt: 'desc' }, take: limit + 1, select: { createdAt: true, userId: true, connected: true, durationSec: true, disposition: true, remark: true, data: true, lead: { select: { id: true, workspaceId: true, customer: { select: { name: true, mobile: true } } } } } });
        const rows = calls.map((x) => ({ at: x.createdAt, person: user(x.userId), direction: (x.data as { direction?: string } | null)?.direction === 'inbound' ? 'Received' : 'Made', lead: x.lead.customer.name, mobile: x.lead.customer.mobile ?? '', businessLine: ws(x.lead.workspaceId), connected: x.connected ? 'Yes' : 'No', duration: x.durationSec ?? 0, outcome: label('call_disposition', x.disposition), remark: x.remark ?? '', leadId: x.lead.id }));
        return out([{ key: 'at', label: 'Time (IST)', format: 'datetime' }, { key: 'person', label: 'Person' }, { key: 'direction', label: 'Type' }, { key: 'lead', label: 'Lead' }, { key: 'mobile', label: 'Mobile' }, { key: 'businessLine', label: 'Business line' }, { key: 'connected', label: 'Connected' }, { key: 'duration', label: 'Seconds', format: 'number' }, { key: 'outcome', label: 'Outcome' }, { key: 'remark', label: 'Remark' }], rows);
      }
      case 'leads': {
        const leads = await tx.lead.findMany({ where: { AND: [leadWhere(c), { createdAt: range }] }, orderBy: { createdAt: 'desc' }, take: limit + 1, include: { customer: { select: { name: true, mobile: true, email: true, city: true } } } });
        const rows = leads.map((l) => ({ name: l.customer.name, mobile: l.customer.mobile ?? '', email: l.customer.email ?? '', city: l.customer.city ?? '', businessLine: ws(l.workspaceId), source: label('lead_source', l.source), stage: stage(l.stageId), status: label('lead_status', l.status), owner: user(l.ownerId), score: l.score, createdAt: l.createdAt, lastActivityAt: l.lastActivityAt, nextFollowUpAt: l.nextFollowUpAt, leadId: l.id }));
        return out([{ key: 'name', label: 'Name' }, { key: 'mobile', label: 'Mobile' }, { key: 'email', label: 'Email' }, { key: 'city', label: 'City' }, { key: 'businessLine', label: 'Business line' }, { key: 'source', label: 'Source' }, { key: 'stage', label: 'Stage' }, { key: 'status', label: 'Status' }, { key: 'owner', label: 'Owner' }, { key: 'score', label: 'Score', format: 'number' }, { key: 'createdAt', label: 'Created (IST)', format: 'datetime' }, { key: 'lastActivityAt', label: 'Last activity (IST)', format: 'datetime' }, { key: 'nextFollowUpAt', label: 'Next follow-up (IST)', format: 'datetime' }], rows);
      }
      case 'tasks': {
        const now = new Date();
        // Tasks on leads follow the lead scope; tasks without a lead are the viewer's own (or everyone's, organization-wide).
        const all = await tx.task.findMany({ where: { dueAt: range, ...(q.ownerId ? { assigneeId: q.ownerId } : {}), ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}) } as Prisma.TaskWhereInput, orderBy: { dueAt: 'asc' }, take: DOWNLOAD });
        const visible = new Map((await tx.lead.findMany({ where: { AND: [leadWhere(c), { id: { in: [...new Set(all.map((t) => t.leadId!).filter(Boolean))] } }] }, select: { id: true, customer: { select: { name: true } } } })).map((l) => [l.id, l.customer.name]));
        const orgWide = auth().permissions['dashboard.view' as never] === 'ORGANIZATION';
        const tasks = all.filter((t) => (t.leadId ? visible.has(t.leadId) : orgWide || t.assigneeId === auth().userId)).slice(0, limit + 1);
        const leadNames = visible;
        const rows = tasks.map((t) => ({ title: t.title, type: t.type, lead: t.leadId ? leadNames.get(t.leadId) ?? '' : '', assignee: user(t.assigneeId), dueAt: t.dueAt, state: t.doneAt ? (t.doneAt <= t.dueAt ? 'Done on time' : 'Done late') : t.dueAt < now ? 'Overdue' : 'Open', doneAt: t.doneAt, leadId: t.leadId }));
        const count = (s: string) => rows.filter((x) => x.state === s).length;
        return out([{ key: 'title', label: 'Task' }, { key: 'type', label: 'Type' }, { key: 'lead', label: 'Lead' }, { key: 'assignee', label: 'Assigned to' }, { key: 'dueAt', label: 'Due (IST)', format: 'datetime' }, { key: 'state', label: 'State' }, { key: 'doneAt', label: 'Done (IST)', format: 'datetime' }], rows, { title: `${rows.length} tasks`, state: `${count('Done on time') + count('Done late')} done · ${count('Overdue')} overdue · ${count('Open')} open` });
      }
      case 'sales': {
        const won = [...L.stages].filter(([, s]) => s.isWon).map(([id]) => id);
        const leads = await tx.lead.findMany({ where: { AND: [leadWhere(c), { stageId: { in: won }, stageChangedAt: range }] }, orderBy: { stageChangedAt: 'desc' }, take: limit + 1, include: { customer: { select: { name: true, mobile: true } }, invoices: { where: { status: 'issued' }, select: { totalPaise: true, paidPaise: true } } } });
        const rows = leads.map((l) => ({ name: l.customer.name, mobile: l.customer.mobile ?? '', businessLine: ws(l.workspaceId), source: label('lead_source', l.source), owner: user(l.ownerId), wonAt: l.stageChangedAt, dealValue: dealValue(L, l.workspaceId, l.customFields), invoiced: l.invoices.reduce((a, i) => a + i.totalPaise, 0), received: l.invoices.reduce((a, i) => a + i.paidPaise, 0), leadId: l.id }));
        return out([{ key: 'name', label: 'Customer' }, { key: 'mobile', label: 'Mobile' }, { key: 'businessLine', label: 'Business line' }, { key: 'source', label: 'Source' }, { key: 'owner', label: 'Owner' }, { key: 'wonAt', label: 'Won on (IST)', format: 'date' }, { key: 'dealValue', label: 'Deal value', format: 'currency' }, { key: 'invoiced', label: 'Invoiced', format: 'currency' }, { key: 'received', label: 'Received', format: 'currency' }], rows, { name: `${rows.length} won`, ...sum(rows, ['dealValue', 'invoiced', 'received']) });
      }
      case 'duplicates': {
        const repeats = await tx.leadActivity.findMany({ where: { type: 'remark', remark: { startsWith: 'Repeat enquiry' }, createdAt: range, lead: leadWhere(c) }, orderBy: { createdAt: 'desc' }, take: limit + 1, select: { createdAt: true, remark: true, data: true, lead: { select: { id: true, workspaceId: true, ownerId: true, stageId: true, customer: { select: { name: true, mobile: true } } } } } });
        const counts = new Map<string, number>();
        for (const x of repeats) counts.set(x.lead.id, (counts.get(x.lead.id) ?? 0) + 1);
        const rows: Record<string, unknown>[] = repeats.map((x) => ({ at: x.createdAt, kind: 'Repeat enquiry', name: x.lead.customer.name, mobile: x.lead.customer.mobile ?? '', businessLine: ws(x.lead.workspaceId), via: String((x.data as { via?: string } | null)?.via ?? ''), times: counts.get(x.lead.id), stage: stage(x.lead.stageId), owner: user(x.lead.ownerId), leadId: x.lead.id }));
        // Customers with more than one open lead (a new lead added for someone already in UBOS).
        const open = [...L.stages].filter(([, s]) => !s.isWon && !s.isLost).map(([id]) => id);
        const many = await tx.lead.groupBy({ by: ['customerId'], where: { AND: [leadWhere(c), { stageId: { in: open } }] }, _count: true, having: { customerId: { _count: { gt: 1 } } } });
        if (many.length) {
          const extra = await tx.lead.findMany({ where: { AND: [leadWhere(c), { stageId: { in: open }, customerId: { in: many.map((m) => m.customerId) }, createdAt: range }] }, orderBy: { createdAt: 'desc' }, include: { customer: { select: { name: true, mobile: true } } } });
          const per = new Map(many.map((m) => [m.customerId, m._count]));
          rows.push(...extra.map((l) => ({ at: l.createdAt, kind: 'More than one open lead', name: l.customer.name, mobile: l.customer.mobile ?? '', businessLine: ws(l.workspaceId), via: label('lead_source', l.source), times: per.get(l.customerId), stage: stage(l.stageId), owner: user(l.ownerId), leadId: l.id })));
        }
        rows.sort((a, b) => +new Date(String(b.at)) - +new Date(String(a.at)));
        return out([{ key: 'at', label: 'When (IST)', format: 'datetime' }, { key: 'kind', label: 'Why' }, { key: 'name', label: 'Name' }, { key: 'mobile', label: 'Mobile' }, { key: 'businessLine', label: 'Business line' }, { key: 'via', label: 'Came via' }, { key: 'times', label: 'Count', format: 'count' }, { key: 'stage', label: 'Stage' }, { key: 'owner', label: 'Owner' }], rows);
      }
      case 'facebook': {
        const leads = await tx.lead.findMany({ where: { AND: [leadWhere(c), { source: { in: ['facebook', 'instagram'] }, createdAt: range }] }, orderBy: { createdAt: 'desc' }, take: limit + 1, include: { customer: { select: { name: true, mobile: true, email: true, city: true } } } });
        const answerKeys = [...new Set(leads.flatMap((l) => Object.keys((l.customFields ?? {}) as object)))].slice(0, 30);
        const rows = leads.map((l) => ({ createdAt: l.createdAt, name: l.customer.name, mobile: l.customer.mobile ?? '', email: l.customer.email ?? '', city: l.customer.city ?? '', businessLine: ws(l.workspaceId), source: label('lead_source', l.source), owner: user(l.ownerId), stage: stage(l.stageId), leadId: l.id, ...Object.fromEntries(answerKeys.map((k) => [`cf_${k}`, String(((l.customFields ?? {}) as Record<string, unknown>)[k] ?? '')])) }));
        return out([{ key: 'createdAt', label: 'Received (IST)', format: 'datetime' }, { key: 'name', label: 'Name' }, { key: 'mobile', label: 'Mobile' }, { key: 'email', label: 'Email' }, { key: 'city', label: 'City' }, { key: 'businessLine', label: 'Business line' }, { key: 'source', label: 'Source' }, { key: 'owner', label: 'Owner' }, { key: 'stage', label: 'Stage' }, ...answerKeys.map((k) => ({ key: `cf_${k}`, label: k.replace(/_/g, ' ') }))], rows);
      }
    }
    throw new BadRequestException({ code: 'UNKNOWN_REPORT', message: 'Unknown report' });
  }
}
