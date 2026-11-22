import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, ExecutionContext, Get, HttpCode, HttpException, Injectable,
  NotFoundException, Param, Patch, Post, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { appendAudit, provisionTenant, slugify } from '@ubos/database';
import type { Tx } from '@ubos/database';
import { FEATURES, FeatureKey } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { ctx } from '../common/context';
import { parse } from '../common/errors';
import { CYCLE_MONTHS } from '../modules/billing.controller';
import { decrypt } from '../auth/crypto';
import { normalizeIp } from '../auth/ip';
import { SessionService } from '../auth/sessions';
import { authTransaction, CommitThenThrow } from '../auth/tx';
import { setupGuide } from '../common/setup-guide';
import { applyOrderPaid } from './billing-orders';

/** Platform staff guard: separate cookies and signing secret, so tenant sessions can never reach these routes. */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private sessions: SessionService, private db: DbService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const token = this.sessions.tokenFrom(req, 'platform');
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Login required' });
    const claims = await this.sessions.verifyAccess('platform', token);
    const session = await this.db.platform.session.findUnique({ where: { id: claims.sid } });
    if (!session || session.revokedAt || session.platformUserId !== claims.sub) {
      throw new UnauthorizedException({ code: 'SESSION_REVOKED', message: 'You were signed out, please log in again' });
    }
    ctx().platformUserId = claims.sub;
    (req as Request & { platformSessionId?: string }).platformSessionId = session.id;
    return true;
  }
}

const PLATFORM_IDLE_MINUTES = 8 * 60;
const PLATFORM_MAX_FAILED = 5;
const PLATFORM_LOCK_MINUTES = 15;

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1), code: z.string().regex(/^\d{6}$/).optional() });
const CreateTenant = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().regex(/^[a-z0-9-]{3,40}$/, 'Use 3–40 lowercase letters, numbers or dashes').optional(),
  industry: z.string().max(40).optional(),
  planCode: z.string().trim().regex(/^[a-z0-9_]{2,40}$/),
  adminName: z.string().trim().min(2).max(80),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(10, 'At least 10 characters'),
  // A ready business line ({ name, template }) or a custom name.
  workspaces: z.array(z.union([z.string().trim().min(2).max(60), z.object({ name: z.string().trim().min(2).max(60), template: z.string().max(40).optional() })])).min(1).max(20),
});
const Features = z.array(z.enum(Object.keys(FEATURES) as [FeatureKey, ...FeatureKey[]])).max(30);
const PlanBody = z.object({
  name: z.string().trim().min(2).max(60),
  pricePerUserPaise: z.number().int().min(0).max(100_000_00),
  maxWorkspaces: z.number().int().min(1).max(1000).nullable(),
  storageGbPerUser: z.number().int().min(0).max(1000),
  aiCreditsPerUser: z.number().int().min(0).max(100_000),
  recordingRetentionDays: z.number().int().min(0).max(3650).default(90),
  isPublic: z.boolean(),
  features: Features.min(1, 'Pick at least one module'),
});
const NewPlan = PlanBody.extend({
  code: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, 'Code: 2–40 lowercase letters, numbers or _'),
  // Also put it on sale on the organizations' Billing page as a licence at the same price.
  sellAsLicence: z.boolean().default(true),
  annualDiscountPct: z.number().int().min(0).max(90).default(0),
});
const ProductBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(200).nullable().optional(),
  priceMonthlyPaise: z.number().int().min(0).max(100_000_00).nullable().optional(),
  priceOncePaise: z.number().int().min(0).max(10_000_000_00).nullable().optional(),
  annualDiscountPct: z.number().int().min(0).max(90).optional(),
  isActive: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
}).partial();
const NewProduct = ProductBody.required({ name: true }).extend({
  code: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, 'Code: 2–40 lowercase letters, numbers or _'),
  kind: z.enum(['licence', 'service']),
  planCode: z.string().max(40).nullable().optional(),
});
const SetStatus = z.object({ status: z.enum(['active', 'suspended']) });

@Controller('platform/v1')
export class PlatformController {
  constructor(private db: DbService, private sessions: SessionService) {}

