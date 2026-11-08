import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Ip, NotFoundException, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { DUPLICATE_MODES, normalizeMobile, type ApiScope, type DuplicateMode } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { ctx } from '../common/context';
import { parse } from '../common/errors';
import { activity, applyStageChange } from '../common/lead-ops';
import { asTenant, IntakeService, rateLimit, readConfig, sha256 } from './integration-runtime';
import { CALL_PROVIDERS, CallingService } from './calling/calling.service';
import { WhatsAppService } from './whatsapp/whatsapp.service';
import { MessagingService } from './messaging/messaging.service';

const CATALOGUE_NAMES: Record<string, string> = {}; // filled by IntegrationsController at startup (display names for "via")
export const registerIntegrationNames = (names: Record<string, string>) => Object.assign(CATALOGUE_NAMES, names);

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pickHeaders = (h: Record<string, unknown>) => Object.fromEntries(['content-type', 'user-agent', 'x-forwarded-for', 'idempotency-key'].filter((k) => h[k]).map((k) => [k, String(h[k]).slice(0, 200)]));

/**
 * Inbound webhooks for lead sources: POST /hooks/<org>/<integration>/<secret token>. The body is mapped with the
 * integration's saved field mapping and duplicate rule. Responds 200 with one result per record.
 */
@Controller('hooks')
export class HooksController {
  constructor(private db: DbService, private intake: IntakeService, private calling: CallingService, private wa: WhatsAppService, private messaging: MessagingService) {}

