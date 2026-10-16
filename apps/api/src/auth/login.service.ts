import { ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { appendAudit, Tx } from '@ubos/database';
import { normalizeMobile } from '@ubos/shared';
import { ipAllowed, normalizeIp } from './ip';
import { SessionService } from './sessions';
import { CommitThenThrow } from './tx';
export { authTransaction, CommitThenThrow } from './tx';

export type LoginMethod = 'password' | 'google' | 'microsoft' | 'email_code';
export type TenantUser = NonNullable<Awaited<ReturnType<Tx['user']['findFirst']>>>;

export const DEFAULT_SETTINGS = {
  sessionIdleMinutes: 480,
  ipAllowlist: [] as string[],
  require2faRoles: [] as string[],
  loginMethods: ['password', 'google', 'microsoft', 'email_code'],
  allowedEmailDomains: [] as string[],
  maxFailedLogins: 5,
  lockMinutes: 15,
};

export type LoginResult =
  | { mfaRequired: true; mfaToken: string }
  | { mfaRequired: false; accessToken: string; mustChangePassword: boolean; user: { id: string; name: string; email: string } };

/** Shared login rules for every sign-in method of an organization user. */
@Injectable()
export class TenantLoginService {
  constructor(private sessions: SessionService, private jwt: JwtService) {}

  async settings(tx: Tx, tenantId: string) {
    return (await tx.organizationSetting.findUnique({ where: { tenantId } })) ?? { tenantId, ...DEFAULT_SETTINGS };
  }

  /** Login identifier may be an email, a username or a mobile number. */
  findByIdentifier(tx: Tx, identifier: string) {
    const id = identifier.trim();
    if (id.includes('@')) return tx.user.findFirst({ where: { email: id.toLowerCase() } });
    const mobile = /^[+\d][\d\s-]{6,}$/.test(id) ? normalizeMobile(id) : null;
    if (mobile) return tx.user.findFirst({ where: { mobile } });
    return tx.user.findFirst({ where: { username: id.toLowerCase() } });
  }

  assertMethodAllowed(settings: { loginMethods: string[] }, method: LoginMethod) {
    if (!settings.loginMethods.includes(method)) {
      throw new ForbiddenException({ code: 'LOGIN_METHOD_DISABLED', message: 'This sign-in method is turned off for your organization' });
    }
  }

  assertDomainAllowed(settings: { allowedEmailDomains: string[] }, email: string) {
    const domains = settings.allowedEmailDomains.map((d) => d.toLowerCase().replace(/^@/, ''));
    if (domains.length && !domains.includes(email.split('@')[1]?.toLowerCase())) {
      throw new ForbiddenException({ code: 'EMAIL_DOMAIN_NOT_ALLOWED', message: 'Your email domain is not allowed for this organization' });
    }
  }

  assertNotLocked(user: TenantUser) {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new HttpException({ code: 'ACCOUNT_LOCKED', message: `Too many failed attempts. Try again in ${minutes} minute(s).` }, 423);
    }
  }

  /** Records a failed attempt (may lock the account), then rejects with `error` after the transaction commits. */
  async registerFailure(
    tx: Tx, user: TenantUser, settings: { maxFailedLogins: number; lockMinutes: number }, req: Request, method: LoginMethod, error: unknown,
  ): Promise<never> {
    const failed = user.failedLogins + 1;
    const lock = failed >= settings.maxFailedLogins;
    await tx.user.update({
      where: { id: user.id },
      data: lock ? { failedLogins: 0, lockedUntil: new Date(Date.now() + settings.lockMinutes * 60_000) } : { failedLogins: failed },
    });
    await appendAudit(tx, {
      tenantId: user.tenantId, actorType: 'tenant_user', actorId: user.id, ip: normalizeIp(req.ip),
      entity: 'user', entityId: user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', newValue: { method, failed },
    });
    throw new CommitThenThrow(error);
  }

  /** Primary factor passed. Applies IP rules, then either asks for the 2FA code or opens a session. */
  async complete(tx: Tx, user: TenantUser, method: LoginMethod, req: Request, res: Response): Promise<LoginResult> {
    if (!user.isActive) throw new UnauthorizedException({ code: 'USER_INACTIVE', message: 'Your account is inactive' });
    const settings = await this.settings(tx, user.tenantId);
    if (!ipAllowed(normalizeIp(req.ip), settings.ipAllowlist)) {
      await appendAudit(tx, {
        tenantId: user.tenantId, actorType: 'tenant_user', actorId: user.id, ip: normalizeIp(req.ip),
        entity: 'user', entityId: user.id, action: 'auth.ip_blocked', newValue: { method },
      });
      throw new CommitThenThrow(new ForbiddenException({ code: 'IP_NOT_ALLOWED', message: 'Sign-in is not allowed from this network' }));
    }
    if (user.failedLogins || user.lockedUntil) {
      await tx.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    }
    if (user.totpEnabled) {
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, tid: user.tenantId, method, typ: 'mfa' },
        { secret: process.env.JWT_ACCESS_SECRET, expiresIn: 300 },
      );
      return { mfaRequired: true, mfaToken };
    }
    return this.finish(tx, user, method, req, res);
  }

  async finish(tx: Tx, user: TenantUser, method: LoginMethod, req: Request, res: Response): Promise<LoginResult> {
    const { accessToken } = await this.sessions.issue(tx, 'tenant', { userId: user.id, tenantId: user.tenantId }, req, res);
    await appendAudit(tx, {
      tenantId: user.tenantId, actorType: 'tenant_user', actorId: user.id, ip: normalizeIp(req.ip),
      entity: 'user', entityId: user.id, action: 'auth.login', newValue: { method, mfa: user.totpEnabled },
    });
    return {
      mfaRequired: false,
      accessToken,
      mustChangePassword: user.mustChangePassword,
      user: { id: user.id, name: user.name, email: user.email },
    };
  }

  async verifyMfaToken(token: string): Promise<{ sub: string; tid: string; method: LoginMethod }> {
    try {
      const p = await this.jwt.verifyAsync(token, { secret: process.env.JWT_ACCESS_SECRET });
      if (p.typ !== 'mfa') throw new Error();
      return p;
    } catch {
      throw new UnauthorizedException({ code: 'MFA_TOKEN_INVALID', message: 'Verification timed out, please sign in again' });
    }
  }
}
