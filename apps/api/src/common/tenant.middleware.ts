import { ForbiddenException, Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DbService } from './db.service';
import { ctx } from './context';

const ROOT_DOMAINS = ['.ubos.app', '.localhost'];

/**
 * Resolves the tenant for every /api/v1 request:
 *  1. subdomain of a platform domain (acme.ubos.app, acme.localhost)
 *  2. a verified custom domain (crm.acme.com)
 *  3. X-Tenant header (development and the prototype web app on localhost:3000)
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly db: DbService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const host = (req.headers['x-forwarded-host'] as string) ?? req.hostname ?? '';
    let slug: string | undefined;
    const root = ROOT_DOMAINS.find((d) => host.endsWith(d));
    if (root) {
      const sub = host.slice(0, -root.length);
      if (sub && !['www', 'console', 'api'].includes(sub)) slug = sub;
    }

    let tenant = slug ? await this.db.app.tenant.findUnique({ where: { slug } }) : null;
    if (!tenant && !root && host && host !== 'localhost' && host !== '127.0.0.1') {
      const domain = await this.db.app.tenantDomain.findUnique({ where: { host }, include: { tenant: true } });
      if (domain?.verified) tenant = domain.tenant;
    }
    // Browsers cannot set headers on a live-update stream (EventSource): it names the organization in the query.
    // The session token must still belong to that organization (checked by the guard).
    const header = req.headers['x-tenant'] ?? (req.originalUrl.startsWith('/api/v1/stream') ? req.query.tenant : undefined);
    if (!tenant && typeof header === 'string' && header) {
      tenant = await this.db.app.tenant.findUnique({ where: { slug: header.toLowerCase() } });
    }

    if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Organization not found' });
    if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
      throw new ForbiddenException({ code: 'TENANT_SUSPENDED', message: 'This organization account is not active' });
    }
    ctx().tenant = { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status };
    next();
  }
}