  /** Meta's webhook check: echoes hub.challenge when the verify token is this integration's token. */
  @Get(':slug/:key/:token')
  verify(@Param('slug') slug: string, @Param('key') key: string, @Param('token') token: string, @Query('hub.verify_token') vt?: string, @Query('hub.challenge') challenge?: string) {
    return asTenant(this.db, slug, async () => {
      const conn = await this.db.tenant((tx) => tx.integrationConnection.findFirst({ where: { key, workspaceId: null } }));
      const cfg = readConfig(conn?.configEncrypted);
      if (!cfg.webhookToken || !safeEq(cfg.webhookToken, token) || !vt || !safeEq(cfg.webhookToken, vt)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
      return challenge ?? '';
    });
  }

  @Post(':slug/:key/:token')
  @HttpCode(200)
  receive(@Param('slug') slug: string, @Param('key') key: string, @Param('token') token: string, @Body() body: unknown, @Headers() headers: Record<string, unknown>, @Req() req: unknown) {
    return asTenant(this.db, slug, async (t) => {
      rateLimit(`hook:${t.id}:${key}`, 300);
      const conn = await this.db.tenant((tx) => tx.integrationConnection.findFirst({ where: { key, workspaceId: null } }));
      const cfg = readConfig(conn?.configEncrypted);
      // Wrong or unknown token: answer like an unknown address, never say which part was wrong.
      if (!conn || !cfg.webhookToken || !safeEq(cfg.webhookToken, token)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
      if (conn.status !== 'active') throw new ForbiddenException({ code: 'INTEGRATION_INACTIVE', message: 'This integration is switched off in UBOS' });
      // Google Ads sends the key typed in its lead form; it must match the one saved in UBOS.
      if (key === 'google_ads' && (!cfg.values.googleKey || !body || typeof body !== 'object' || !safeEq(String((body as Record<string, unknown>).google_key ?? ''), cfg.values.googleKey))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
      // WhatsApp sends chats and delivery statuses, signed by Meta: its own pipeline.
      if (key === 'whatsapp') {
        if (!this.wa.verifySignature(cfg, (req as { rawBody?: Buffer }).rawBody, headers['x-hub-signature-256'] as string | undefined)) throw new UnauthorizedException({ code: 'BAD_SIGNATURE', message: 'Signature does not match' });
        return this.wa.receive(t.id, cfg, body);
      }
      const records = this.intake.records(body);
      // SMS gateways post delivery reports here.
      if (key === 'sms_dlt') return this.messaging.deliveryReport(t.id, records);
      if (!records.length) throw new BadRequestException({ code: 'EMPTY', message: 'Send the lead as a JSON object (or an array of objects)' });
      if (records.length > 100) throw new BadRequestException({ code: 'TOO_MANY', message: 'At most 100 records per call' });
      const results = [];
      // Cloud-calling providers send calls, not enquiries: they go through the call pipeline.
      if (CALL_PROVIDERS.has(key)) {
        for (const r of records) results.push(await this.calling.ingestCloud(t.id, key, cfg, r));
        await this.db.tenant((tx) => tx.integrationConnection.update({ where: { id: conn.id }, data: { lastEventAt: new Date() } }));
        return { ok: results.every((r) => r.status !== 'rejected'), results };
      }
      for (const r of records) {
        const out = await this.intake.viaMapping(t.id, key, CATALOGUE_NAMES[key] ?? key, cfg, r, this.intake.externalIdOf(r, headers['idempotency-key'] as string), pickHeaders(headers));
        results.push({ outcome: out.outcome, leadId: out.leadId, errors: out.errors, ...('duplicate' in out && out.duplicate ? { duplicate: true } : {}) });
      }
      await this.db.tenant((tx) => tx.integrationConnection.update({ where: { id: conn.id }, data: { lastEventAt: new Date() } }));
      return { ok: results.every((r) => r.outcome !== 'rejected'), results };
    });
  }
}

/** Hosted web forms: the page reads the form, the visitor submits it. No sign-in; spam is limited by IP and a honeypot. */
@Controller('public/forms')
export class PublicFormsController {
  constructor(private db: DbService, private intake: IntakeService) {}

  @Get(':slug/:form')
  form(@Param('slug') slug: string, @Param('form') formSlug: string) {
    return asTenant(this.db, slug, async (t) => {
      const f = await this.db.tenant((tx) => tx.leadForm.findFirst({ where: { slug: formSlug, isArchived: false } }));
      if (!f || !f.isActive) throw new NotFoundException({ code: 'FORM_NOT_FOUND', message: 'This form is not available' });
      const defs = await this.db.tenant((tx) => tx.leadField.findMany({ where: { workspaceId: f.workspaceId, isArchived: false } }));
      const fields = (f.fields as { target: string; label: string; required: boolean; placeholder?: string }[]).map((x) => {
        const cf = x.target.startsWith('cf:') ? defs.find((d) => d.key === x.target.slice(3)) : null;
        const type = cf ? cf.type : x.target === 'mobile' ? 'phone' : x.target === 'email' ? 'email' : x.target === 'remark' ? 'textarea' : 'text';
        return { name: x.target, label: x.label, required: x.required, placeholder: x.placeholder ?? '', type, options: cf?.options ?? [] };
      });
      return { organization: t.name, title: f.title, description: f.description, fields, submitLabel: f.submitLabel, color: f.color };
    });
  }

  @Post(':slug/:form')
  @HttpCode(200)
  submit(@Param('slug') slug: string, @Param('form') formSlug: string, @Body() body: Record<string, unknown>, @Ip() ip: string, @Headers() headers: Record<string, unknown>) {
    return asTenant(this.db, slug, async (t) => {
      rateLimit(`form:${t.id}:${ip}`, 10);
      const f = await this.db.tenant((tx) => tx.leadForm.findFirst({ where: { slug: formSlug, isArchived: false } }));
      if (!f || !f.isActive) throw new NotFoundException({ code: 'FORM_NOT_FOUND', message: 'This form is not available' });
      const thanks = { ok: true, message: f.thankYou, redirectUrl: f.redirectUrl };
      if (body && typeof body === 'object' && body._hp) return thanks; // honeypot filled → a bot; pretend success
      const def = f.fields as { target: string; label: string; required: boolean }[];
      const missing = def.filter((x) => x.required && (body?.[x.target] === undefined || String(body[x.target]).trim() === '')).map((x) => x.label);
      if (missing.length) throw new BadRequestException({ code: 'REQUIRED', message: `Please fill ${missing.join(', ')}` });
      const val = (k: string) => (body?.[k] === undefined || body[k] === null ? null : Array.isArray(body[k]) ? (body[k] as unknown[]) : String(body[k]).trim().slice(0, 2000));
      const customFields: Record<string, unknown> = {};
      for (const x of def) if (x.target.startsWith('cf:') && val(x.target) !== null && val(x.target) !== '') customFields[x.target.slice(3)] = val(x.target);
      const utm = ['utm_source', 'utm_medium', 'utm_campaign'].map((k) => (body?.[k] ? `${k}=${String(body[k]).slice(0, 80)}` : '')).filter(Boolean).join(' ');
      const remark = [val('remark') as string | null, utm || null].filter(Boolean).join('\n') || null;
      const out = await this.intake.process({
        tenantId: t.id, integrationKey: `form:${f.slug}`, workspaceId: f.workspaceId, mode: (f.duplicateMode in DUPLICATE_MODES ? f.duplicateMode : 'add_remark') as DuplicateMode,
        via: `web form “${f.name}”`, record: body ?? {}, externalId: null, headers: pickHeaders(headers),
        input: { name: val('name') as string, mobile: val('mobile') as string, email: val('email') as string, city: val('city') as string, remark, customFields, source: f.source },
      });
      if (out.outcome === 'rejected') throw new BadRequestException({ code: 'INVALID', message: out.errors.join('. ') });
      await this.db.tenant((tx) => tx.leadForm.update({ where: { id: f.id }, data: { submissions: { increment: 1 } } }));
      return thanks;
    });
  }
}

interface KeyCtx { id: string; tenantId: string; workspaceId: string | null; scopes: string[]; createdById: string }

const PublicLead = z.object({
  workspaceId: z.string().uuid().optional(), name: z.string().trim().min(1).max(120), mobile: z.string().max(30).optional(), email: z.string().max(160).optional(),
  city: z.string().max(80).optional(), source: z.string().max(40).default('api'), remark: z.string().max(4000).optional(),
  customFields: z.record(z.unknown()).optional(), duplicateMode: z.enum(Object.keys(DUPLICATE_MODES) as [DuplicateMode, ...DuplicateMode[]]).default('add_remark'),
});
const PublicPatch = z.object({ status: z.string().max(40).nullable().optional(), stageId: z.string().uuid().optional(), lostReason: z.string().max(80).optional(), remark: z.string().trim().min(1).max(4000).optional() });
const ListQuery = z.object({ updatedSince: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), workspaceId: z.string().uuid().optional() });

/**
 * Public REST API for other systems: `Authorization: Bearer ubos_…` (an organization API key with scopes).
 * Keys limited to one business line only see and create leads there. 120 requests a minute per key.
 */
@Controller('public/v1')
export class PublicApiController {
  constructor(private db: DbService, private intake: IntakeService) {}

  @Get('me')
  me(@Headers('authorization') authz: string) {
    return this.withKey(authz, null, async (k) => ({ organization: ctx().tenant!.name, key: { id: k.id, scopes: k.scopes, workspaceId: k.workspaceId } }));
  }

  @Get('workspaces')
  workspaces(@Headers('authorization') authz: string) {
    return this.withKey(authz, 'meta:read', (k) => this.db.tenant(async (tx) => {
      const ws = await tx.workspace.findMany({ where: { isArchived: false, ...(k.workspaceId ? { id: k.workspaceId } : {}) }, include: { pipelines: { include: { stages: { orderBy: { position: 'asc' } } } }, fields: { where: { isArchived: false } }, options: { where: { isArchived: false } } } });
      return ws.map((w) => ({
        id: w.id, name: w.name,
        stages: w.pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, name: s.name, pipeline: p.name, isWon: s.isWon, isLost: s.isLost }))),
        sources: w.options.filter((o) => o.kind === 'lead_source').map((o) => ({ value: o.value, label: o.label })),
        statuses: w.options.filter((o) => o.kind === 'lead_status').map((o) => ({ value: o.value, label: o.label })),
        lostReasons: w.options.filter((o) => o.kind === 'lost_reason').map((o) => ({ value: o.value, label: o.label })),
        fields: w.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, required: f.required })),
      }));
    }));
  }

  @Post('leads')
  createLead(@Headers('authorization') authz: string, @Headers('idempotency-key') idem: string | undefined, @Body() body: unknown) {
    return this.withKey(authz, 'leads:write', async (k) => {
      const input = parse(PublicLead, body);
      const ws = k.workspaceId ?? input.workspaceId;
      if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Send workspaceId (see GET /public/v1/workspaces)' });
      if (k.workspaceId && input.workspaceId && input.workspaceId !== k.workspaceId) throw new ForbiddenException({ code: 'WORKSPACE_FORBIDDEN', message: 'This key is limited to another business line' });
      if (!(await this.db.tenant((tx) => tx.workspace.findFirst({ where: { id: ws, isArchived: false } })))) throw new BadRequestException({ code: 'INVALID_WORKSPACE', message: 'Unknown business line' });
      const out = await this.intake.process({
        tenantId: k.tenantId, integrationKey: 'api', workspaceId: ws, mode: input.duplicateMode, via: 'API', record: input as unknown as Record<string, unknown>,
        externalId: idem ? `${k.id}:${idem}`.slice(0, 120) : null,
        input: { name: input.name, mobile: input.mobile, email: input.email, city: input.city, remark: input.remark, customFields: input.customFields, source: input.source },
      });
      if (out.outcome === 'rejected') throw new BadRequestException({ code: 'INVALID_LEAD', message: out.errors.join('. '), details: out.errors });
      return { outcome: out.outcome, leadId: out.leadId, customerId: out.customerId, duplicate: !!('duplicate' in out && out.duplicate) };
    });
  }

  @Get('leads')
  leads(@Headers('authorization') authz: string, @Query() query: unknown) {
    return this.withKey(authz, 'leads:read', (k) => this.db.tenant(async (tx) => {
      const q = parse(ListQuery, query);
      if (k.workspaceId && q.workspaceId && q.workspaceId !== k.workspaceId) throw new ForbiddenException({ code: 'WORKSPACE_FORBIDDEN', message: 'This key is limited to another business line' });
      const ws = k.workspaceId ?? q.workspaceId;
      const rows = await tx.lead.findMany({
        where: { ...(ws ? { workspaceId: ws } : {}), ...(q.updatedSince ? { updatedAt: { gt: q.updatedSince } } : {}) },
        orderBy: { updatedAt: 'asc' }, take: q.limit, include: { customer: true },
      });
      return { items: await this.shape(tx, rows), nextUpdatedSince: rows.length ? rows[rows.length - 1].updatedAt : q.updatedSince ?? null };
    }));
  }

  @Get('leads/:id')
  lead(@Headers('authorization') authz: string, @Param('id') id: string) {
    return this.withKey(authz, 'leads:read', (k) => this.db.tenant(async (tx) => {
      const l = await tx.lead.findFirst({ where: { id, ...(k.workspaceId ? { workspaceId: k.workspaceId } : {}) }, include: { customer: true } });
      if (!l) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const [shaped] = await this.shape(tx, [l]);
      const acts = await tx.leadActivity.findMany({ where: { leadId: id }, orderBy: { createdAt: 'desc' }, take: 50, select: { type: true, remark: true, disposition: true, createdAt: true } });
      return { ...shaped, activities: acts };
    }));
  }

  @Patch('leads/:id')
  update(@Headers('authorization') authz: string, @Param('id') id: string, @Body() body: unknown) {
    return this.withKey(authz, 'leads:write', (k) => this.db.tenant(async (tx) => {
      const input = parse(PublicPatch, body);
      const l = await tx.lead.findFirst({ where: { id, ...(k.workspaceId ? { workspaceId: k.workspaceId } : {}) } });
      if (!l) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const actor = l.ownerId ?? k.createdById;
      if (input.status !== undefined) {
        if (input.status && !(await tx.workspaceOption.findFirst({ where: { workspaceId: l.workspaceId, kind: 'lead_status', value: input.status, isArchived: false } }))) throw new BadRequestException({ code: 'INVALID_STATUS', message: 'Unknown status (see GET /public/v1/workspaces)' });
        await tx.lead.update({ where: { id }, data: { status: input.status } });
        await tx.leadActivity.create({ data: activity(l, null, { type: 'status', data: { from: l.status, to: input.status, via: 'API' } }) });
      }
      if (input.stageId) {
        const stage = await tx.leadStage.findFirst({ where: { id: input.stageId, pipelineId: l.pipelineId } });
        if (!stage) throw new BadRequestException({ code: 'INVALID_STAGE', message: 'Unknown stage for this lead' });
        const fresh = await tx.lead.findUniqueOrThrow({ where: { id } });
        const refused = await applyStageChange(tx, fresh, stage, actor, input.lostReason);
        if (refused) throw new BadRequestException({ code: 'STAGE_RULE', message: refused });
      }
      if (input.remark) {
        await tx.leadActivity.create({ data: activity(l, null, { type: 'remark', remark: input.remark, data: { via: 'API' } }) });
        await tx.lead.update({ where: { id }, data: { lastActivityAt: new Date() } });
      }
      await this.db.audit(tx, { workspaceId: l.workspaceId, actorType: 'api_key', actorId: k.id, entity: 'lead', entityId: id, action: 'lead.updated_by_api', newValue: input });
      const [shaped] = await this.shape(tx, [await tx.lead.findUniqueOrThrow({ where: { id }, include: { customer: true } })]);
      return shaped;
    }));
  }

  @Get('customers')
  customers(@Headers('authorization') authz: string, @Query('mobile') mobile?: string, @Query('email') email?: string) {
    return this.withKey(authz, 'customers:read', () => this.db.tenant(async (tx) => {
      const m = mobile ? normalizeMobile(mobile) : null;
      if (!m && !email) throw new BadRequestException({ code: 'QUERY_REQUIRED', message: 'Search by mobile or email' });
      const rows = await tx.customer.findMany({
        where: { mergedIntoId: null, OR: [...(m ? [{ mobile: m }, { alternateMobiles: { has: m } }] : []), ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }, { alternateEmails: { has: email.toLowerCase() } }] : [])] },
        take: 10,
      });
      return rows.map((c) => ({ id: c.id, code: c.code, name: c.name, mobile: c.mobile, email: c.email, city: c.city, createdAt: c.createdAt }));
    }));
  }

  private async shape(tx: Parameters<Parameters<DbService['tenant']>[0]>[0], rows: { id: string; workspaceId: string; stageId: string; status: string | null; source: string; ownerId: string | null; customFields: unknown; createdAt: Date; updatedAt: Date; rating: number | null; customer: { id: string; code: string; name: string; mobile: string | null; email: string | null; city: string | null } }[]) {
    const stages = new Map((await tx.leadStage.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.stageId))] } } })).map((s) => [s.id, s]));
    const owners = new Map((await tx.user.findMany({ where: { id: { in: rows.map((r) => r.ownerId).filter(Boolean) as string[] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id, workspaceId: r.workspaceId, customer: { id: r.customer.id, code: r.customer.code, name: r.customer.name, mobile: r.customer.mobile, email: r.customer.email, city: r.customer.city },
      stage: { id: r.stageId, name: stages.get(r.stageId)?.name ?? null, isWon: !!stages.get(r.stageId)?.isWon, isLost: !!stages.get(r.stageId)?.isLost },
      status: r.status, source: r.source, owner: r.ownerId ? owners.get(r.ownerId) ?? null : null, customFields: r.customFields ?? {}, rating: r.rating,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));
  }

  /** Finds the key (hash lookup across organizations), checks scope and expiry, then runs as its organization. */
  private async withKey<T>(authz: string | undefined, scope: ApiScope | null, fn: (k: KeyCtx) => Promise<T>): Promise<T> {
    const raw = authz?.match(/^Bearer\s+(ubos_[A-Za-z0-9_-]{20,})$/)?.[1];
    if (!raw) throw new UnauthorizedException({ code: 'API_KEY_REQUIRED', message: 'Send Authorization: Bearer <API key>' });
    const key = await this.db.platform.apiKey.findUnique({ where: { keyHash: sha256(raw) } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) throw new UnauthorizedException({ code: 'API_KEY_INVALID', message: 'This API key is not valid' });
    const t = await this.db.platform.tenant.findUnique({ where: { id: key.tenantId } });
    if (!t || !['active', 'trial'].includes(t.status)) throw new UnauthorizedException({ code: 'API_KEY_INVALID', message: 'This API key is not valid' });
    ctx().tenant = { id: t.id, slug: t.slug, name: t.name, status: t.status };
    rateLimit(`key:${key.id}`, 120);
    if (scope && !key.scopes.includes(scope)) throw new ForbiddenException({ code: 'SCOPE_MISSING', message: `This key does not have the ${scope} scope` });
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) await this.db.platform.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return fn({ id: key.id, tenantId: key.tenantId, workspaceId: key.workspaceId, scopes: key.scopes, createdById: key.createdById });
  }
}
