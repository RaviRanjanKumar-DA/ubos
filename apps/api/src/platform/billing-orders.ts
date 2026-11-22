import { HttpException } from '@nestjs/common';
import { appendAudit, type Prisma, type PrismaClient } from '@ubos/database';
import { financialYear } from '@ubos/shared';
import { decrypt } from '../auth/crypto';
import { CYCLE_MONTHS } from '../modules/billing.controller';
import { assertPublicUrl } from '../modules/integration-runtime';
import { platformSettings } from './billing-lifecycle';

type PTx = Prisma.TransactionClient;
export interface Party { name: string; gstin: string | null; stateCode: string | null; address: string | null; email?: string | null }

/** People who manage billing in an organization (they hear about payments and invoices). */
export async function billingAdmins(p: PTx | PrismaClient, tenantId: string) {
  return p.user.findMany({ where: { tenantId, isActive: true, roles: { some: { role: { permissions: { some: { isDeny: false, permission: { key: 'org.billing.manage' } } } } } } }, select: { id: true, email: true } });
}

/** UBOS's GST tax invoice for a paid order. Numbers run per financial year: UB/26-27/0001. Inside UBOS's state GST splits into CGST and SGST. */
async function issueInvoice(tx: PTx, order: { id: string; tenantId: string; items: Prisma.JsonValue; subtotalPaise: number; gstPaise: number; totalPaise: number }, subscriptionId: string | null, paymentRef: string) {
  const s = await platformSettings(tx);
  const t = await tx.tenant.findUniqueOrThrow({ where: { id: order.tenantId } });
  const now = new Date();
  const fy = financialYear(now);
  const prefix = s.invoicePrefix || 'UB';
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ubos-invoice:${prefix}:${fy}`}))`;
  const n = (await tx.platformInvoice.count({ where: { fy, number: { startsWith: `${prefix}/${fy}/` } } })) + 1;
  const seller: Party = { name: s.sellerName || 'UBOS', gstin: s.sellerGstin ?? null, stateCode: s.sellerStateCode ?? null, address: s.sellerAddress ?? null, email: s.sellerEmail ?? null };
  const buyer: Party = { name: t.billingName || t.name, gstin: t.gstin ?? null, stateCode: t.billingStateCode ?? (t.gstin ? t.gstin.slice(0, 2) : null), address: t.billingAddress ?? null };
  const intra = !!seller.stateCode && seller.stateCode === buyer.stateCode;
  const cgst = intra ? Math.floor(order.gstPaise / 2) : 0;
  return tx.platformInvoice.create({
    data: {
      tenantId: order.tenantId, orderId: order.id, subscriptionId, number: `${prefix}/${fy}/${String(n).padStart(4, '0')}`, fy,
      seller: seller as unknown as Prisma.InputJsonValue, buyer: buyer as unknown as Prisma.InputJsonValue, items: order.items as Prisma.InputJsonValue, placeOfSupply: buyer.stateCode,
      amountPaise: order.subtotalPaise, taxablePaise: order.subtotalPaise, cgstPaise: cgst, sgstPaise: intra ? order.gstPaise - cgst : 0, igstPaise: intra ? 0 : order.gstPaise,
      gstPaise: order.gstPaise, totalPaise: order.totalPaise, status: 'paid', paymentRef, issuedAt: now, paidAt: now,
    },
  });
}

/**
 * Applies a paid order (marked paid in the console, or paid online): licence lines switch the subscription to that plan, add the
 * licences and extend validity by the cycle; the organization becomes active; UBOS issues its tax invoice. Only a pending order
 * is applied, so a repeated webhook or a second click changes nothing.
 */
