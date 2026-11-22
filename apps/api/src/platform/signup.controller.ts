import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { appendAudit, provisionTenant } from '@ubos/database';
import { GST_STATES, RESERVED_SLUGS, billingState, istClock, istInstant, isDay, validGstin } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { ctx } from '../common/context';
import { parse } from '../common/errors';
import { Mailer } from '../auth/mailer';
import { normalizeIp } from '../auth/ip';
import { PasswordRule } from '../modules/auth.controller';
import { rateLimit } from '../modules/integration-runtime';
import { PlatformGuard } from './platform.controller';
import { BillingLifecycle, platformSettings, usageMonth } from './billing-lifecycle';
import { applyOrderPaid, platformGateway } from './billing-orders';
import { invoiceView } from '../modules/billing.controller';
import { encrypt } from '../auth/crypto';
import { Logger } from '@nestjs/common';

const Email = z.string().trim().toLowerCase().email().max(160);
const Slug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/, 'Use 3–40 lowercase letters, numbers or dashes');
const Signup = z.object({
  email: Email, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'), orgName: z.string().trim().min(2).max(100), slug: Slug, name: z.string().trim().min(2).max(80), password: PasswordRule,
  businessLines: z.array(z.object({ name: z.string().trim().min(2).max(60), template: z.string().max(40).optional() })).min(1).max(5), industry: z.string().trim().max(40).optional(),
});
const hash = (email: string, code: string) => createHash('sha256').update(`${email}:${code}`).digest('hex');
const ipOf = (req: Request) => normalizeIp(req.ip) ?? 'unknown';

async function slugProblem(db: DbService, slug: string) {
  if (RESERVED_SLUGS.includes(slug)) return 'This name is reserved, choose another';
  if (await db.platform.tenant.findUnique({ where: { slug } })) return 'This organization code is taken';
  return null;
}

/** Self-serve trial signup: an emailed 6-digit code, then the organization is created with a trial. No login is needed. */
@Controller('public/v1/signup')
export class SignupController {
  constructor(private db: DbService, private mailer: Mailer) {}

  @Get('config')
  async config() {
    const s = await platformSettings(this.db.platform);
    const plan = await this.db.platform.plan.findUnique({ where: { code: s.trialPlanCode } });
    return { enabled: s.signupEnabled, trialDays: s.trialDays, licences: s.trialLicences, plan: plan?.name ?? null, maxBusinessLines: plan?.maxWorkspaces ?? null };
  }

  @Get('slug')
  async slug(@Query('slug') slug: string, @Req() req: Request) {
    rateLimit(`signup-slug:${ipOf(req)}`, 60);
    const ok = Slug.safeParse(slug ?? '');
    if (!ok.success) return { available: false, reason: 'Use 3–40 lowercase letters, numbers or dashes' };
    const reason = await slugProblem(this.db, ok.data);
    return { available: !reason, reason };
  }

  @Post('code')
  @HttpCode(200)
  async code(@Body() body: unknown, @Req() req: Request) {
    const { email } = parse(z.object({ email: Email }), body);
    rateLimit(`signup-ip:${ipOf(req)}`, 5);
    rateLimit(`signup-mail:${email}`, 3);
    if (!(await platformSettings(this.db.platform)).signupEnabled) throw new ForbiddenException({ code: 'SIGNUP_CLOSED', message: 'Sign-up is closed right now. Contact us to get started.' });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.platform.signupCode.create({ data: { email, codeHash: hash(email, code), expiresAt: new Date(Date.now() + 15 * 60_000), ip: ipOf(req) } });
    await this.mailer.send(email, `${code} is your UBOS sign-up code`, `Your UBOS sign-up code is ${code}. It works for 15 minutes. If you did not ask for it, ignore this email.`);
    return { sent: true };
  }

