import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { auth, ctx, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { randomToken } from '../auth/crypto';
import { billingState, istClock } from '@ubos/shared';
import { platformSettings, usageMonth } from '../platform/billing-lifecycle';
import { platformGateway, platformRazorpay } from '../platform/billing-orders';
import { GST_STATES, amountInWords, validGstin } from '@ubos/shared';
import { webBase } from './connected/providers';

export const GST_PCT = 18;
export const CYCLE_MONTHS: Record<string, number> = { quarterly: 3, annual: 12 };

const OrderBody = z.object({
  cycle: z.enum(['quarterly', 'annual']).default('annual'),
  items: z.array(z.object({ productCode: z.string().max(60), quantity: z.number().int().min(1).max(10_000) })).min(1).max(20),
  note: z.string().trim().max(300).optional(),
});
const Details = z.object({
  billingName: z.string().trim().min(2).max(160), gstin: z.string().trim().toUpperCase().refine((g) => !g || validGstin(g), 'Enter a valid GSTIN').nullable().optional(),
  billingStateCode: z.string().refine((c) => c in GST_STATES, 'Choose the state'), billingAddress: z.string().trim().min(5).max(500),
});
const OrdersQuery = z.object({
  status: z.enum(['pending', 'paid', 'cancelled']).optional(),
  cycle: z.enum(['quarterly', 'annual', 'one_time']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** An invoice as the print page needs it. */
export function invoiceView(inv: { id: string; number: string; fy: string; seller: Prisma.JsonValue; buyer: Prisma.JsonValue; items: Prisma.JsonValue; placeOfSupply: string | null; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; gstPaise: number; totalPaise: number; status: string; paymentRef: string | null; issuedAt: Date; paidAt: Date | null }) {
  return { ...inv, placeOfSupplyName: inv.placeOfSupply ? GST_STATES[inv.placeOfSupply] ?? inv.placeOfSupply : null, gstPct: GST_PCT, words: amountInWords(inv.totalPaise) };
}

/** Price of one licence for a cycle, before GST: monthly × months, minus the annual discount. */
export function licenceUnitPaise(p: { priceMonthlyPaise: number | null; annualDiscountPct: number }, cycle: string) {
  const months = CYCLE_MONTHS[cycle] ?? 12;
  const gross = (p.priceMonthlyPaise ?? 0) * months;
  return cycle === 'annual' ? Math.round((gross * (100 - p.annualDiscountPct)) / 100) : gross;
}

/** Billing & licences for an organization: catalogue, orders, transaction history. */
@Controller('api/v1/billing')
export class BillingController {
  constructor(private db: DbService) {}

  @Get('catalog')
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  catalog() {
    return this.db.tenant(async (tx) => {
      const products = await tx.platformProduct.findMany({ where: { isActive: true }, orderBy: { position: 'asc' } });
      const plans = new Map((await tx.plan.findMany({ include: { features: true } })).map((p) => [p.code, p]));
      const sub = await tx.subscription.findFirst({ include: { plan: true }, orderBy: { currentPeriodEnd: 'desc' } });
      const used = await tx.user.count({ where: { isActive: true } });
      return {
        gstPct: GST_PCT,
        subscription: sub ? { plan: sub.plan.name, planCode: sub.plan.code, status: sub.status, licences: sub.licences, used, expiresAt: sub.currentPeriodEnd, trialEndsAt: sub.trialEndsAt } : null,
        licences: products.filter((p) => p.kind === 'licence').map((p) => ({
          code: p.code, name: p.name, description: p.description, planCode: p.planCode, monthlyPaise: p.priceMonthlyPaise,
          quarterlyPaise: licenceUnitPaise(p, 'quarterly'), annualPaise: licenceUnitPaise(p, 'annual'), annualDiscountPct: p.annualDiscountPct,
          features: plans.get(p.planCode ?? '')?.features.map((f) => f.featureKey) ?? [],
          recordingRetentionDays: plans.get(p.planCode ?? '')?.recordingRetentionDays ?? 0,
        })),
        services: products.filter((p) => p.kind === 'service').map((p) => ({ code: p.code, name: p.name, description: p.description, pricePaise: p.priceOncePaise })),
      };
    });
  }

  /** Who UBOS invoices are made out to. */
  @Get('details')
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  async details() {
    const t = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId() } });
    return { billingName: t.billingName ?? t.name, gstin: t.gstin, billingStateCode: t.billingStateCode, billingAddress: t.billingAddress, onlinePay: !!(await platformGateway(this.db.platform)) };
  }

  @Put('details')
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  async saveDetails(@Body() body: unknown) {
    const input = parse(Details, body);
    if (input.gstin && input.gstin.slice(0, 2) !== input.billingStateCode) throw new BadRequestException({ code: 'GSTIN_STATE', message: 'The GSTIN belongs to a different state' });
    const t = await this.db.platform.tenant.update({ where: { id: tenantId() }, data: { billingName: input.billingName, gstin: input.gstin || null, billingStateCode: input.billingStateCode, billingAddress: input.billingAddress } });
    await this.db.tenant((tx) => this.db.audit(tx, { entity: 'tenant', entityId: t.id, action: 'billing.details_saved', newValue: input }));
    return { ok: true };
  }

  /** Opens (or reuses) a Razorpay payment link on UBOS's account for a pending order. Paying it applies the order on its own. */
  @Post('orders/:id/pay')
  @HttpCode(200)
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  async pay(@Param('id') id: string) {
    const p = this.db.platform;
    const o = await p.tenantOrder.findFirst({ where: { id, tenantId: tenantId() } });
    if (!o) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (o.status !== 'pending') throw new ConflictException({ code: 'ORDER_NOT_PENDING', message: 'This order is already closed' });
    if (o.paymentLinkUrl && o.paymentLinkExpiresAt && o.paymentLinkExpiresAt > new Date(Date.now() + 3_600_000)) return { url: o.paymentLinkUrl };
    const g = await platformGateway(p);
    if (!g) throw new BadRequestException({ code: 'ONLINE_PAY_OFF', message: 'Online payment is not set up yet. Pay by bank transfer or UPI and we will confirm it.' });
    const admin = await p.user.findUnique({ where: { id: auth().userId }, select: { name: true, email: true, mobile: true } });
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    const made = await platformRazorpay<{ id: string; short_url: string }>(g, '/v1/payment_links', {
      amount: o.totalPaise, currency: 'INR', accept_partial: false, description: `UBOS order ${o.number}`, reference_id: `${o.number}-${Date.now().toString(36)}`.slice(0, 40), expire_by: Math.floor(expiresAt.getTime() / 1000),
      customer: { name: admin?.name ?? '', ...(admin?.email ? { email: admin.email } : {}), ...(admin?.mobile ? { contact: admin.mobile } : {}) },
      notify: { sms: false, email: false }, reminder_enable: false, notes: { ubos_order_id: o.id, order: o.number, organization: ctx().tenant?.slug ?? '' },
      callback_url: `${webBase()}/app/billing?paid=${encodeURIComponent(o.number)}`, callback_method: 'get',
    });
    await p.tenantOrder.update({ where: { id: o.id }, data: { paymentLinkId: made.id, paymentLinkUrl: made.short_url, paymentLinkExpiresAt: expiresAt } });
    await this.db.tenant((tx) => this.db.audit(tx, { entity: 'order', entityId: o.id, action: 'billing.pay_link_opened', newValue: { number: o.number, totalPaise: o.totalPaise } }));
    return { url: made.short_url };
  }

  @Get('invoices')
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  invoices() {
    return this.db.platform.platformInvoice.findMany({ where: { tenantId: tenantId() }, orderBy: { issuedAt: 'desc' }, select: { id: true, number: true, totalPaise: true, issuedAt: true, status: true, orderId: true } });
  }

  @Get('invoices/:id')
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  async invoice(@Param('id') id: string) {
    const inv = await this.db.platform.platformInvoice.findFirst({ where: { id, tenantId: tenantId() } });
    if (!inv) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    return invoiceView(inv);
  }

  /** This month's usage against what the plan includes, and where the trial or subscription stands. */
  @Get('usage')
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  async usage(@Query('month') month?: string) {
    const m = month && /^d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : istClock(new Date()).day.slice(0, 7);
    const p = this.db.platform, tid = tenantId();
    const [sub, s] = await Promise.all([p.subscription.findFirst({ where: { tenantId: tid }, include: { plan: true }, orderBy: { currentPeriodEnd: 'desc' } }), platformSettings(p)]);
    return {
      month: m, usage: await usageMonth(p, tid, m),
      allowance: sub ? { users: sub.licences, storageMb: sub.plan.storageGbPerUser * sub.licences * 1024 } : null,
      billing: sub ? { ...billingState(sub, s.graceDays), status: sub.status } : null,
    };
  }

  /** Places an order (status "pending"). Payment by gateway comes later; until then the Platform Owner marks it paid. */
  @Post('orders')
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  order(@Body() body: unknown) {
    const input = parse(OrderBody, body);
    return this.db.tenant(async (tx) => {
      const products = await tx.platformProduct.findMany({ where: { code: { in: input.items.map((i) => i.productCode) }, isActive: true } });
      const items = input.items.map((i) => {
        const p = products.find((x) => x.code === i.productCode);
        if (!p) throw new BadRequestException({ code: 'UNKNOWN_PRODUCT', message: `Unknown product ${i.productCode}` });
        const unitPaise = p.kind === 'licence' ? licenceUnitPaise(p, input.cycle) : p.priceOncePaise ?? 0;
        return { productCode: p.code, name: p.name, kind: p.kind, planCode: p.planCode, quantity: i.quantity, unitPaise, amountPaise: unitPaise * i.quantity };
      });
      const licencePlans = new Set(items.filter((i) => i.kind === 'licence').map((i) => i.planCode));
      if (licencePlans.size > 1) throw new BadRequestException({ code: 'ONE_PLAN', message: 'Choose one licence type per order' });
      const subtotal = items.reduce((s, i) => s + i.amountPaise, 0);
      const gst = Math.round((subtotal * GST_PCT) / 100);
      const now = new Date();
      const number = `UB-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 5)}`;
      const o = await tx.tenantOrder.create({
        data: {
          tenantId: tenantId(), number, cycle: licencePlans.size ? input.cycle : 'one_time', items: items as Prisma.InputJsonValue,
          subtotalPaise: subtotal, gstPaise: gst, totalPaise: subtotal + gst, createdById: auth().userId, note: input.note ?? null,
        },
      });
      await this.db.audit(tx, { entity: 'order', entityId: o.id, action: 'billing.order_placed', newValue: { number, totalPaise: o.totalPaise, items: items.map((i) => `${i.quantity} × ${i.name}`) } });
      return o;
    });
  }

  @Get('orders')
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  orders(@Query() query: unknown) {
    const q = parse(OrdersQuery, query);
    return this.db.tenant((tx) => tx.tenantOrder.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.cycle ? { cycle: q.cycle } : {}),
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00`) } : {}), ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00`).getTime() + 86_400_000) } : {}) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }));
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @RequirePermission('org.billing.manage', 'ORGANIZATION')
  cancel(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const o = await tx.tenantOrder.findUnique({ where: { id } });
      if (!o) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      if (o.status !== 'pending') throw new ConflictException({ code: 'ORDER_NOT_PENDING', message: 'Only pending orders can be cancelled' });
      await tx.tenantOrder.update({ where: { id }, data: { status: 'cancelled' } });
      await this.db.audit(tx, { entity: 'order', entityId: id, action: 'billing.order_cancelled', oldValue: { status: 'pending' }, newValue: { status: 'cancelled' } });
      return { ok: true };
    });
  }
}
