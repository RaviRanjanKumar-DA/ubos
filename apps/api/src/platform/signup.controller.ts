import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { appendAudit, provisionTenant } from '@ubos/database';
import { RESERVED_SLUGS, billingState, istClock, istInstant, isDay } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { ctx } from '../common/context';
import { parse } from '../common/errors';
import { Mailer } from '../auth/mailer';
import { normalizeIp } from '../auth/ip';
import { PasswordRule } from '../modules/auth.controller';
import { rateLimit } from '../modules/integration-runtime';
import { PlatformGuard } from './platform.controller';
import { BillingLifecycle, platformSettings, usageMonth } from './billing-lifecycle';

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
  settings() { return platformSettings(this.db.platform); }

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