  /** Platform staff sign-in. If 2FA is on, the 6-digit authenticator code must be sent with the password. */
  @Post('auth/login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password, code } = parse(LoginBody, body);
    return authTransaction((fn) => this.db.platform.$transaction(fn), async (tx) => {
      const user = await tx.platformUser.findUnique({ where: { email: email.toLowerCase() } });
      const audit = (action: string) => appendAudit(tx, {
        tenantId: null, actorType: 'platform_user', actorId: user?.id ?? null, ip: normalizeIp(req.ip),
        entity: 'platform_user', entityId: user?.id ?? email.toLowerCase(), action,
      });
      if (user?.lockedUntil && user.lockedUntil > new Date()) {
        throw new HttpException({ code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.' }, 423);
      }
      const passwordOk = !!user && user.isActive && (await bcrypt.compare(password, user.passwordHash));
      if (passwordOk && user!.totpEnabled && !code) return { mfaRequired: true as const };
      const codeOk = !user?.totpEnabled || (!!code && !!user.totpSecret && authenticator.check(code, decrypt(user.totpSecret)));
      if (!passwordOk || !codeOk) {
        if (user) {
          const failed = user.failedLogins + 1;
          const lock = failed >= PLATFORM_MAX_FAILED;
          await tx.platformUser.update({
            where: { id: user.id },
            data: lock ? { failedLogins: 0, lockedUntil: new Date(Date.now() + PLATFORM_LOCK_MINUTES * 60_000) } : { failedLogins: failed },
          });
        }
        await audit('platform.login_failed');
        throw new CommitThenThrow(new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Wrong email, password or code' }));
      }
      await tx.platformUser.update({ where: { id: user!.id }, data: { failedLogins: 0, lockedUntil: null } });
      const { accessToken } = await this.sessions.issue(tx, 'platform', { userId: user!.id }, req, res);
      await audit('platform.login');
      return { mfaRequired: false as const, accessToken, user: { id: user!.id, name: user!.name, email: user!.email, role: user!.role } };
    });
  }

  @Post('auth/refresh')
  @HttpCode(200)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return authTransaction((fn) => this.db.platform.$transaction(fn), (tx) =>
      this.sessions.refresh(tx, 'platform', req, res, PLATFORM_IDLE_MINUTES));
  }

  @UseGuards(PlatformGuard)
  @Post('auth/logout')
  @HttpCode(200)
  async logout(@Req() req: Request & { platformSessionId?: string }, @Res({ passthrough: true }) res: Response) {
    await this.db.platform.$transaction(async (tx) => {
      await this.sessions.revoke(tx, req.platformSessionId!, 'logout');
      await appendAudit(tx, {
        tenantId: null, actorType: 'platform_user', actorId: ctx().platformUserId, ip: normalizeIp(req.ip),
        entity: 'session', entityId: req.platformSessionId!, action: 'platform.logout',
      });
    });
    this.sessions.clear(res, 'platform');
    return { ok: true };
  }

  @UseGuards(PlatformGuard)
  @Get('auth/me')
  async me() {
    const u = await this.db.platform.platformUser.findUniqueOrThrow({ where: { id: ctx().platformUserId } });
    return { id: u.id, name: u.name, email: u.email, role: u.role, totpEnabled: u.totpEnabled };
  }

  @UseGuards(PlatformGuard)
  @Get('plans')
  async plans() {
    const [plans, subs] = await Promise.all([
      this.db.platform.plan.findMany({ include: { features: true }, orderBy: { pricePerUserPaise: 'asc' } }),
      this.db.platform.subscription.groupBy({ by: ['planId'], _count: true, where: { status: { in: ['active', 'trialing'] } } }),
    ]);
    const count = new Map(subs.map((x) => [x.planId, x._count]));
    return plans.map((p) => ({ ...p, organizations: count.get(p.id) ?? 0 }));
  }

  /** All customer organizations with plan, status and size. Counts only — no tenant business data. */
  @UseGuards(PlatformGuard)
  @Get('tenants')
  async tenants() {
    const tenants = await this.db.platform.tenant.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        subscriptions: { include: { plan: true }, orderBy: { currentPeriodEnd: 'desc' }, take: 1 },
        _count: { select: { users: true, workspaces: true } },
      },
    });
    // Setup Guide progress per organization (built steps only) — helps onboard new customers.
    const setup = new Map(await Promise.all(tenants.map(async (t) => [t.id, (await setupGuide(this.db.platform, t.id)).available] as const)));
    return tenants.map((t) => {
      const s = t.subscriptions[0];
      return {
        id: t.id, name: t.name, slug: t.slug, status: t.status, industry: t.industry, isInternal: t.isInternal,
        plan: s?.plan.name, planCode: s?.plan.code, licences: s?.licences, subscriptionStatus: s?.status,
        trialEndsAt: s?.trialEndsAt, endsAt: s ? (s.status === 'trialing' ? s.trialEndsAt : s.currentPeriodEnd) : null, signedUpVia: t.signedUpVia, statusChangedAt: t.statusChangedAt, users: t._count.users, workspaces: t._count.workspaces, createdAt: t.createdAt, setup: setup.get(t.id),
        mrrPaise: s && !t.isInternal && s.status === 'active' ? s.licences * s.plan.pricePerUserPaise : 0,
      };
    });
  }

  @UseGuards(PlatformGuard)
  @Post('tenants')
  async createTenant(@Body() body: unknown) {
    const input = parse(CreateTenant, body);
    const slug = input.slug ?? slugify(input.name);
    if (!(await this.db.platform.plan.findUnique({ where: { code: input.planCode } }))) {
      throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Unknown plan' });
    }
    const names = input.workspaces.map((w) => (typeof w === 'string' ? w : w.name).toLowerCase());
    if (new Set(names).size !== names.length) throw new ConflictException({ code: 'DUPLICATE_WORKSPACE', message: 'Each business line can be added once' });
    if (await this.db.platform.tenant.findUnique({ where: { slug } })) {
      throw new ConflictException({ code: 'SLUG_TAKEN', message: `Organization code "${slug}" is already in use` });
    }
    try {
      const r = await this.db.platform.$transaction((tx) =>
        provisionTenant(tx, {
          name: input.name, slug, industry: input.industry, planCode: input.planCode,
          admin: { name: input.adminName, email: input.adminEmail, password: input.adminPassword },
          workspaces: input.workspaces.map((w) => (typeof w === 'string' ? { name: w } : w)),
          actor: { type: 'platform_user', id: ctx().platformUserId },
        }),
      );
      return { id: r.tenant.id, slug: r.tenant.slug, status: r.tenant.status, workspaces: r.workspaces.map((w) => w.name) };
    } catch (e) {
      if (e instanceof Error && e.message.includes('allows at most')) {
        throw new ConflictException({ code: 'PLAN_LIMIT_REACHED', message: e.message });
      }
      throw e;
    }
  }

  @UseGuards(PlatformGuard)
  @Patch('tenants/:id/status')
  async setStatus(@Param('id') id: string, @Body() body: unknown) {
    const { status } = parse(SetStatus, body);
    return this.db.platform.$transaction(async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id } });
      if (!t) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Organization not found' });
      await tx.tenant.update({ where: { id }, data: { status } });
      await appendAudit(tx, {
        tenantId: null, actorType: 'platform_user', actorId: ctx().platformUserId, ip: ctx().ip,
        entity: 'tenant', entityId: id, action: `tenant.${status === 'active' ? 'reactivated' : 'suspended'}`,
        oldValue: { status: t.status }, newValue: { status },
      });
      return { id, status };
    });
  }

  /** Orders from all organizations (billing). */
  @UseGuards(PlatformGuard)
  @Get('orders')
  async orders() {
    const orders = await this.db.platform.tenantOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 300 });
    const tenants = new Map((await this.db.platform.tenant.findMany({ where: { id: { in: [...new Set(orders.map((o) => o.tenantId))] } }, select: { id: true, name: true, slug: true } })).map((t) => [t.id, t]));
    return orders.map((o) => ({ ...o, tenant: tenants.get(o.tenantId) ?? null }));
  }

  @UseGuards(PlatformGuard)
  @Get('products')
  products() {
    return this.db.platform.platformProduct.findMany({ orderBy: { position: 'asc' } });
  }

  // ── Plans (packages) & products. Prices are edited here; a change applies to new orders, trials and renewals.
  // Orders already placed keep the price they were placed at (each order stores its own line prices).

  @UseGuards(PlatformGuard)
  @Post('plans')
  createPlan(@Body() body: unknown) {
    const input = parse(NewPlan, body);
    return this.db.platform.$transaction(async (tx) => {
      if (await tx.plan.findUnique({ where: { code: input.code } })) throw new ConflictException({ code: 'CODE_TAKEN', message: `Plan code "${input.code}" is already in use` });
      if (input.sellAsLicence && (await tx.platformProduct.findUnique({ where: { code: input.code } }))) {
        throw new ConflictException({ code: 'CODE_TAKEN', message: `A product with code "${input.code}" already exists` });
      }
      const plan = await tx.plan.create({
        data: {
          code: input.code, name: input.name, pricePerUserPaise: input.pricePerUserPaise, maxWorkspaces: input.maxWorkspaces,
          storageGbPerUser: input.storageGbPerUser, aiCreditsPerUser: input.aiCreditsPerUser, recordingRetentionDays: input.recordingRetentionDays, isPublic: input.isPublic,
          billingPeriods: ['quarterly', 'annual'], features: { create: [...new Set(input.features)].map((featureKey) => ({ featureKey })) },
        },
      });
      if (input.sellAsLicence) {
        const last = await tx.platformProduct.findFirst({ orderBy: { position: 'desc' } });
        await tx.platformProduct.create({
          data: { code: input.code, name: input.name, kind: 'licence', planCode: input.code, priceMonthlyPaise: input.pricePerUserPaise, annualDiscountPct: input.annualDiscountPct, position: (last?.position ?? 0) + 1 },
        });
      }
      await this.platformAudit(tx, 'plan', plan.id, 'platform.plan_created', null, { code: plan.code, name: plan.name, pricePerUserPaise: plan.pricePerUserPaise, features: input.features });
      return plan;
    });
  }

  @UseGuards(PlatformGuard)
  @Patch('plans/:code')
  updatePlan(@Param('code') code: string, @Body() body: unknown) {
    const input = parse(PlanBody.partial(), body);
    return this.db.platform.$transaction(async (tx) => {
      const old = await tx.plan.findUnique({ where: { code }, include: { features: true } });
      if (!old) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan not found' });
      const { features, ...data } = input;
      if (data.maxWorkspaces !== undefined && data.maxWorkspaces !== null) {
        const subs = await tx.subscription.findMany({ where: { planId: old.id, status: { in: ['active', 'trialing'] } }, select: { tenantId: true } });
        for (const sub of subs) {
          const n = await tx.workspace.count({ where: { tenantId: sub.tenantId, isArchived: false } });
          if (n > data.maxWorkspaces) throw new ConflictException({ code: 'PLAN_LIMIT_IN_USE', message: `An organization on this plan already uses ${n} workspaces — the limit cannot go below that` });
        }
      }
      const plan = await tx.plan.update({ where: { code }, data });
      if (features) {
        await tx.planFeature.deleteMany({ where: { planId: old.id } });
        await tx.planFeature.createMany({ data: [...new Set(features)].map((featureKey) => ({ planId: old.id, featureKey })) });
      }
      await this.platformAudit(tx, 'plan', old.id, 'platform.plan_updated',
        { name: old.name, pricePerUserPaise: old.pricePerUserPaise, maxWorkspaces: old.maxWorkspaces, isPublic: old.isPublic, features: old.features.map((f) => f.featureKey) },
        input);
      return plan;
    });
  }

  @UseGuards(PlatformGuard)
  @Post('products')
  createProduct(@Body() body: unknown) {
    const input = parse(NewProduct, body);
    return this.db.platform.$transaction(async (tx) => {
      if (await tx.platformProduct.findUnique({ where: { code: input.code } })) throw new ConflictException({ code: 'CODE_TAKEN', message: `Product code "${input.code}" is already in use` });
      await this.checkProduct(tx, input.kind, input.planCode ?? null, input.priceMonthlyPaise ?? null, input.priceOncePaise ?? null);
      const last = await tx.platformProduct.findFirst({ orderBy: { position: 'desc' } });
      const product = await tx.platformProduct.create({
        data: {
          code: input.code, name: input.name, description: input.description ?? null, kind: input.kind,
          planCode: input.kind === 'licence' ? input.planCode! : null,
          priceMonthlyPaise: input.kind === 'licence' ? input.priceMonthlyPaise! : null,
          priceOncePaise: input.kind === 'service' ? input.priceOncePaise! : null,
          annualDiscountPct: input.kind === 'licence' ? input.annualDiscountPct ?? 0 : 0,
          isActive: input.isActive ?? true, position: input.position ?? (last?.position ?? 0) + 1,
        },
      });
      await this.platformAudit(tx, 'product', product.id, 'platform.product_created', null, product);
      return product;
    });
  }

  @UseGuards(PlatformGuard)
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ProductBody, body);
    return this.db.platform.$transaction(async (tx) => {
      const old = await tx.platformProduct.findUnique({ where: { id } });
      if (!old) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
      const monthly = input.priceMonthlyPaise !== undefined ? input.priceMonthlyPaise : old.priceMonthlyPaise;
      const once = input.priceOncePaise !== undefined ? input.priceOncePaise : old.priceOncePaise;
      await this.checkProduct(tx, old.kind, old.planCode, monthly, once);
      const product = await tx.platformProduct.update({
        where: { id },
        data: { ...input, ...(old.kind === 'licence' ? { priceOncePaise: null } : { priceMonthlyPaise: null, annualDiscountPct: 0 }) },
      });
      await this.platformAudit(tx, 'product', id, 'platform.product_updated',
        { name: old.name, priceMonthlyPaise: old.priceMonthlyPaise, priceOncePaise: old.priceOncePaise, annualDiscountPct: old.annualDiscountPct, isActive: old.isActive }, input);
      return product;
    });
  }

  private async checkProduct(tx: Tx, kind: string, planCode: string | null, monthly: number | null, once: number | null) {
    if (kind === 'licence') {
      if (!planCode || !(await tx.plan.findUnique({ where: { code: planCode } }))) throw new BadRequestException({ code: 'PLAN_REQUIRED', message: 'A licence must activate an existing plan' });
      if (monthly === null) throw new BadRequestException({ code: 'PRICE_REQUIRED', message: 'Enter the price per user per month' });
    } else if (once === null) {
      throw new BadRequestException({ code: 'PRICE_REQUIRED', message: 'Enter the one-time price' });
    }
  }

  private platformAudit(tx: Tx, entity: string, entityId: string, action: string, oldValue: unknown, newValue: unknown) {
    return appendAudit(tx, {
      tenantId: null, actorType: 'platform_user', actorId: ctx().platformUserId, ip: ctx().ip,
      entity, entityId, action, oldValue: oldValue as never, newValue: newValue as never,
    });
  }

  /**
   * Marks a pending order as paid (bank transfer / UPI / cash until a payment gateway is connected) and applies it:
   * licence lines switch the subscription to that plan, add the user licences and extend validity by the cycle.
   */
  @UseGuards(PlatformGuard)
  @Post('orders/:id/mark-paid')
  @HttpCode(200)
  markPaid(@Param('id') id: string, @Body() body: unknown) {
    const { paymentRef } = parse(z.object({ paymentRef: z.string().trim().min(2).max(100) }), body);
    return this.db.platform.$transaction(async (tx) => {
      const r = await applyOrderPaid(tx, id, { paymentRef, via: 'manual', actor: { type: 'platform_user', id: ctx().platformUserId, ip: ctx().ip } });
      if (!r.applied && r.reason === 'ORDER_NOT_FOUND') throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      if (!r.applied) throw new ConflictException({ code: 'ORDER_NOT_PENDING', message: 'Only pending orders can be marked paid' });
      return { ok: true, invoiceNumber: r.invoiceNumber };
    });
  }

  @UseGuards(PlatformGuard)
  @Get('metrics')
  async metrics() {
    const list = await this.tenants();
    const paying = list.filter((t) => t.mrrPaise > 0);
    const mrr = paying.reduce((s, t) => s + t.mrrPaise, 0);
    return {
      mrrPaise: mrr,
      arrPaise: mrr * 12,
      tenants: list.length,
      paying: paying.length,
      trials: list.filter((t) => t.subscriptionStatus === 'trialing').length,
      suspended: list.filter((t) => t.status === 'suspended').length,
      users: list.reduce((s, t) => s + t.users, 0),
    };
  }
}
