import {
  Body, CanActivate, ConflictException, Controller, ExecutionContext, Get, Injectable, NotFoundException,
  Param, Patch, Post, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { appendAudit, provisionTenant, slugify } from '@ubos/database';
import { DbService } from '../common/db.service';
import { ctx } from '../common/context';
import { parse } from '../common/errors';

/** Platform staff guard. Uses a separate signing secret, so tenant tokens can never reach these routes. */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private jwt: JwtService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const token = (req.headers.authorization as string | undefined)?.replace(/^Bearer /, '');
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Login required' });
    try {
      const p = await this.jwt.verifyAsync(token, { secret: process.env.JWT_PLATFORM_SECRET });
      if (p.typ !== 'platform') throw new Error();
      ctx().platformUserId = p.sub;
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Session expired, please log in again' });
    }
  }
}

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
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
  constructor(private db: DbService, private jwt: JwtService) {}

  @Post('auth/login')
  async login(@Body() body: unknown) {
    const { email, password } = parse(LoginBody, body);
    const user = await this.db.platform.platformUser.findUnique({ where: { email: email.toLowerCase() } });
    const ok = !!user && user.isActive && (await bcrypt.compare(password, user.passwordHash));
    await this.db.platform.$transaction((tx) =>
      appendAudit(tx, {
        tenantId: null, actorType: 'platform_user', actorId: user?.id ?? null, ip: ctx().ip,
        entity: 'platform_user', entityId: user?.id ?? email.toLowerCase(),
        action: ok ? 'platform.login' : 'platform.login_failed',
      }),
    );
    if (!ok) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' });
    const accessToken = await this.jwt.signAsync(
      { sub: user!.id, typ: 'platform', role: user!.role },
      { secret: process.env.JWT_PLATFORM_SECRET, expiresIn: '8h' },
    );
    return { accessToken, user: { id: user!.id, name: user!.name, email: user!.email, role: user!.role } };
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