  @Post()
  async signup(@Body() body: unknown, @Req() req: Request) {
    const input = parse(Signup, body);
    rateLimit(`signup-post:${ipOf(req)}`, 10);
    const p = this.db.platform;
    const s = await platformSettings(p);
    if (!s.signupEnabled) throw new ForbiddenException({ code: 'SIGNUP_CLOSED', message: 'Sign-up is closed right now. Contact us to get started.' });
    const row = await p.signupCode.findFirst({ where: { email: input.email, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    const bad = () => new BadRequestException({ code: 'CODE_INVALID', message: 'The code is wrong or has expired. Ask for a new one.' });
    if (!row || row.attempts >= 5) throw bad();
    const a = Buffer.from(row.codeHash, 'hex'), b = Buffer.from(hash(input.email, input.code), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) { await p.signupCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } }); throw bad(); }
    const problem = await slugProblem(this.db, input.slug);
    if (problem) throw new ConflictException({ code: 'SLUG_TAKEN', message: problem });
    const plan = await p.plan.findUnique({ where: { code: s.trialPlanCode } });
    if (!plan) throw new BadRequestException({ code: 'PLAN_NOT_FOUND', message: 'Trials are not set up yet' });
    if (plan.maxWorkspaces !== null && input.businessLines.length > plan.maxWorkspaces) throw new BadRequestException({ code: 'PLAN_LIMIT_REACHED', message: `The trial allows up to ${plan.maxWorkspaces} business lines` });
    const names = input.businessLines.map((w) => w.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new BadRequestException({ code: 'DUPLICATE_WORKSPACE', message: 'Each business line can be added once' });
    const r = await p.$transaction(async (tx) => {
      const used = await tx.signupCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
      if (!used.count) throw bad();
      const made = await provisionTenant(tx, {
        name: input.orgName, slug: input.slug, industry: input.industry, planCode: plan.code, signedUpVia: 'self_serve', trial: { days: s.trialDays, licences: s.trialLicences },
        admin: { name: input.name, email: input.email, password: input.password }, workspaces: input.businessLines, actor: { type: 'system' },
      });
      await appendAudit(tx, { tenantId: made.tenant.id, actorType: 'system', ip: ipOf(req), entity: 'tenant', entityId: made.tenant.id, action: 'tenant.signed_up', newValue: { slug: input.slug, plan: plan.code, trialDays: s.trialDays } });
      return made;
    });
    return { slug: r.tenant.slug, trialDays: s.trialDays };
  }
}

const BillingBody = z.object({
  sellerName: z.string().trim().min(2).max(160), sellerGstin: z.string().trim().toUpperCase().refine((g) => !g || validGstin(g), 'Enter a valid GSTIN').nullable().optional(),
  sellerStateCode: z.string().refine((c) => c in GST_STATES, 'Choose the state'), sellerAddress: z.string().trim().min(5).max(500), sellerEmail: z.string().trim().email().max(160).nullable().optional().or(z.literal('')),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, 'Use up to 6 letters or digits'),
  razorpayKeyId: z.string().trim().max(60).nullable().optional(), razorpaySecret: z.string().trim().max(200).optional(), razorpayWebhookSecret: z.string().trim().max(200).optional(),
  razorpayApiBase: z.string().trim().url().max(200).nullable().optional().or(z.literal('')),
});
const SettingsBody = z.object({ signupEnabled: z.boolean(), trialDays: z.number().int().min(1).max(90), trialPlanCode: z.string().regex(/^[a-z0-9_]{2,40}$/), trialLicences: z.number().int().min(1).max(100), graceDays: z.number().int().min(0).max(60) });
const SubBody = z.object({ planCode: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(), licences: z.number().int().min(1).max(100_000).optional(), endsOn: z.string().refine(isDay, 'Enter a date').optional(), reason: z.string().trim().min(3).max(200) });

/** Platform Owner: signup and trial settings, changing a customer's subscription by hand, running the lifecycle, usage. */
@Controller('platform/v1')
@UseGuards(PlatformGuard)
export class PlatformBillingController {
  constructor(private db: DbService, private lifecycle: BillingLifecycle) {}

