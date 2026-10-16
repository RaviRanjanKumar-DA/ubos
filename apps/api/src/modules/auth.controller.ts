import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Post, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { z } from 'zod';
import { DbService } from '../common/db.service';
import { Public } from '../common/auth.guard';
import { auth, ctx, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { decrypt, encrypt, randomCode, sha256 } from '../auth/crypto';
import { authTransaction, CommitThenThrow, TenantLoginService } from '../auth/login.service';
import { Mailer } from '../auth/mailer';
import { SessionService } from '../auth/sessions';
import { oauthConfigured } from '../auth/oauth.controller';

authenticator.options = { window: 1 };

const LoginBody = z.object({
  identifier: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().max(120).optional(), // backwards compatible with Phase 0 clients
  password: z.string().min(1).max(200),
});
const CodeRequest = z.object({ email: z.string().email() });
const CodeVerify = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) });
const MfaVerify = z.object({ mfaToken: z.string().min(10), code: z.string().regex(/^\d{6}$/) });
const TotpCode = z.object({ code: z.string().regex(/^\d{6}$/) });
export const PasswordRule = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letters and numbers');
const ChangePassword = z.object({ currentPassword: z.string().min(1), newPassword: PasswordRule });

const GENERIC_CODE_REPLY = { sent: true, message: 'If this email belongs to an active user, a 6-digit code has been sent.' };

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private db: DbService,
    private login: TenantLoginService,
    private sessions: SessionService,
    private mailer: Mailer,
  ) {}

  /** Which sign-in options to show on this organization's login page. */
  @Public()
  @Get('methods')
  async methods() {
    const s = await this.db.tenant((tx) => this.login.settings(tx, tenantId()));
    return {
      organization: ctx().tenant!.name,
      methods: s.loginMethods.filter((m) => m === 'password' || m === 'email_code' || oauthConfigured(m)),
    };
  }

  /** Username / email / mobile + password. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async passwordLogin(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(LoginBody, body);
    const identifier = input.identifier ?? input.email;
    if (!identifier) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Enter your email, username or mobile' });
    return authTransaction((fn) => this.db.tenant(fn), async (tx) => {
      const settings = await this.login.settings(tx, tenantId());
      this.login.assertMethodAllowed(settings, 'password');
      const user = await this.login.findByIdentifier(tx, identifier);
      if (user) this.login.assertNotLocked(user);
      const ok = !!user && (await bcrypt.compare(input.password, user.passwordHash));
      if (!ok) {
        const error = new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Wrong email/username or password' });
        if (user) return this.login.registerFailure(tx, user, settings, req, 'password', error);
        await this.db.audit(tx, {
          entity: 'user', entityId: identifier.toLowerCase(), action: 'auth.login_failed', actorType: 'tenant_user',
          newValue: { method: 'password', unknownUser: true },
        });
        throw new CommitThenThrow(error);
      }
      return this.login.complete(tx, user!, 'password', req, res);
    });
  }

  /** Step 1 of "Sign in with email code". Always answers the same, so it cannot be used to discover accounts. */
  @Public()
  @Post('email-code/request')
  @HttpCode(200)
  async requestCode(@Body() body: unknown) {
    const { email } = parse(CodeRequest, body);
    const org = ctx().tenant!;
    const sent = await this.db.tenant(async (tx) => {
      const settings = await this.login.settings(tx, org.id);
      this.login.assertMethodAllowed(settings, 'email_code');
      const user = await tx.user.findFirst({ where: { email: email.toLowerCase(), isActive: true } });
      if (!user || (user.lockedUntil && user.lockedUntil > new Date())) return null;
      try {
        this.login.assertDomainAllowed(settings, user.email);
      } catch {
        return null; // same generic reply, so the policy does not reveal which accounts exist
      }
      const recent = await tx.loginCode.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 15 * 60_000) } } });
      if (recent >= 3) return null; // rate limit: 3 codes per 15 minutes
      const code = randomCode();
      await tx.loginCode.create({
        data: { tenantId: org.id, userId: user.id, codeHash: sha256(`${user.id}:${code}`), expiresAt: new Date(Date.now() + 10 * 60_000) },
      });
      return { to: user.email, code };
    });
    if (sent) {
      await this.mailer.send(
        sent.to,
        `${sent.code} is your ${org.name} sign-in code`,
        `Your UBOS sign-in code for ${org.name} is ${sent.code}.\n\nIt expires in 10 minutes. If you did not request it, you can ignore this email.`,
      );
    }
    return GENERIC_CODE_REPLY;
  }

  @Public()
  @Post('email-code/verify')
  @HttpCode(200)
  async verifyCode(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, code } = parse(CodeVerify, body);
    return authTransaction((fn) => this.db.tenant(fn), async (tx) => {
      const settings = await this.login.settings(tx, tenantId());
      this.login.assertMethodAllowed(settings, 'email_code');
      const user = await tx.user.findFirst({ where: { email: email.toLowerCase() } });
      const invalid = new UnauthorizedException({ code: 'INVALID_CODE', message: 'Wrong or expired code' });
      if (!user) throw invalid;
      this.login.assertNotLocked(user);
      const entry = await tx.loginCode.findFirst({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (!entry || entry.attempts >= 5) throw invalid;
      if (entry.codeHash !== sha256(`${user.id}:${code}`)) {
        await tx.loginCode.update({ where: { id: entry.id }, data: { attempts: { increment: 1 } } });
        return this.login.registerFailure(tx, user, settings, req, 'email_code', invalid);
      }
      await tx.loginCode.update({ where: { id: entry.id }, data: { usedAt: new Date() } });
      return this.login.complete(tx, user, 'email_code', req, res);
    });
  }

  /** Second step when the user has two-factor auth switched on. */
  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  async verifyMfa(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { mfaToken, code } = parse(MfaVerify, body);
    const claims = await this.login.verifyMfaToken(mfaToken);
    if (claims.tid !== tenantId()) throw new UnauthorizedException({ code: 'MFA_TOKEN_INVALID', message: 'Please sign in again' });
    return authTransaction((fn) => this.db.tenant(fn), async (tx) => {
      const user = await tx.user.findUnique({ where: { id: claims.sub } });
      if (!user?.totpEnabled || !user.totpSecret) throw new UnauthorizedException({ code: 'MFA_TOKEN_INVALID', message: 'Please sign in again' });
      this.login.assertNotLocked(user);
      if (!authenticator.check(code, decrypt(user.totpSecret))) {
        const settings = await this.login.settings(tx, user.tenantId);
        const error = new UnauthorizedException({ code: 'INVALID_CODE', message: 'Wrong authenticator code' });
        return this.login.registerFailure(tx, user, settings, req, claims.method, error);
      }
      return this.login.finish(tx, user, claims.method, req, res);
    });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return authTransaction((fn) => this.db.tenant(fn), async (tx) => {
      const s = await this.login.settings(tx, tenantId());
      return this.sessions.refresh(tx, 'tenant', req, res, s.sessionIdleMinutes, tenantId());
    });
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Res({ passthrough: true }) res: Response) {
    await this.db.tenant(async (tx) => {
      await this.sessions.revoke(tx, auth().sessionId, 'logout');
      await this.db.audit(tx, { entity: 'session', entityId: auth().sessionId, action: 'auth.logout' });
    });
    this.sessions.clear(res, 'tenant');
    return { ok: true };
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
      security: { totpEnabled: a.totpEnabled, mustChangePassword: a.mustChangePassword, mfaSetupRequired: a.mfaSetupRequired },
    };
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(@Body() body: unknown) {
    const { currentPassword, newPassword } = parse(ChangePassword, body);
    return this.db.tenant(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth().userId } });
      if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw new BadRequestException({ code: 'WRONG_PASSWORD', message: 'Current password is wrong' });
      }
      if (await bcrypt.compare(newPassword, user.passwordHash)) {
        throw new BadRequestException({ code: 'SAME_PASSWORD', message: 'Choose a different password' });
      }
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(newPassword, 10), passwordChangedAt: new Date(), mustChangePassword: false },
      });
      // Every other device is signed out after a password change.
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: auth().sessionId } },
        data: { revokedAt: new Date(), revokedReason: 'password_changed' },
      });
      await this.db.audit(tx, { entity: 'user', entityId: user.id, action: 'auth.password_changed' });
      return { ok: true };
    });
  }

  /** Two-factor setup step 1: creates a secret and returns a QR code for Google Authenticator / Microsoft Authenticator. */
  @Post('2fa/setup')
  @HttpCode(200)
  async setupTotp() {
    return this.db.tenant(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth().userId } });
      if (user.totpEnabled) throw new BadRequestException({ code: 'MFA_ALREADY_ON', message: 'Two-factor authentication is already on' });
      const secret = authenticator.generateSecret();
      await tx.user.update({ where: { id: user.id }, data: { totpSecret: encrypt(secret) } });
      const uri = authenticator.keyuri(user.email, `UBOS (${ctx().tenant!.name})`, secret);
      return { secret, otpauthUrl: uri, qrDataUrl: await QRCode.toDataURL(uri) };
    });
  }

  @Post('2fa/enable')
  @HttpCode(200)
  async enableTotp(@Body() body: unknown) {
    const { code } = parse(TotpCode, body);
    return this.db.tenant(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth().userId } });
      if (!user.totpSecret || !authenticator.check(code, decrypt(user.totpSecret))) {
        throw new BadRequestException({ code: 'INVALID_CODE', message: 'Wrong code — check the time on your phone and try again' });
      }
      await tx.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
      await this.db.audit(tx, { entity: 'user', entityId: user.id, action: 'auth.2fa_enabled' });
      return { ok: true };
    });
  }

  @Post('2fa/disable')
  @HttpCode(200)
  async disableTotp(@Body() body: unknown) {
    const { code } = parse(TotpCode, body);
    return this.db.tenant(async (tx) => {
      const settings = await this.login.settings(tx, tenantId());
      if (auth().assignments.some((r) => settings.require2faRoles.includes(r.roleName))) {
        throw new ForbiddenException({ code: 'MFA_REQUIRED_BY_POLICY', message: 'Your organization requires two-factor authentication for your role' });
      }
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth().userId } });
      if (!user.totpEnabled || !user.totpSecret || !authenticator.check(code, decrypt(user.totpSecret))) {
        throw new BadRequestException({ code: 'INVALID_CODE', message: 'Wrong authenticator code' });
      }
      await tx.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null } });
      await this.db.audit(tx, { entity: 'user', entityId: user.id, action: 'auth.2fa_disabled' });
      return { ok: true };
    });
  }

  /** My signed-in devices. */
  @Get('sessions')
  sessionsList() {
    return this.db.tenant(async (tx) => {
      const rows = await tx.session.findMany({
        where: { userId: auth().userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
      });
      return rows.map((s) => ({
        id: s.id, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, current: s.id === auth().sessionId,
      }));
    });
  }

  @Delete('sessions/:id')
  revokeSession(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const s = await tx.session.findFirst({ where: { id, userId: auth().userId } });
      if (!s) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });
      await this.sessions.revoke(tx, id, 'revoked_by_user');
      await this.db.audit(tx, { entity: 'session', entityId: id, action: 'auth.session_revoked' });
      return { ok: true };
    });
  }
}