export async function applyOrderPaid(tx: PTx, orderId: string, pay: { paymentRef: string; via: 'manual' | 'online'; actor: { type: 'platform_user' | 'system'; id?: string | null; ip?: string | null } }) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order-pay:${orderId}`}))`;
  const o = await tx.tenantOrder.findUnique({ where: { id: orderId } });
  if (!o) return { applied: false as const, reason: 'ORDER_NOT_FOUND' };
  if (o.status !== 'pending') return { applied: false as const, reason: 'ORDER_NOT_PENDING' };
  const items = o.items as { kind: string; planCode?: string | null; quantity: number }[];
  const licences = items.filter((i) => i.kind === 'licence');
  let subId: string | null = null;
  const sub = await tx.subscription.findFirst({ where: { tenantId: o.tenantId }, orderBy: { currentPeriodEnd: 'desc' } });
  if (licences.length) {
    const plan = await tx.plan.findUniqueOrThrow({ where: { code: licences[0].planCode! } });
    const qty = licences.reduce((n, i) => n + i.quantity, 0);
    const start = sub && sub.status === 'active' && sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + (CYCLE_MONTHS[o.cycle] ?? 12));
    if (sub) {
      // A trial (or a lapsed subscription) converts to the paid quantity; an active subscription adds the new licences.
      await tx.subscription.update({ where: { id: sub.id }, data: { planId: plan.id, licences: sub.status === 'active' ? sub.licences + qty : qty, status: 'active', trialEndsAt: null, currentPeriodEnd: end, period: o.cycle } });
      subId = sub.id;
    } else {
      subId = (await tx.subscription.create({ data: { tenantId: o.tenantId, planId: plan.id, period: o.cycle, licences: qty, status: 'active', currentPeriodEnd: end } })).id;
    }
    await tx.tenant.update({ where: { id: o.tenantId }, data: { status: 'active', statusChangedAt: new Date() } });
  } else subId = sub?.id ?? null;
  const inv = await issueInvoice(tx, o, subId, pay.paymentRef);
  await tx.tenantOrder.update({ where: { id: orderId }, data: { status: 'paid', paidAt: new Date(), paymentRef: pay.paymentRef, paidVia: pay.via, invoiceId: inv.id } });
  await appendAudit(tx, { tenantId: null, actorType: pay.actor.type, actorId: pay.actor.id ?? null, ip: pay.actor.ip ?? null, entity: 'order', entityId: orderId, action: 'platform.order_paid', newValue: { number: o.number, tenantId: o.tenantId, totalPaise: o.totalPaise, paymentRef: pay.paymentRef, via: pay.via, invoice: inv.number } });
  await appendAudit(tx, { tenantId: o.tenantId, actorType: pay.actor.type, actorId: pay.actor.id ?? null, entity: 'order', entityId: orderId, action: 'billing.order_paid', newValue: { number: o.number, totalPaise: o.totalPaise, via: pay.via, invoice: inv.number } });
  const admins = await billingAdmins(tx, o.tenantId);
  if (admins.length) await tx.notification.createMany({ data: admins.map((a) => ({ tenantId: o.tenantId, userId: a.id, type: 'billing', title: `Payment received for order ${o.number}`, body: `₹${(o.totalPaise / 100).toLocaleString('en-IN')} received. Invoice ${inv.number} is ready in Billing.`, link: '/app/billing' })) });
  return { applied: true as const, invoiceId: inv.id, invoiceNumber: inv.number };
}

/** UBOS's own Razorpay account (Platform Console → Signup & billing), or null when it is not set up. */
export async function platformGateway(p: PTx | PrismaClient) {
  const s = await platformSettings(p);
  if (!s.razorpayKeyId || !s.razorpaySecretEnc) return null;
  return { keyId: s.razorpayKeyId, secret: decrypt(s.razorpaySecretEnc), webhookSecret: s.razorpayWebhookSecretEnc ? decrypt(s.razorpayWebhookSecretEnc) : null, base: (s.razorpayApiBase || 'https://api.razorpay.com').replace(/\/$/, '') };
}
export type PlatformGateway = NonNullable<Awaited<ReturnType<typeof platformGateway>>>;

export async function platformRazorpay<T>(g: PlatformGateway, path: string, body?: unknown): Promise<T> {
  const url = `${g.base}${path}`;
  await assertPublicUrl(url);
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Basic ${Buffer.from(`${g.keyId}:${g.secret}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    .catch((e) => { throw new HttpException({ code: 'GATEWAY_UNREACHABLE', message: `Razorpay could not be reached: ${e instanceof Error ? e.message : e}` }, 502); });
  const out = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) throw new HttpException({ code: 'GATEWAY_REFUSED', message: `Razorpay refused this: ${out.error?.description ?? `HTTP ${res.status}`}` }, 502);
  return out;
}
