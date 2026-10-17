import {
  Body, CanActivate, ConflictException, Controller, ExecutionContext, Get, HttpCode, HttpException, Injectable,
  NotFoundException, Param, Patch, Post, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { appendAudit, provisionTenant, slugify } from '@ubos/database';
import { DbService } from '../common/db.service';
import { ctx } from '../common/context';
import { parse } from '../common/errors';
import { CYCLE_MONTHS } from '../modules/billing.controller';
import { decrypt } from '../auth/crypto';
import { normalizeIp } from '../auth/ip';
import { SessionService } from '../auth/sessions';
import { authTransaction, CommitThenThrow } from '../auth/tx';

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
  planCode: z.enum(['starter', 'growth', 'business', 'enterprise']),
  adminName: z.string().trim().min(2).max(80),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(10, 'At least 10 characters'),
  workspaces: z.array(z.string().trim().min(2).max(60)).min(1).max(20),
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
  plans() {
    return this.db.platform.plan.findMany({ include: { features: true }, orderBy: { pricePerUserPaise: 'asc' } });
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
    return tenants.map((t) => {
      const s = t.subscriptions[0];
      return {
        id: t.id, name: t.name, slug: t.slug, status: t.status, industry: t.industry, isInternal: t.isInternal,
        plan: s?.plan.name, planCode: s?.plan.code, licences: s?.licences, subscriptionStatus: s?.status,
        trialEndsAt: s?.trialEndsAt, users: t._count.users, workspaces: t._count.workspaces, createdAt: t.createdAt,
        mrrPaise: s && !t.isInternal && s.status === 'active' ? s.licences * s.plan.pricePerUserPaise : 0,
      };
    });
  }

  @UseGuards(PlatformGuard)
  @Post('tenants')
  async createTenant(@Body() body: unknown) {
    const input = parse(CreateTenant, body);
    const slug = input.slug ?? slugify(input.name);
    if (await this.db.platform.tenant.findUnique({ where: { slug } })) {
      throw new ConflictException({ code: 'SLUG_TAKEN', message: `Organization code "${slug}" is already in use` });
    }
    try {
      const r = await this.db.platform.$transaction((tx) =>
        provisionTenant(tx, {
          name: input.name, slug, industry: input.industry, planCode: input.planCode,
          admin: { name: input.adminName, email: input.adminEmail, password: input.adminPassword },
          workspaces: input.workspaces.map((name) => ({ name })),
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
      const o = await tx.tenantOrder.findUnique({ where: { id } });
      if (!o) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      if (o.status !== 'pending') throw new ConflictException({ code: 'ORDER_NOT_PENDING', message: 'Only pending orders can be marked paid' });
      const items = o.items as { kind: string; planCode?: string | null; quantity: number }[];
      const licences = items.filter((i) => i.kind === 'licence');
      if (licences.length) {
        const plan = await tx.plan.findUniqueOrThrow({ where: { code: licences[0].planCode! } });
        const qty = licences.reduce((n, i) => n + i.quantity, 0);
        const sub = await tx.subscription.findFirst({ where: { tenantId: o.tenantId }, orderBy: { currentPeriodEnd: 'desc' } });
        const start = sub && sub.status === 'active' && sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
        const end = new Date(start);
        end.setMonth(end.getMonth() + (CYCLE_MONTHS[o.cycle] ?? 12));
        if (sub) {
          // A trial converts to the paid quantity; an active subscription adds the new licences.
          await tx.subscription.update({
            where: { id: sub.id },
            data: { planId: plan.id, licences: sub.status === 'active' ? sub.licences + qty : qty, status: 'active', trialEndsAt: null, currentPeriodEnd: end, period: o.cycle },
          });
        } else {
          await tx.subscription.create({ data: { tenantId: o.tenantId, planId: plan.id, period: o.cycle, licences: qty, status: 'active', currentPeriodEnd: end } });
        }
        await tx.tenant.update({ where: { id: o.tenantId }, data: { status: 'active' } });
      }
      await tx.tenantOrder.update({ where: { id }, data: { status: 'paid', paidAt: new Date(), paymentRef } });
      await appendAudit(tx, {
        tenantId: null, actorType: 'platform_user', actorId: ctx().platformUserId, ip: ctx().ip,
        entity: 'order', entityId: id, action: 'platform.order_paid', newValue: { number: o.number, tenantId: o.tenantId, totalPaise: o.totalPaise, paymentRef },
      });
      return { ok: true };
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
