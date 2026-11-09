import { CollectionsReminders } from './finance/collections';
import { ChatbotService } from './chatbot/chatbot.service';
import { MailService } from './connected/mail.service';
import { notifyTicketBreaches } from './support/tickets.controller';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Tx } from '@ubos/database';
import { accessibleWorkspaceIds, DASHBOARD_TEMPLATES, FeatureKey, METRICS, resolvePermissions, RoleAssignment, DataScope, WidgetConfig } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { AuthInfo, contextStore, tenantId, TenantInfo } from '../common/context';
import { scopeFilter } from '../common/scope';
import { Mailer } from '../auth/mailer';
import { dueSheetSyncs, IntakeService } from './integration-runtime';
import { authFor } from '../common/auth-for';
import { CallingService } from './calling/calling.service';
import { localParts, loadLookups, resolveRange, runMetric } from './analytics/engine';

const WEB = () => (process.env.WEB_ORIGIN ?? 'http://localhost:3030').split(',')[0];
const fmtNum = (v: number | null, format: string) => {
  if (v === null) return '—';
  if (format === 'percent') return `${v}%`;
  if (format === 'currency') return `₹${Math.round(v / 100).toLocaleString('en-IN')}`;
  if (format === 'hours') return `${v} h`;
  if (format === 'days') return `${v} days`;
  if (format === 'minutes') return `${Math.round(v)} min`;
  return Math.round(v).toLocaleString('en-IN');
};

