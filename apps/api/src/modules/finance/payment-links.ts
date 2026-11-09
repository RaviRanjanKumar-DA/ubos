import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Injectable, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { amountInWords, GST_STATES } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, ctx, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { notify } from '../../common/notify';
import { scopeFilter } from '../../common/scope';
import { assertPublicUrl, readConfig, type IntegrationConfig } from '../integration-runtime';
import { recordInvoicePayment } from './invoice-payments';

const WORK = 'finance.invoice.manage';
const VIEW = 'finance.invoice.view';
const MakeLink = z.object({ amountPaise: z.number().int().min(100).optional(), expiresInDays: z.number().int().min(1).max(90).default(15), notifyCustomer: z.boolean().default(false) });

const base = (cfg: IntegrationConfig) => (cfg.values.apiBase || 'https://api.razorpay.com').replace(/\/$/, '');
const authHeader = (cfg: IntegrationConfig) => `Basic ${Buffer.from(`${cfg.values.keyId}:${cfg.values.apiSecret}`).toString('base64')}`;

async function razorpay<T>(cfg: IntegrationConfig, path: string, body?: unknown): Promise<T> {
  const url = `${base(cfg)}${path}`;
  await assertPublicUrl(url);
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Authorization: authHeader(cfg), 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    .catch((e) => { throw new HttpException({ code: 'GATEWAY_UNREACHABLE', message: `Razorpay could not be reached: ${e instanceof Error ? e.message : e}` }, 502); });
  const out = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) throw new HttpException({ code: 'GATEWAY_REFUSED', message: `Razorpay refused this: ${out.error?.description ?? `HTTP ${res.status}`}` }, 502);
  return out;
}

interface RzpEvent { event?: string; payload?: { payment_link?: { entity?: { id?: string; amount_paid?: number; status?: string } }; payment?: { entity?: { id?: string; amount?: number; method?: string; captured?: boolean } } } }

/** Receives Razorpay's webhooks. A repeated webhook changes nothing. */
@Injectable()
export class RazorpayWebhooks {
  private readonly log = new Logger('Razorpay');
  constructor(private db: DbService) {}

  verify(cfg: IntegrationConfig, raw: Buffer | undefined, header: string | undefined) {
    if (!cfg.values.webhookSecret || !raw || !header) return false;
    const want = Buffer.from(createHmac('sha256', cfg.values.webhookSecret).update(raw).digest('hex'));
    const got = Buffer.from(header);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  async receive(body: RzpEvent) {
    const linkId = body.payload?.payment_link?.entity?.id;
    if (!linkId) return { ok: true, ignored: true };
    if (body.event === 'payment_link.cancelled' || body.event === 'payment_link.expired') {
      const status = body.event.endsWith('expired') ? 'expired' : 'cancelled';
      await this.db.tenant((tx) => tx.paymentLink.updateMany({ where: { provider: 'razorpay', providerId: linkId, status: 'created' }, data: { status } }));
      return { ok: true };
    }
    if (body.event !== 'payment_link.paid') return { ok: true, ignored: true };
    const pay = body.payload?.payment?.entity;
    if (!pay?.id || !pay.amount) return { ok: true, ignored: true };
    return this.db.tenant(async (tx) => {
      const link = await tx.paymentLink.findFirst({ where: { provider: 'razorpay', providerId: linkId } });
      if (!link) return { ok: true, ignored: true };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-pay:${link.invoiceId}`}))`;
      if (await tx.payment.findFirst({ where: { source: 'gateway', reference: pay.id }, select: { id: true } })) return { ok: true, duplicate: true };
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: link.invoiceId } });
      const p = await recordInvoicePayment(tx, inv, { amountPaise: pay.amount!, mode: 'online', reference: pay.id!, receivedAt: new Date(), userId: null, source: 'gateway' });
      await tx.paymentLink.update({ where: { id: link.id }, data: { status: 'paid', paidAt: new Date() } });
      const lead = await tx.lead.findUnique({ where: { id: inv.leadId }, select: { ownerId: true } });
      const odd = inv.status !== 'issued' ? ' The invoice was cancelled; check this payment.' : inv.paidPaise + pay.amount! > inv.totalPaise ? ' This is more than was due; check this payment.' : '';
      await notify(tx, [...new Set([link.createdById, ...(lead?.ownerId ? [lead.ownerId] : [])])], { type: 'assignment', title: `Payment received on invoice ${inv.number}`, body: `₹${(pay.amount! / 100).toLocaleString('en-IN')} paid online.${odd}`, link: `/app/invoices/${inv.id}` });
      await this.db.audit(tx, { workspaceId: inv.workspaceId, entity: 'payment', entityId: p.id, action: 'payment.gateway_received', newValue: { invoice: inv.number, amountPaise: p.amountPaise, reference: p.reference } });
      return { ok: true };
    });
  }
}

/** Payment links on invoices, and receipts. */
@Controller('api/v1')
@RequireFeature('module.finance')
export class PaymentLinksController {
  constructor(private db: DbService) {}

  private async gateway(tx: Tx) {
    const conn = await tx.integrationConnection.findFirst({ where: { key: 'razorpay', workspaceId: null, status: 'active' } });
    if (!conn) throw new BadRequestException({ code: 'GATEWAY_OFF', message: 'Razorpay is not connected (Integrations → Razorpay)' });
    return readConfig(conn.configEncrypted);
  }
  private async invoice(tx: Tx, id: string, perm: string) {
    const inv = await tx.invoice.findFirst({ where: { AND: [{ id }, { lead: await scopeFilter(tx, perm as never) }] } });
    if (!inv) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    return inv;
  }

