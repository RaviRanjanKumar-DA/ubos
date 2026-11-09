import { BadRequestException, Body, Controller, Get, Header, HttpCode, Injectable, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ageBucket, AGE_BUCKETS, daysPastDue, nextInstalmentDue, reminderStageFor } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, ctx, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { istDate, istText } from '../../common/ist';
import { activity } from '../../common/lead-ops';
import { notify } from '../../common/notify';
import { scopeFilter } from '../../common/scope';
import { Mailer } from '../../auth/mailer';

const VIEW = 'finance.invoice.view', WORK = 'finance.invoice.manage';
const Plan = z.object({ instalments: z.array(z.object({ dueAt: z.coerce.date(), amountPaise: z.number().int().min(100) })).max(36) });
const money = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const rupees = (p: number) => (p / 100).toFixed(2);
const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const IST_TIME = 'Asia/Kolkata';

/** Moves the invoice's due date to the first instalment not yet paid. Called whenever the plan or the amount paid changes. */
export async function refreshInvoiceDue(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { dueAt: true, paidPaise: true } });
  const plan = await tx.invoiceInstalment.findMany({ where: { invoiceId } });
  if (!plan.length) return;
  const next = nextInstalmentDue(plan, inv.paidPaise);
  if (next && next.getTime() !== inv.dueAt?.getTime()) await tx.invoice.update({ where: { id: invoiceId }, data: { dueAt: next, reminderStage: 0 } });
}

async function reminderEmail(tx: Tx, inv: { id: string; number: string | null; totalPaise: number; paidPaise: number; dueAt: Date | null; customerId: string; workspaceId: string }, org: string) {
  const c = await tx.customer.findUniqueOrThrow({ where: { id: inv.customerId }, select: { name: true, email: true, emailOptOut: true } });
  if (!c.email || c.emailOptOut) return null;
  const link = await tx.paymentLink.findFirst({ where: { invoiceId: inv.id, status: 'created' }, select: { url: true } });
  const due = inv.totalPaise - inv.paidPaise;
  const when = inv.dueAt ? inv.dueAt.toLocaleDateString('en-IN', { timeZone: IST_TIME, day: 'numeric', month: 'short', year: 'numeric' }) : null;
  return { to: c.email, subject: `Payment reminder: invoice ${inv.number}`, text: [`Hello ${c.name},`, '', `This is a reminder that ${money(due)} is due on invoice ${inv.number}${when ? `, due ${when}` : ''}.`, link ? `You can pay here: ${link.url}` : '', '', `Thank you,`, org].filter((x, i, a) => x || a[i - 1]).join('\n') };
}

@Injectable()
export class CollectionsReminders {
  constructor(private db: DbService, private mailer: Mailer) {}

  /** Each invoice moves through the reminder days once. Runs in the morning; "Run now" ignores the hour. */
  async run(tenantName: string, force: boolean) {
    const now = new Date();
    const hour = Number(now.toLocaleString('en-GB', { timeZone: IST_TIME, hour: '2-digit', hour12: false }));
    if (!force && hour < 9) return 0;
    const open = await this.db.tenant((tx) => tx.invoice.findMany({ where: { status: 'issued', dueAt: { not: null } }, take: 2000 }));
    let sent = 0;
    for (const inv of open) {
      if (inv.paidPaise >= inv.totalPaise || !inv.dueAt) continue;
      const days = daysPastDue(inv.dueAt, now);
      const stage = reminderStageFor(days);
      if (stage <= inv.reminderStage) continue;
      const mail = await this.db.tenant(async (tx) => {
        // Claimed first, so two runs can never remind twice.
        const claimed = await tx.invoice.updateMany({ where: { id: inv.id, reminderStage: inv.reminderStage }, data: { reminderStage: stage, lastReminderAt: now } });
        if (!claimed.count) return null;
        const lead = await tx.lead.findUnique({ where: { id: inv.leadId } });
        const ids = [...new Set([lead?.ownerId, inv.createdById].filter(Boolean) as string[])];
        const due = inv.totalPaise - inv.paidPaise;
        await notify(tx, ids, { type: 'reminder', title: days > 0 ? `Invoice ${inv.number} is ${days} ${days === 1 ? 'day' : 'days'} overdue` : days === 0 ? `Invoice ${inv.number} is due today` : `Invoice ${inv.number} is due in ${-days} days`, body: `${inv.customerName}: ${money(due)} due`, link: `/app/invoices/${inv.id}` });
        const profile = await tx.billingProfile.findUnique({ where: { workspaceId: inv.workspaceId }, select: { autoRemind: true, legalName: true } });
        if (!profile?.autoRemind) return null;
        const m = await reminderEmail(tx, inv, profile.legalName || tenantName);
        if (m && lead) await tx.leadActivity.create({ data: activity(lead, null, { type: 'message', remark: `Payment reminder emailed for invoice ${inv.number}`, data: { invoiceId: inv.id, channel: 'email' } }) });
        return m;
      });
      sent++;
      if (mail) await this.mailer.send(mail.to, mail.subject, mail.text).catch(() => undefined);
    }
    return sent;
  }
}

