import { Injectable, Logger } from '@nestjs/common';
import { appendAudit, type PrismaClient } from '@ubos/database';
import { LIVE_TENANT_STATUSES, RENEWAL_REMINDER_DAYS, billingState, istClock, istInstant, monthDays } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { Mailer } from '../auth/mailer';
import { webBase } from '../modules/connected/providers';

export const USAGE_METRICS = ['active_users', 'storage_mb', 'calls', 'call_minutes', 'whatsapp_out', 'sms_out', 'email_out'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
/** Gauges show the latest value of the month; the rest add up day by day. */
const GAUGES: UsageMetric[] = ['active_users', 'storage_mb'];

export async function platformSettings(p: Pick<PrismaClient, 'platformSetting'>) {
  return (await p.platformSetting.findUnique({ where: { id: 'default' } })) ?? {
    id: 'default', signupEnabled: true, trialDays: 14, trialPlanCode: 'business', trialLicences: 5, graceDays: 7, updatedAt: new Date(),
    sellerName: null, sellerGstin: null, sellerStateCode: null, sellerAddress: null, sellerEmail: null, invoicePrefix: 'UB', razorpayKeyId: null, razorpaySecretEnc: null, razorpayWebhookSecretEnc: null, razorpayApiBase: null,
  };
}

/** One organization's usage on one IST day, counted from its own records. */
export async function usageOn(p: PrismaClient, tenantId: string, day: string): Promise<Record<UsageMetric, number>> {
  const from = istInstant(day, '00:00'), to = new Date(from.getTime() + 86_400_000);
  const [users, rec, docs, calls, msgs] = await Promise.all([
    p.user.count({ where: { tenantId, isActive: true } }),
    p.call.aggregate({ where: { tenantId, recordingStatus: 'ready' }, _sum: { recordingBytes: true } }),
    p.employeeDocument.aggregate({ where: { tenantId, isArchived: false }, _sum: { sizeBytes: true } }),
    p.call.aggregate({ where: { tenantId, startedAt: { gte: from, lt: to } }, _count: true, _sum: { talkSec: true } }),
    p.$queryRaw<{ channel: string; n: bigint }[]>`SELECT c.channel, count(*) AS n FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId" WHERE m."tenantId" = ${tenantId} AND m.direction = 'out' AND m."createdAt" >= ${from} AND m."createdAt" < ${to} GROUP BY c.channel`,
  ]);
  const out = (ch: string) => Number(msgs.find((m) => m.channel === ch)?.n ?? 0);
  return {
    active_users: users,
    storage_mb: Math.round((((rec._sum.recordingBytes ?? 0) + (docs._sum.sizeBytes ?? 0)) / 1_048_576) * 10) / 10,
    calls: calls._count, call_minutes: Math.round((calls._sum.talkSec ?? 0) / 60),
    whatsapp_out: out('whatsapp'), sms_out: out('sms'), email_out: out('email'),
  };
}

/** A month of usage: today counted live, earlier days from the daily snapshots. */
export async function usageMonth(p: PrismaClient, tenantId: string, month: string) {
  const today = istClock(new Date()).day;
  const days = monthDays(month).filter((d) => d <= today);
  const snaps = days.length ? await p.usageRecord.findMany({ where: { tenantId, periodDay: { gte: istInstant(days[0], '12:00'), lte: istInstant(days[days.length - 1], '12:00') } }, orderBy: { periodDay: 'asc' } }) : [];
  const live = days.includes(today) ? await usageOn(p, tenantId, today) : null;
  const totals = Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as Record<UsageMetric, number>;
  for (const m of USAGE_METRICS) {
    const rows = snaps.filter((s) => s.metric === m && istClock(s.periodDay).day !== today).map((s) => Number(s.quantity));
    if (GAUGES.includes(m)) totals[m] = live ? live[m] : (rows[rows.length - 1] ?? 0);
    else totals[m] = rows.reduce((a, b) => a + b, 0) + (live?.[m] ?? 0);
  }
  return totals;
}

/**
 * Hourly, across all organizations: moves each one through trial → grace → expired (or active → grace → expired when a paid
 * period runs out), reminds the organization admins before and after, and keeps today's usage snapshot up to date.
 * Suspended and cancelled organizations are set by the Platform Owner and left alone. Your own company is never expired.
 */
@Injectable()
export class BillingLifecycle {
  private readonly log = new Logger('BillingLifecycle');
  private lastRun = 0;
  constructor(private db: DbService, private mailer: Mailer) {}

  async run(force = false) {
    if (!force && Date.now() - this.lastRun < 55 * 60_000) return null;
    this.lastRun = Date.now();
    const p = this.db.platform;
    const settings = await platformSettings(p);
    const today = istClock(new Date()).day;
    const tenants = await p.tenant.findMany({ where: { status: { notIn: ['suspended', 'cancelled'] } }, include: { subscriptions: { orderBy: { currentPeriodEnd: 'desc' }, take: 1 } } });
    const done = { changed: 0, reminders: 0, snapshots: 0 };
    for (const t of tenants) {
      try {
        const sub = t.subscriptions[0];
        if (!t.isInternal && sub) {
          const st = billingState(sub, settings.graceDays);
          if (st.phase !== t.status) {
            await p.$transaction(async (tx) => {
              await tx.tenant.update({ where: { id: t.id }, data: { status: st.phase, statusChangedAt: new Date() } });
              if (st.phase !== 'trial' && sub.status === 'active' && (st.phase === 'grace' || st.phase === 'expired')) await tx.subscription.update({ where: { id: sub.id }, data: { status: 'past_due' } });
              await appendAudit(tx, { tenantId: t.id, actorType: 'system', entity: 'tenant', entityId: t.id, action: 'billing.status_changed', oldValue: { status: t.status }, newValue: { status: st.phase, endsAt: st.endsAt } });
            });
            done.changed++;
          }
          done.reminders += await this.remind(t, st, sub.status === 'trialing');
        }
        if (LIVE_TENANT_STATUSES.includes(t.status) || t.status === 'expired') {
          const u = await usageOn(p, t.id, today);
          const periodDay = istInstant(today, '12:00');
          for (const metric of USAGE_METRICS) {
            await p.usageRecord.upsert({ where: { tenantId_metric_periodDay: { tenantId: t.id, metric, periodDay } }, create: { tenantId: t.id, metric, periodDay, quantity: u[metric] }, update: { quantity: u[metric] } });
          }
          done.snapshots++;
        }
      } catch (e) {
        this.log.error(`${t.slug}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return done;
  }

  private async remind(t: { id: string; name: string }, st: ReturnType<typeof billingState>, trial: boolean) {
    const p = this.db.platform;
    const end = istClock(st.endsAt).day;
    const what = trial ? 'trial' : 'subscription';
    let key: string | null = null, subject = '', text = '';
    if ((st.phase === 'trial' || st.phase === 'active') && RENEWAL_REMINDER_DAYS.includes(st.daysLeft)) {
      key = `billing:soon:${st.daysLeft}:${end}`;
      subject = `Your UBOS ${what} ends in ${st.daysLeft} ${st.daysLeft === 1 ? 'day' : 'days'}`;
      text = `${t.name}'s UBOS ${what} ends on ${end}. Choose licences in Billing to keep everything running: ${webBase()}/app/billing`;
    } else if (st.phase === 'grace') {
      key = `billing:grace:${end}`;
      subject = `Your UBOS ${what} has ended`;
      text = `${t.name}'s UBOS ${what} ended on ${end}. Everything keeps working for ${st.daysLeft} more ${st.daysLeft === 1 ? 'day' : 'days'}; after that the account pauses until it is paid. Open Billing: ${webBase()}/app/billing`;
    } else if (st.phase === 'expired') {
      key = `billing:expired:${end}`;
      subject = 'Your UBOS account is paused';
      text = `${t.name}'s UBOS account is paused because the ${what} was not renewed. Nothing has been deleted. Sign in and open Billing to continue: ${webBase()}/app/billing`;
    }
    if (!key) return 0;
    if (!(await p.reminderMark.createMany({ data: [{ tenantId: t.id, key }], skipDuplicates: true })).count) return 0;
    const admins = await p.user.findMany({ where: { tenantId: t.id, isActive: true, roles: { some: { role: { permissions: { some: { isDeny: false, permission: { key: 'org.billing.manage' } } } } } } }, select: { id: true, email: true } });
    if (admins.length) await p.notification.createMany({ data: admins.map((a) => ({ tenantId: t.id, userId: a.id, type: 'billing', title: subject, body: text, link: '/app/billing' })) });
    for (const a of admins) if (a.email) await this.mailer.send(a.email, subject, text).catch(() => undefined);
    return 1;
  }
}
