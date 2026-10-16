import { Body, Controller, Get, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { DbService } from '../common/db.service';
import { Public } from '../common/auth.guard';
import { auth, ctx } from '../common/context';
import { parse } from '../common/errors';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

@Controller('api/v1/auth')
export class AuthController {
  constructor(private db: DbService, private jwt: JwtService) {}

  @Public()
  @Post('login')
  async login(@Body() body: unknown) {
    const { email, password } = parse(LoginBody, body);
    const user = await this.db.tenant((tx) => tx.user.findUnique({
      where: { tenantId_email: { tenantId: ctx().tenant!.id, email: email.toLowerCase() } },
    }));
    const ok = !!user && user.isActive && (await bcrypt.compare(password, user.passwordHash));
    await this.db.tenant((tx) =>
      this.db.audit(tx, {
        entity: 'user', entityId: user?.id ?? email.toLowerCase(),
        action: ok ? 'auth.login' : 'auth.login_failed', actorId: user?.id ?? null,
        actorType: 'tenant_user',
      }),
    );
    if (!ok) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' });

    const accessToken = await this.jwt.signAsync(
      { sub: user!.id, tid: ctx().tenant!.id, typ: 'tenant' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '8h' },
    );
    return { accessToken, user: { id: user!.id, name: user!.name, email: user!.email } };
  }

  /** Who am I, what can I do here, which workspaces can I switch to. */
  @Get('me')
  async me() {
    const a = auth();
    const t = ctx().tenant!;
    const { workspaces, sub } = await this.db.tenant(async (tx) => ({
      workspaces: await tx.workspace.findMany({
        where: { id: { in: a.accessibleWorkspaceIds } }, orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true },
      }),
      sub: await tx.subscription.findFirst({ include: { plan: true }, orderBy: { currentPeriodEnd: 'desc' } }),
    }));
    return {
      user: { id: a.userId, name: a.name, email: a.email },
      tenant: { name: t.name, slug: t.slug, status: t.status, plan: sub?.plan.name, trialEndsAt: sub?.trialEndsAt },
      roles: a.assignments.map((r) => ({ role: r.roleName, workspaceId: r.workspaceId })),
      workspaces,
      currentWorkspaceId: a.workspaceId,
      permissions: a.permissions,
      features: [...a.features],
    };
  }
}
