import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { tenantId } from '../common/context';
import { parse } from '../common/errors';
import { randomToken } from '../auth/crypto';
import { ipAllowed, normalizeIp } from '../auth/ip';
import { DEFAULT_SETTINGS } from '../auth/login.service';
import { oauthConfigured } from '../auth/oauth.controller';

const IP_ENTRY = /^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-fA-F:]+)$/;
const SecurityBody = z.object({
  sessionIdleMinutes: z.number().int().min(5).max(7 * 24 * 60),
  ipAllowlist: z.array(z.string().trim().regex(IP_ENTRY, 'Use an IP like 203.0.113.10 or a range like 203.0.113.0/24')).max(50),
  require2faRoles: z.array(z.string().trim().min(1).max(60)).max(50),
  loginMethods: z.array(z.enum(['password', 'google', 'microsoft', 'email_code'])).min(1, 'Keep at least one sign-in method'),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^@?[a-z0-9.-]+\.[a-z]{2,}$/, 'Use a domain like company.com')).max(20),
  maxFailedLogins: z.number().int().min(3).max(20),
  lockMinutes: z.number().int().min(1).max(24 * 60),
});

@Controller('api/v1')
export class SecurityController {
  constructor(private db: DbService) {}

  @Get('settings/security')
  @RequirePermission('org.security.manage', 'ORGANIZATION')
  async get(@Req() req: Request) {
    const { settings, roles } = await this.db.tenant(async (tx) => ({
      settings: (await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() } })) ?? { ...DEFAULT_SETTINGS },
      roles: await tx.role.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    }));
    return {
      settings,
      roles: roles.map((r) => r.name),
      yourIp: normalizeIp(req.ip),
      providers: { google: oauthConfigured('google'), microsoft: oauthConfigured('microsoft') },
    };
  }

  @Put('settings/security')
  @RequirePermission('org.security.manage', 'ORGANIZATION')
  update(@Body() body: unknown, @Req() req: Request) {
    const input = parse(SecurityBody, body);
    if (!ipAllowed(normalizeIp(req.ip), input.ipAllowlist)) {
      throw new BadRequestException({
        code: 'WOULD_LOCK_YOU_OUT',
        message: `This IP list does not include your current address (${normalizeIp(req.ip)}). Add it first so you are not locked out.`,
      });
    }
    return this.db.tenant(async (tx) => {
      const old = await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() } });
      const saved = await tx.organizationSetting.upsert({
        where: { tenantId: tenantId() },
        create: { tenantId: tenantId(), ...input },
        update: input,
      });
      const { updatedAt: _a, tenantId: _b, ...oldValue } = old ?? { updatedAt: null, tenantId: null };
      await this.db.audit(tx, { entity: 'settings', entityId: 'security', action: 'settings.security_updated', oldValue, newValue: input });
      return saved;
    });
  }

  /** Admin sets a temporary password; the user must change it at next sign-in. All their sessions end. */
  @Post('users/:id/reset-password')
  @HttpCode(200)
  @RequirePermission('org.user.manage', 'ORGANIZATION')
  resetPassword(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
      const temporaryPassword = `Ub${randomToken(9)}9`;
      await tx.user.update({
        where: { id },
        data: { passwordHash: await bcrypt.hash(temporaryPassword, 10), mustChangePassword: true, failedLogins: 0, lockedUntil: null },
      });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'admin_password_reset' } });
      await this.db.audit(tx, { entity: 'user', entityId: id, action: 'auth.password_reset_by_admin' });
      // Shown once to the admin; it is never stored in readable form.
      return { temporaryPassword };
    });
  }

  @Post('users/:id/unlock')
  @HttpCode(200)
  @RequirePermission('org.user.manage', 'ORGANIZATION')
  unlock(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.user.updateMany({ where: { id }, data: { failedLogins: 0, lockedUntil: null } });
      if (!r.count) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
      await this.db.audit(tx, { entity: 'user', entityId: id, action: 'auth.unlocked_by_admin' });
      return { ok: true };
    });
  }
}