/** Who owes what: ageing, instalment plans, reminders and the customer ledger. */
@Controller('api/v1')
@RequireFeature('module.finance')
export class CollectionsController {
  constructor(private db: DbService, private mailer: Mailer) {}

  private async invoice(tx: Tx, id: string, perm: string) {
    const inv = await tx.invoice.findFirst({ where: { AND: [{ id }, { lead: await scopeFilter(tx, perm as never) }] }, include: { instalments: { orderBy: { dueAt: 'asc' } } } });
    if (!inv) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    return inv;
  }

  private async open(tx: Tx) {
    const rows = await tx.invoice.findMany({ where: { AND: [{ lead: await scopeFilter(tx, VIEW as never) }, { status: 'issued' }] }, orderBy: [{ dueAt: 'asc' }], take: 5000, select: { id: true, number: true, customerId: true, customerName: true, leadId: true, dueAt: true, issuedAt: true, totalPaise: true, paidPaise: true, lastReminderAt: true } });
    return rows.filter((r) => r.paidPaise < r.totalPaise);
  }

  @Get('collections')
  @RequirePermission(VIEW)
  collections() {
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const rows = await this.open(tx);
      const ageing = Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<(typeof AGE_BUCKETS)[number], number>;
      const out = rows.map((r) => {
        const due = r.totalPaise - r.paidPaise;
        const bucket = ageBucket(r.dueAt, now);
        ageing[bucket] += due;
        return { ...r, duePaise: due, bucket, daysPast: r.dueAt ? daysPastDue(r.dueAt, now) : null };
      });
      const byCustomer = [...out.reduce((m, r) => { const e = m.get(r.customerId) ?? { customerId: r.customerId, name: r.customerName, duePaise: 0, invoices: 0 }; e.duePaise += r.duePaise; e.invoices++; return m.set(r.customerId, e); }, new Map<string, { customerId: string; name: string; duePaise: number; invoices: number }>()).values()].sort((a, b) => b.duePaise - a.duePaise).slice(0, 10);
      return { rows: out.sort((a, b) => (b.daysPast ?? -9999) - (a.daysPast ?? -9999)), ageing, totalPaise: out.reduce((s, r) => s + r.duePaise, 0), byCustomer, canWork: !!auth().permissions[WORK] };
    });
  }

  @Get('collections.csv')
  @RequirePermission(VIEW)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="money-due.csv"')
  csv() {
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const lines = (await this.open(tx)).map((r) => [r.number, r.customerName, r.issuedAt ? istDate(r.issuedAt) : '', r.dueAt ? istDate(r.dueAt) : '', r.dueAt ? Math.max(0, daysPastDue(r.dueAt, now)) : 0, rupees(r.totalPaise), rupees(r.paidPaise), rupees(r.totalPaise - r.paidPaise)].map(cell).join(','));
      return [['Invoice no', 'Customer', 'Invoice date (IST)', 'Due date (IST)', 'Days overdue', 'Invoice total', 'Paid', 'Due'].join(','), ...lines].join('\n');
    });
  }

  @Get('invoices/:id/instalments')
  @RequirePermission(VIEW)
  plan(@Param('id') id: string) {
    return this.db.tenant(async (tx) => (await this.invoice(tx, id, VIEW)).instalments);
  }

  /** Replaces the plan. An empty list removes it. The amounts must add up to the invoice total. */
  @Put('invoices/:id/instalments')
  @RequirePermission(WORK)
  savePlan(@Param('id') id: string, @Body() body: unknown) {
    const { instalments } = parse(Plan, body);
    return this.db.tenant(async (tx) => {
      const inv = await this.invoice(tx, id, WORK);
      if (inv.status === 'cancelled') throw new BadRequestException({ code: 'CANCELLED', message: 'This invoice is cancelled' });
      const sum = instalments.reduce((s, i) => s + i.amountPaise, 0);
      if (instalments.length && sum !== inv.totalPaise) throw new BadRequestException({ code: 'PLAN_TOTAL', message: `The instalments add up to ${money(sum)}, but the invoice is ${money(inv.totalPaise)}` });
      await tx.invoiceInstalment.deleteMany({ where: { invoiceId: id } });
      if (instalments.length) await tx.invoiceInstalment.createMany({ data: instalments.map((i, position) => ({ tenantId: tenantId(), invoiceId: id, position, dueAt: i.dueAt, amountPaise: i.amountPaise })) });
      await refreshInvoiceDue(tx, id);
      await this.db.audit(tx, { workspaceId: inv.workspaceId, entity: 'invoice', entityId: id, action: 'invoice.plan_changed', newValue: { number: inv.number, instalments: instalments.length } });
      return tx.invoiceInstalment.findMany({ where: { invoiceId: id }, orderBy: { dueAt: 'asc' } });
    });
  }

  @Post('invoices/:id/remind')
  @HttpCode(200)
  @RequirePermission(WORK)
  async remind(@Param('id') id: string) {
    const mail = await this.db.tenant(async (tx) => {
      const inv = await this.invoice(tx, id, WORK);
      if (inv.status !== 'issued' || inv.paidPaise >= inv.totalPaise) throw new BadRequestException({ code: 'NOTHING_DUE', message: 'Nothing is due on this invoice' });
      const c = await tx.customer.findUniqueOrThrow({ where: { id: inv.customerId }, select: { email: true, emailOptOut: true, name: true } });
      if (!c.email) throw new BadRequestException({ code: 'NO_ADDRESS', message: `${c.name} has no email address` });
      if (c.emailOptOut) throw new BadRequestException({ code: 'OPTED_OUT', message: `${c.name} opted out of email` });
      const profile = await tx.billingProfile.findUnique({ where: { workspaceId: inv.workspaceId }, select: { legalName: true } });
      const m = await reminderEmail(tx, inv, profile?.legalName ?? ctx().tenant!.name);
      await tx.invoice.update({ where: { id }, data: { lastReminderAt: new Date() } });
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: inv.leadId } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'message', remark: `Payment reminder emailed for invoice ${inv.number}`, data: { invoiceId: id, channel: 'email' } }) });
      return m!;
    });
    await this.mailer.send(mail.to, mail.subject, mail.text);
    return { ok: true, at: istText(new Date()) };
  }

  /** Every invoice and payment for one customer, oldest first, with a running balance. Limited to leads the person can see. */
  @Get('customers/:id/ledger')
  @RequirePermission(VIEW)
  ledger(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const scope = await scopeFilter(tx, VIEW as never);
      const c = await tx.customer.findUnique({ where: { id }, select: { id: true, name: true, code: true, mergedIntoId: true } });
      const merged = (await tx.customer.findMany({ where: { mergedIntoId: id }, select: { id: true } })).map((x) => x.id);
      const leads = c ? await tx.lead.findMany({ where: { AND: [scope, { customerId: { in: [id, ...merged] } }] }, select: { id: true } }) : [];
      if (!c || !leads.length) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
      const leadIds = leads.map((l) => l.id);
      const [invoices, payments] = await Promise.all([
        tx.invoice.findMany({ where: { leadId: { in: leadIds }, status: 'issued' }, select: { id: true, number: true, issuedAt: true, totalPaise: true } }),
        tx.payment.findMany({ where: { leadId: { in: leadIds }, isVoided: false }, select: { id: true, invoiceId: true, receiptNumber: true, amountPaise: true, mode: true, reference: true, receivedAt: true } }),
      ]);
      const entries = [
        ...invoices.map((i) => ({ at: i.issuedAt!, kind: 'invoice', ref: i.number, id: i.id, debitPaise: i.totalPaise, creditPaise: 0, note: 'Invoice' })),
        ...payments.map((p) => ({ at: p.receivedAt, kind: 'payment', ref: p.receiptNumber ?? p.reference, id: p.id, debitPaise: 0, creditPaise: p.amountPaise, note: `Payment (${p.mode})${p.invoiceId ? '' : ' not on an invoice'}` })),
      ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === 'invoice' ? -1 : 1));
      let balance = 0;
      const rows = entries.map((e) => { balance += e.debitPaise - e.creditPaise; return { ...e, balancePaise: balance }; });
      return { customer: { id: c.id, name: c.name, code: c.code }, rows, balancePaise: balance, billedPaise: invoices.reduce((s, i) => s + i.totalPaise, 0), receivedPaise: payments.reduce((s, p) => s + p.amountPaise, 0) };
    });
  }
}