/**
 * Background jobs, once a minute: reminders before tasks and follow-ups, the daily summary email per person, and
 * "email me this dashboard" subscriptions. Emails go through the configured SMTP server (Mailpit when local).
 * Set SCHEDULER_DISABLED=true to switch the timer off (an admin can still run it with "Run now").
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Scheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private lastPurge = 0;
  constructor(private db: DbService, private mailer: Mailer, private intake: IntakeService, private calling: CallingService, private mail: MailService, private chatbot: ChatbotService, private collections: CollectionsReminders) {}

  onModuleInit() {
    if (process.env.SCHEDULER_DISABLED === 'true') return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.log.error(e instanceof Error ? e.message : e)); }, 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** Runs every job for every active organization (or one organization). */
  async tick(onlyTenantId?: string) {
    // The minute timer skips while a run is going; "Run now" (one organization) waits for it and then runs.
    if (this.running && !onlyTenantId) return { skipped: true };
    while (this.running) await new Promise((r) => setTimeout(r, 200));
    this.running = true;
    const totals = { reminders: 0, digests: 0, dashboards: 0 };
    try {
      const tenants = await this.db.platform.tenant.findMany({ where: { status: { in: ['active', 'trial'] }, ...(onlyTenantId ? { id: onlyTenantId } : {}) } });
      for (const t of tenants) {
        const info: TenantInfo = { id: t.id, slug: t.slug, name: t.name, status: t.status };
        await contextStore.run({ traceId: `scheduler-${Date.now()}`, ip: null, tenant: info }, async () => {
          totals.reminders += await this.reminders(t.timezone);
          totals.digests += await this.digests(info, t.timezone);
          totals.dashboards += await this.dashboardEmails(info);
          await notifyTicketBreaches(this.db).catch((e) => this.log.error(e instanceof Error ? e.message : e));
          await this.chatbot.sendDue(t.id).catch((e) => this.log.error(e instanceof Error ? e.message : e));
          await this.collections.run(t.name, !!onlyTenantId).catch((e) => this.log.error(e instanceof Error ? e.message : e));
        });
      }
      if (!onlyTenantId) await dueSheetSyncs(this.db, this.intake).catch((e) => this.log.error(e instanceof Error ? e.message : e));
      if (!onlyTenantId) await this.mail.syncDue().catch((e) => this.log.error(e instanceof Error ? e.message : e));
      // Recordings past their retention, once an hour.
      if (!onlyTenantId && Date.now() - this.lastPurge > 3_600_000) { this.lastPurge = Date.now(); await this.calling.purge().catch((e) => this.log.error(e instanceof Error ? e.message : e)); }
      if (onlyTenantId) await this.calling.purge(onlyTenantId).catch((e) => this.log.error(e instanceof Error ? e.message : e));
    } finally {
      this.running = false;
    }
    return totals;
  }

  /** In-app + email reminder N minutes before a task or follow-up (once). */
  private async reminders(tz: string) {
    let sent = 0;
    const items = await this.db.tenant(async (tx) => {
      const settings = await tx.organizationSetting.findFirst();
      const until = new Date(Date.now() + (settings?.reminderMinutes ?? 15) * 60_000);
      const since = new Date(Date.now() - 86_400_000);
      const tasks = await tx.task.findMany({ where: { doneAt: null, remindedAt: null, dueAt: { gte: since, lte: until } }, take: 500 });
      const fus = await tx.followUp.findMany({ where: { doneAt: null, remindedAt: null, dueAt: { gte: since, lte: until } }, include: { lead: { select: { id: true, customer: { select: { name: true } } } } }, take: 500 });
      const list = [
        ...tasks.map((t) => ({ kind: 'task' as const, id: t.id, userId: t.assigneeId, title: `${t.type === 'meeting' ? 'Meeting' : t.type === 'call' ? 'Call' : 'Task'}: ${t.title}`, dueAt: t.dueAt, link: t.leadId ? `/app/leads/${t.leadId}` : '/app/calendar' })),
        ...fus.map((f) => ({ kind: 'follow_up' as const, id: f.id, userId: f.userId, title: `Follow-up: ${f.lead.customer.name}${f.note ? ` — ${f.note}` : ''}`, dueAt: f.dueAt, link: `/app/leads/${f.lead.id}` })),
      ];
      const users = new Map((await tx.user.findMany({ where: { id: { in: list.map((x) => x.userId) }, isActive: true }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
      for (const x of list) {
        if (!users.has(x.userId)) continue;
        await tx.notification.create({ data: { tenantId: tenantId(), userId: x.userId, type: 'reminder', title: x.title, body: `Due at ${x.dueAt.toLocaleTimeString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}`, link: x.link } });
        if (x.kind === 'task') await tx.task.update({ where: { id: x.id }, data: { remindedAt: new Date() } });
        else await tx.followUp.update({ where: { id: x.id }, data: { remindedAt: new Date() } });
      }
      return list.filter((x) => users.has(x.userId)).map((x) => ({ ...x, email: users.get(x.userId)! }));
    });
    for (const x of items) {
      await this.mailer.send(x.email, `Reminder — ${x.title}`, `${x.title}\nDue: ${x.dueAt.toLocaleString('en-IN', { timeZone: tz })}\n\nOpen: ${WEB()}${x.link}`).catch(() => undefined);
      sent++;
    }
    return sent;
  }

  /** Daily summary per person after the organization's digest hour: today's work and yesterday's numbers. */
  private async digests(t: TenantInfo, tz: string) {
    const now = localParts(new Date(), tz);
    const mails = await this.db.tenant(async (tx) => {
      const settings = await tx.organizationSetting.findFirst();
      if (now.h < (settings?.digestHour ?? 9)) return [];
      const r = resolveRange('today', tz);
      const y = resolveRange('yesterday', tz);
      const users = await tx.user.findMany({ where: { isActive: true, digestEnabled: true, OR: [{ lastDigestAt: null }, { lastDigestAt: { lt: r.from } }] }, take: 500 });
      const out: { email: string; subject: string; text: string }[] = [];
      for (const u of users) {
        const [due, overdue, tasks, newLeads, calls, won] = await Promise.all([
          tx.followUp.count({ where: { userId: u.id, doneAt: null, dueAt: { gte: r.from, lt: r.to } } }),
          tx.followUp.count({ where: { userId: u.id, doneAt: null, dueAt: { lt: r.from } } }),
          tx.task.findMany({ where: { assigneeId: u.id, doneAt: null, dueAt: { lt: r.to } }, orderBy: { dueAt: 'asc' }, take: 10 }),
          tx.lead.count({ where: { ownerId: u.id, assignedAt: { gte: y.from, lt: r.to } } }),
          tx.leadActivity.count({ where: { userId: u.id, type: 'call', createdAt: { gte: y.from, lt: y.to } } }),
          tx.lead.count({ where: { ownerId: u.id, stageChangedAt: { gte: y.from, lt: y.to }, stageId: { in: (await tx.leadStage.findMany({ where: { isWon: true }, select: { id: true } })).map((s) => s.id) } } }),
        ]);
        const lines = [
          `Good morning ${u.name.split(' ')[0]},`, '',
          `Today: ${due} follow-up(s) due${overdue ? `, ${overdue} overdue from before` : ''}.`,
          ...(tasks.length ? ['Tasks & meetings:', ...tasks.map((x) => `  • ${x.title} — ${x.dueAt.toLocaleTimeString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}${x.dueAt < r.from ? ' (overdue)' : ''}`)] : []),
          `New leads for you since yesterday: ${newLeads}.`,
          `Yesterday: ${calls} call(s), ${won} lead(s) won.`, '',
          `Open UBOS: ${WEB()}/app/dashboard`,
          '', `You get this summary every morning. Switch it off in My Security → Notifications.`,
        ];
        await tx.user.update({ where: { id: u.id }, data: { lastDigestAt: new Date() } });
        await tx.notification.create({ data: { tenantId: t.id, userId: u.id, type: 'digest', title: `Today: ${due} follow-up(s) due, ${tasks.length} task(s)`, link: '/app/calendar' } });
        out.push({ email: u.email, subject: `Your day at ${t.name} — ${due + overdue} follow-up(s), ${tasks.length} task(s)`, text: lines.join('\n') });
      }
      return out;
    }, { timeoutMs: 60_000 });
    for (const m of mails) await this.mailer.send(m.email, m.subject, m.text).catch(() => undefined);
    return mails.length;
  }

  /** "Email me this dashboard": KPI tiles computed with the subscriber's own access. */
  private async dashboardEmails(t: TenantInfo) {
    const subs = await this.db.tenant((tx) => tx.dashboardSubscription.findMany({ take: 500 }));
    let sent = 0;
    for (const s of subs) {
      const due = await this.db.tenant(async (tx) => {
        const L = await loadLookups(tx, t.id);
        const now = localParts(new Date(), L.tz);
        const today = resolveRange('today', L.tz).from;
        if (now.h < s.hour || (s.lastSentAt && s.lastSentAt >= today) || (s.frequency === 'weekly' && now.wd !== 0)) return null;
        const user = await tx.user.findFirst({ where: { id: s.userId, isActive: true } });
        if (!user) return null;
        const dash = s.dashboardId.startsWith('tpl:')
          ? DASHBOARD_TEMPLATES.find((x) => x.key === s.dashboardId.slice(4))
          : await tx.dashboard.findUnique({ where: { id: s.dashboardId } });
        if (!dash) return null;
        return { user, dash: { name: dash.name, widgets: dash.widgets as unknown as WidgetConfig[] }, range: s.frequency === 'weekly' ? 'last_7_days' : 'yesterday' };
      });
      if (!due) continue;
      const authInfo = await this.authFor(t, due.user.id);
      const lines = await contextStore.run({ traceId: `dash-${s.id}`, ip: null, tenant: t, auth: authInfo }, () => this.db.tenant(async (tx) => {
        const L = await loadLookups(tx, t.id);
        const r = resolveRange(due.range as never, L.tz);
        const c = { tx, L, scope: await scopeFilter(tx, 'dashboard.view'), filters: {}, tenantId: t.id, auditAllowed: authInfo.permissions['audit.view'] === 'ORGANIZATION' };
        const out: string[] = [];
        for (const w of due.dash.widgets.filter((x) => x.type === 'kpi' && x.metric && METRICS[x.metric]).slice(0, 16)) {
          try {
            const m = await runMetric(c, w.metric!, 'none', r, true);
            const change = m.previous !== null && m.value !== null && m.previous !== 0 ? ` (${m.value >= m.previous ? '▲' : '▼'} ${Math.abs(Math.round(((m.value - m.previous) / m.previous) * 100))}%)` : '';
            out.push(`  ${w.title || METRICS[w.metric!].label}: ${fmtNum(m.value, m.format)}${change}`);
          } catch { /* widgets the person cannot see are left out */ }
        }
        await tx.dashboardSubscription.update({ where: { id: s.id }, data: { lastSentAt: new Date() } });
        return { out, label: r.label };
      }));
      await this.mailer.send(due.user.email, `${due.dash.name} — ${lines.label}`, [`${due.dash.name} · ${lines.label}`, '', ...lines.out, '', `Open the dashboard: ${WEB()}/app/dashboard`].join('\n')).catch(() => undefined);
      sent++;
    }
    return sent;
  }

  private authFor(t: TenantInfo, userId: string): Promise<AuthInfo> {
    return authFor(this.db, t, userId, 'scheduler');
  }
}