  @Get('invoices/:id/payment-links')
  @RequirePermission(VIEW)
  list(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await this.invoice(tx, id, VIEW);
      const connected = !!(await tx.integrationConnection.findFirst({ where: { key: 'razorpay', workspaceId: null, status: 'active' }, select: { id: true } }));
      return { connected, links: await tx.paymentLink.findMany({ where: { invoiceId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, url: true, amountPaise: true, status: true, expiresAt: true, paidAt: true, createdAt: true } }) };
    });
  }

  /** A new link replaces any open one, so only one can be paid. */
  @Post('invoices/:id/payment-link')
  @RequirePermission(WORK)
  async create(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(MakeLink, body);
    const prep = await this.db.tenant(async (tx) => {
      const inv = await this.invoice(tx, id, WORK);
      if (inv.status !== 'issued') throw new BadRequestException({ code: 'NOT_ISSUED', message: 'Issue the invoice first' });
      const due = inv.totalPaise - inv.paidPaise;
      if (due <= 0) throw new BadRequestException({ code: 'NOTHING_DUE', message: 'Nothing is due on this invoice' });
      const amount = input.amountPaise ?? due;
      if (amount > due) throw new BadRequestException({ code: 'TOO_MUCH', message: `Only ₹${(due / 100).toLocaleString('en-IN')} is due on this invoice` });
      const cfg = await this.gateway(tx);
      const open = await tx.paymentLink.findFirst({ where: { invoiceId: id, status: 'created' } });
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: inv.customerId }, select: { name: true, mobile: true, email: true } });
      return { inv, amount, cfg, open, customer };
    });
    if (prep.open) {
      await razorpay(prep.cfg, `/v1/payment_links/${encodeURIComponent(prep.open.providerId)}/cancel`).catch(() => undefined);
      await this.db.tenant((tx) => tx.paymentLink.update({ where: { id: prep.open!.id }, data: { status: 'cancelled' } }));
    }
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
    const made = await razorpay<{ id: string; short_url: string }>(prep.cfg, '/v1/payment_links', {
      amount: prep.amount, currency: 'INR', accept_partial: false, description: `Invoice ${prep.inv.number}`.slice(0, 2048), reference_id: `${prep.inv.number!.replace(/\//g, '-')}-${Date.now().toString(36)}`.slice(0, 40), expire_by: Math.floor(expiresAt.getTime() / 1000),
      customer: { name: prep.customer.name, ...(prep.customer.mobile ? { contact: prep.customer.mobile } : {}), ...(prep.customer.email ? { email: prep.customer.email } : {}) },
      notify: { sms: input.notifyCustomer && !!prep.customer.mobile, email: input.notifyCustomer && !!prep.customer.email }, reminder_enable: false, notes: { invoice: prep.inv.number, ubos_invoice_id: prep.inv.id },
    });
    return this.db.tenant(async (tx) => {
      const link = await tx.paymentLink.create({ data: { tenantId: tenantId(), invoiceId: id, providerId: made.id, url: made.short_url, amountPaise: prep.amount, expiresAt, createdById: auth().userId } });
      await this.db.audit(tx, { workspaceId: prep.inv.workspaceId, entity: 'payment_link', entityId: link.id, action: 'payment_link.created', newValue: { invoice: prep.inv.number, amountPaise: prep.amount } });
      return link;
    });
  }

  @Post('payment-links/:id/cancel')
  @HttpCode(200)
  @RequirePermission(WORK)
  async cancel(@Param('id') id: string) {
    const { link, cfg } = await this.db.tenant(async (tx) => {
      const l = await tx.paymentLink.findUnique({ where: { id } });
      if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment link not found' });
      await this.invoice(tx, l.invoiceId, WORK);
      if (l.status !== 'created') throw new BadRequestException({ code: 'NOT_OPEN', message: 'This link is no longer open' });
      return { link: l, cfg: await this.gateway(tx) };
    });
    await razorpay(cfg, `/v1/payment_links/${encodeURIComponent(link.providerId)}/cancel`);
    await this.db.tenant((tx) => tx.paymentLink.updateMany({ where: { id, status: 'created' }, data: { status: 'cancelled' } }));
    return { ok: true };
  }

  @Get('payments/:id/receipt')
  @RequirePermission(VIEW)
  receipt(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const p = await tx.payment.findUnique({ where: { id } });
      if (!p?.invoiceId || !p.receiptNumber) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Receipt not found' });
      const inv = await this.invoice(tx, p.invoiceId, VIEW);
      const words = amountInWords(p.amountPaise);
      return { receiptNumber: p.receiptNumber, amountPaise: p.amountPaise, words, mode: p.mode, reference: p.reference, receivedAt: p.receivedAt, isVoided: p.isVoided, voidReason: p.voidReason, invoice: { id: inv.id, number: inv.number, totalPaise: inv.totalPaise }, customerName: inv.customerName, seller: inv.seller, stateName: GST_STATES[(inv.seller as { stateCode?: string } | null)?.stateCode ?? ''] ?? '', organization: ctx().tenant?.name };
    });
  }
}