  private audit(entityId: string, tenantId: string | null, action: string, oldValue: unknown, newValue: unknown) {
    return appendAudit(this.db.platform, { tenantId, actorType: 'platform_user', actorId: ctx().platformUserId, ip: ctx().ip, entity: 'platform', entityId, action, oldValue, newValue });
  }

  @Get('settings')
  async settings() {
    const { razorpaySecretEnc, razorpayWebhookSecretEnc, ...rest } = await platformSettings(this.db.platform);
    return { ...rest, hasRazorpaySecret: !!razorpaySecretEnc, hasWebhookSecret: !!razorpayWebhookSecretEnc };
  }

  /** UBOS's own invoice details and Razorpay account. Secrets are write-only: blank keeps the saved one. */
  @Put('settings/billing')
  async saveBilling(@Body() body: unknown) {
    const input = parse(BillingBody, body);
    if (input.sellerGstin && input.sellerGstin.slice(0, 2) !== input.sellerStateCode) throw new BadRequestException({ code: 'GSTIN_STATE', message: 'The GSTIN belongs to a different state' });
    const data = {
      sellerName: input.sellerName, sellerGstin: input.sellerGstin || null, sellerStateCode: input.sellerStateCode, sellerAddress: input.sellerAddress, sellerEmail: input.sellerEmail || null, invoicePrefix: input.invoicePrefix,
      razorpayKeyId: input.razorpayKeyId || null, razorpayApiBase: input.razorpayApiBase || null,
      ...(input.razorpaySecret ? { razorpaySecretEnc: encrypt(input.razorpaySecret) } : {}), ...(input.razorpayWebhookSecret ? { razorpayWebhookSecretEnc: encrypt(input.razorpayWebhookSecret) } : {}),
      ...(!input.razorpayKeyId ? { razorpaySecretEnc: null, razorpayWebhookSecretEnc: null } : {}), updatedAt: new Date(),
    };
    await this.db.platform.platformSetting.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: data });
    const { razorpaySecret, razorpayWebhookSecret, ...shown } = input;
    await this.audit('default', null, 'platform.billing_settings_saved', null, { ...shown, razorpaySecretChanged: !!razorpaySecret, webhookSecretChanged: !!razorpayWebhookSecret });
    return this.settings();
  }

  @Get('invoices')
  async invoices() {
    const rows = await this.db.platform.platformInvoice.findMany({ orderBy: { issuedAt: 'desc' }, take: 300, select: { id: true, number: true, tenantId: true, totalPaise: true, gstPaise: true, issuedAt: true, status: true, orderId: true } });
    const tenants = new Map((await this.db.platform.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, name: true, slug: true } })).map((t) => [t.id, t]));
    return rows.map((r) => ({ ...r, tenant: tenants.get(r.tenantId) ?? null }));
  }

  @Get('invoices/:id')
  async invoice(@Param('id') id: string) {
    const inv = await this.db.platform.platformInvoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    return invoiceView(inv);
  }

  @Put('settings')
  async saveSettings(@Body() body: unknown) {
    const input = parse(SettingsBody, body);
    if (!(await this.db.platform.plan.findUnique({ where: { code: input.trialPlanCode } }))) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Unknown plan' });
    const old = await platformSettings(this.db.platform);
    const s = await this.db.platform.platformSetting.upsert({ where: { id: 'default' }, create: { id: 'default', ...input }, update: { ...input, updatedAt: new Date() } });
    await this.audit('default', null, 'platform.settings_saved', old, input);
    return s;
  }

  /** Extend a trial, give licences or move a customer to another plan by hand (with a reason, audited). */
  @Patch('tenants/:id/subscription')
  async subscription(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(SubBody, body);
    const p = this.db.platform;
    const sub = await p.subscription.findFirst({ where: { tenantId: id }, orderBy: { currentPeriodEnd: 'desc' } });
    if (!sub) throw new NotFoundException({ code: 'SUBSCRIPTION_NOT_FOUND', message: 'This organization has no subscription' });
    const plan = input.planCode ? await p.plan.findUnique({ where: { code: input.planCode } }) : null;
    if (input.planCode && !plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Unknown plan' });
    const end = input.endsOn ? istInstant(input.endsOn, '23:59') : undefined;
    const data = {
      ...(plan ? { planId: plan.id } : {}), ...(input.licences ? { licences: input.licences } : {}),
      ...(end ? (sub.status === 'trialing' ? { trialEndsAt: end, currentPeriodEnd: end } : { currentPeriodEnd: end, ...(sub.status === 'past_due' && end > new Date() ? { status: 'active' } : {}) }) : {}),
    };
    await p.subscription.update({ where: { id: sub.id }, data });
    await this.audit(sub.id, id, 'platform.subscription_changed', { planId: sub.planId, licences: sub.licences, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd }, { ...input });
    await this.lifecycle.run(true);
    return { ok: true, status: (await p.tenant.findUniqueOrThrow({ where: { id } })).status };
  }

  @Post('billing/run')
  @HttpCode(200)
  run() { return this.lifecycle.run(true); }

  @Get('tenants/:id/usage')
  async usage(@Param('id') id: string, @Query('month') month?: string) {
    const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : istClock(new Date()).day.slice(0, 7);
    const p = this.db.platform;
    const t = await p.tenant.findUnique({ where: { id }, include: { subscriptions: { include: { plan: true }, orderBy: { currentPeriodEnd: 'desc' }, take: 1 } } });
    if (!t) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Organization not found' });
    const s = await platformSettings(p);
    const sub = t.subscriptions[0];
    return { month: m, usage: await usageMonth(p, id, m), billing: sub ? billingState(sub, s.graceDays) : null, signedUpVia: t.signedUpVia };
  }
}

