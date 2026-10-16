import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions, Request, Response } from 'express';
import type { Tx } from '@ubos/database';
import { appendAudit } from '@ubos/database';
import { randomToken, sha256 } from './crypto';
import { normalizeIp } from './ip';
import { CommitThenThrow } from './tx';

export const ACCESS_TTL_SECONDS = 15 * 60;
const ABSOLUTE_TTL_MS = 30 * 86_400_000;
/** Two tabs refreshing at the same moment is normal; only older reuse is treated as theft. */
const REUSE_GRACE_MS = Number(process.env.REFRESH_REUSE_GRACE_MS ?? 30_000);

export type Audience = 'tenant' | 'platform';

export const COOKIES = {
  tenant: { access: 'ubos_at', refresh: 'ubos_rt', refreshPath: '/api/v1/auth' },
  platform: { access: 'ubos_pat', refresh: 'ubos_prt', refreshPath: '/platform/v1/auth' },
} as const;

const secret = (aud: Audience) => (aud === 'tenant' ? process.env.JWT_ACCESS_SECRET : process.env.JWT_PLATFORM_SECRET);

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: Audience;
  tid?: string;
}

/**
 * Cookie-based sessions with short-lived access tokens (15 min) and rotating refresh tokens.
 * - Refresh tokens are stored hashed; each refresh issues a new one.
 * - Presenting an already-rotated refresh token (outside a short grace window) revokes the session.
 * - Idle timeout (per organization) and a 30-day absolute lifetime.
 */
@Injectable()
export class SessionService {
  constructor(private jwt: JwtService) {}

  private cookie(path = '/'): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', path };
  }

  async issue(tx: Tx, aud: Audience, subject: { userId: string; tenantId?: string }, req: Request, res: Response) {
    const refresh = randomToken();
    const session = await tx.session.create({
      data: {
        tenantId: subject.tenantId ?? null,
        userId: aud === 'tenant' ? subject.userId : null,
        platformUserId: aud === 'platform' ? subject.userId : null,
        refreshHash: sha256(refresh),
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
        ip: normalizeIp(req.ip),
        expiresAt: new Date(Date.now() + ABSOLUTE_TTL_MS),
      },
    });
    const access = await this.sign(aud, subject.userId, session.id, subject.tenantId);
    this.setCookies(res, aud, access, refresh);
    return { accessToken: access, sessionId: session.id };
  }

  /** Rotates the refresh token. `idleMinutes` comes from the organization's security policy (platform: 8h). */
  async refresh(tx: Tx, aud: Audience, req: Request, res: Response, idleMinutes: number, tenantId?: string) {
    const token = req.cookies?.[COOKIES[aud].refresh];
    if (!token) throw new UnauthorizedException({ code: 'NO_SESSION', message: 'Please log in' });
    const hash = sha256(token);

    const session = await tx.session.findUnique({ where: { refreshHash: hash } });
    if (!session) {
      const reused = await tx.session.findFirst({ where: { prevRefreshHash: hash } });
      if (reused && !reused.revokedAt && Date.now() - reused.lastUsedAt.getTime() > REUSE_GRACE_MS) {
        await tx.session.update({ where: { id: reused.id }, data: { revokedAt: new Date(), revokedReason: 'refresh_token_reuse' } });
        await appendAudit(tx, {
          tenantId: reused.tenantId, actorType: aud === 'tenant' ? 'tenant_user' : 'platform_user',
          actorId: reused.userId ?? reused.platformUserId, ip: normalizeIp(req.ip),
          entity: 'session', entityId: reused.id, action: 'session.revoked_token_reuse',
        });
      }
      this.clear(res, aud);
      throw new CommitThenThrow(new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Session ended, please log in again' }));
    }

    const idleExpired = Date.now() - session.lastUsedAt.getTime() > idleMinutes * 60_000;
    if (session.revokedAt || session.expiresAt < new Date() || idleExpired) {
      if (!session.revokedAt) {
        await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: idleExpired ? 'idle_timeout' : 'expired' } });
      }
      this.clear(res, aud);
      throw new CommitThenThrow(new UnauthorizedException({ code: 'SESSION_EXPIRED', message: 'Session expired, please log in again' }));
    }

    const next = randomToken();
    await tx.session.update({
      where: { id: session.id },
      data: { refreshHash: sha256(next), prevRefreshHash: hash, lastUsedAt: new Date(), ip: normalizeIp(req.ip) },
    });
    const userId = (aud === 'tenant' ? session.userId : session.platformUserId)!;
    const access = await this.sign(aud, userId, session.id, tenantId ?? session.tenantId ?? undefined);
    this.setCookies(res, aud, access, next);
    return { accessToken: access };
  }

  async revoke(tx: Tx, sessionId: string, reason: string) {
    await tx.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  }

  async verifyAccess(aud: Audience, token: string): Promise<AccessClaims> {
    try {
      const claims = await this.jwt.verifyAsync<AccessClaims>(token, { secret: secret(aud) });
      if (claims.typ !== aud || !claims.sid) throw new Error('wrong audience');
      return claims;
    } catch (e) {
      const expired = e instanceof Error && e.name === 'TokenExpiredError';
      throw new UnauthorizedException({
        code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        message: expired ? 'Session refresh needed' : 'Please log in again',
      });
    }
  }

  /** Access token from the cookie (browser) or Authorization header (API clients, scripts). */
  tokenFrom(req: Request, aud: Audience): string | undefined {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    return req.cookies?.[COOKIES[aud].access];
  }

  clear(res: Response, aud: Audience) {
    res.clearCookie(COOKIES[aud].access, this.cookie('/'));
    res.clearCookie(COOKIES[aud].refresh, this.cookie(COOKIES[aud].refreshPath));
  }

  private sign(aud: Audience, sub: string, sid: string, tid?: string) {
    return this.jwt.signAsync({ sub, sid, typ: aud, ...(tid ? { tid } : {}) }, { secret: secret(aud), expiresIn: ACCESS_TTL_SECONDS });
  }

  private setCookies(res: Response, aud: Audience, access: string, refresh: string) {
    res.cookie(COOKIES[aud].access, access, { ...this.cookie('/'), maxAge: ACCESS_TTL_SECONDS * 1000 });
    res.cookie(COOKIES[aud].refresh, refresh, { ...this.cookie(COOKIES[aud].refreshPath), maxAge: ABSOLUTE_TTL_MS });
  }
}