interface RzpEvent { event?: string; payload?: { payment_link?: { entity?: { id?: string } }; payment?: { entity?: { id?: string; amount?: number } } } }

/** Razorpay webhooks for UBOS's own account: a paid link applies its order. Signed with the webhook secret; repeats change nothing. */
@Controller('public/v1/razorpay')
export class PlatformRazorpayWebhook {
  private readonly log = new Logger('PlatformRazorpay');
  constructor(private db: DbService) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request, @Body() body: RzpEvent) {
    const g = await platformGateway(this.db.platform);
    const raw = (req as { rawBody?: Buffer }).rawBody, sig = req.headers['x-razorpay-signature'];
    const want = g?.webhookSecret && raw ? Buffer.from(createHmac('sha256', g.webhookSecret).update(raw).digest('hex')) : null;
    const got = typeof sig === 'string' ? Buffer.from(sig) : null;
    if (!want || !got || want.length !== got.length || !timingSafeEqual(want, got)) throw new BadRequestException({ code: 'BAD_SIGNATURE', message: 'Signature does not match' });
    const linkId = body.payload?.payment_link?.entity?.id;
    if (!linkId) return { ok: true, ignored: true };
    const o = await this.db.platform.tenantOrder.findUnique({ where: { paymentLinkId: linkId } });
    if (!o) return { ok: true, ignored: true };
    if (body.event === 'payment_link.expired' || body.event === 'payment_link.cancelled') {
      await this.db.platform.tenantOrder.updateMany({ where: { id: o.id, status: 'pending', paymentLinkId: linkId }, data: { paymentLinkId: null, paymentLinkUrl: null, paymentLinkExpiresAt: null } });
      return { ok: true };
    }
    if (body.event !== 'payment_link.paid') return { ok: true, ignored: true };
    const pay = body.payload?.payment?.entity;
    if (!pay?.id || !pay.amount) return { ok: true, ignored: true };
    if (pay.amount < o.totalPaise) { this.log.warn(`Order ${o.number}: paid ${pay.amount} of ${o.totalPaise}; not applied`); return { ok: true, ignored: true }; }
    const r = await this.db.platform.$transaction((tx) => applyOrderPaid(tx, o.id, { paymentRef: pay.id!, via: 'online', actor: { type: 'system' } }));
    return { ok: true, applied: r.applied };
  }
}
