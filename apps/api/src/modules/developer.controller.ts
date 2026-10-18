import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { API_SCOPES, DUPLICATE_MODES, FORM_TARGETS, WEBHOOK_EVENTS, type ApiScope, type DuplicateMode, type WebhookEvent } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, ctx, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { encrypt, randomToken } from '../auth/crypto';
import { assertPublicUrl, sha256, WebhookDispatcher } from './integration-runtime';

const WEB = () => (process.env.WEB_ORIGIN ?? 'http://localhost:3030').split(',')[0].replace(/\/$/, '');
const API = () => (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const KeyBody = z.object({
  name: z.string().trim().min(2).max(60), scopes: z.array(z.enum(Object.keys(API_SCOPES) as [ApiScope, ...ApiScope[]])).min(1),
  workspaceId: z.string().uuid().nullable().optional(), expiresAt: z.coerce.date().nullable().optional(),
});
const Events = z.array(z.enum(Object.keys(WEBHOOK_EVENTS) as [WebhookEvent, ...WebhookEvent[]])).min(1);
const HookBody = z.object({ name: z.string().trim().min(2).max(60), url: z.string().trim().url().max(500), events: Events, workspaceId: z.string().uuid().nullable().optional() });
const HookPatch = HookBody.partial().extend({ isActive: z.boolean().optional() });
const FormField = z.object({ target: z.string().regex(/^(name|mobile|email|city|remark|cf:[a-z][a-z0-9_]*)$/), label: z.string().trim().min(1).max(60), required: z.boolean().default(false), placeholder: z.string().max(80).optional() });
const FormBody = z.object({
  name: z.string().trim().min(2).max(60), slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Use lowercase letters, digits and -').optional(),
  title: z.string().trim().min(2).max(100), description: z.string().trim().max(500).nullable().optional(), fields: z.array(FormField).min(1).max(30),
  submitLabel: z.string().trim().min(1).max(30).default('Submit'), thankYou: z.string().trim().min(1).max(300).default('Thank you! We will contact you soon.'),
  redirectUrl: z.string().trim().url().max(300).nullable().optional(), source: z.string().trim().min(1).max(40).default('website'),
  duplicateMode: z.enum(Object.keys(DUPLICATE_MODES) as [DuplicateMode, ...DuplicateMode[]]).default('add_remark'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#5b3cc4'), isActive: z.boolean().default(true),
});

/** Settings → Developer: API keys and outgoing webhooks (organization admins); web forms (business-line managers). */
@Controller('api/v1')
export class DeveloperController {
  constructor(private db: DbService, private dispatcher: WebhookDispatcher) {}

  // ── API keys ──

  @Get('api-keys')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  keys() {
    return this.db.tenant(async (tx) => ({
      scopes: Object.entries(API_SCOPES).map(([value, label]) => ({ value, label })),
      baseUrl: `${API()}/public/v1`,
      keys: (await tx.apiKey.findMany({ orderBy: { createdAt: 'desc' } })).map(({ keyHash: _h, ...k }) => k),
    }));
  }

  /** The full key is returned once; only its hash is stored. */
  @Post('api-keys')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  createKey(@Body() body: unknown) {
    const input = parse(KeyBody, body);
    return this.db.tenant(async (tx) => {
      if (input.workspaceId && !(await tx.workspace.findFirst({ where: { id: input.workspaceId } }))) throw new BadRequestException({ code: 'INVALID_WORKSPACE', message: 'Unknown business line' });
      const raw = `ubos_${randomToken(30).replace(/[^A-Za-z0-9]/g, '').slice(0, 36)}`;
      const k = await tx.apiKey.create({ data: { tenantId: tenantId(), name: input.name, prefix: raw.slice(0, 12), keyHash: sha256(raw), scopes: input.scopes, workspaceId: input.workspaceId ?? null, expiresAt: input.expiresAt ?? null, createdById: auth().userId } });
      await this.db.audit(tx, { entity: 'api_key', entityId: k.id, action: 'api_key.created', newValue: { name: input.name, prefix: k.prefix, scopes: input.scopes, workspaceId: k.workspaceId } });
      const { keyHash: _h, ...rest } = k;
      return { ...rest, key: raw };
    });
  }

  @Post('api-keys/:id/revoke')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  revokeKey(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const k = await tx.apiKey.findUnique({ where: { id } });
      if (!k) throw new NotFoundException({ code: 'KEY_NOT_FOUND', message: 'API key not found' });
      if (k.revokedAt) return { ok: true };
      await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.db.audit(tx, { entity: 'api_key', entityId: id, action: 'api_key.revoked', oldValue: { name: k.name, prefix: k.prefix } });
      return { ok: true };
    });
  }

  // ── Outgoing webhooks ──

  @Get('webhooks')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  hooks() {
    return this.db.tenant(async (tx) => {
      const subs = await tx.webhookSubscription.findMany({ orderBy: { createdAt: 'desc' } });
      const since = new Date(Date.now() - 7 * 86_400_000);
      const stats = await tx.webhookDelivery.groupBy({ by: ['subscriptionId', 'status'], where: { createdAt: { gte: since } }, _count: true });
      return {
        events: Object.entries(WEBHOOK_EVENTS).map(([value, label]) => ({ value, label })),
        webhooks: subs.map(({ secretEncrypted: _s, ...s }) => ({
          ...s, last7Days: Object.fromEntries(stats.filter((x) => x.subscriptionId === s.id).map((x) => [x.status, x._count])),
        })),
      };
    });
  }

  /** The signing secret is returned once. */
  @Post('webhooks')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  async createHook(@Body() body: unknown) {
    const input = parse(HookBody, body);
    await assertPublicUrl(input.url);
    return this.db.tenant(async (tx) => {
      const secret = `whsec_${randomToken(24).replace(/[^A-Za-z0-9]/g, '')}`;
      const s = await tx.webhookSubscription.create({ data: { tenantId: tenantId(), name: input.name, url: input.url, events: input.events, workspaceId: input.workspaceId ?? null, secretEncrypted: encrypt(secret), createdById: auth().userId } });
      await this.db.audit(tx, { entity: 'webhook', entityId: s.id, action: 'webhook.created', newValue: { name: input.name, url: input.url, events: input.events } });
      const { secretEncrypted: _s, ...rest } = s;
      return { ...rest, secret };
    });
  }

  @Patch('webhooks/:id')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  async updateHook(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(HookPatch, body);
    if (input.url) await assertPublicUrl(input.url);
    return this.db.tenant(async (tx) => {
      const s = await tx.webhookSubscription.findUnique({ where: { id } });
      if (!s) throw new NotFoundException({ code: 'WEBHOOK_NOT_FOUND', message: 'Webhook not found' });
      await tx.webhookSubscription.update({ where: { id }, data: { ...input, ...(input.isActive ? { failureCount: 0 } : {}) } });
      await this.db.audit(tx, { entity: 'webhook', entityId: id, action: input.isActive === false ? 'webhook.paused' : input.isActive ? 'webhook.resumed' : 'webhook.updated', oldValue: { url: s.url, events: s.events, isActive: s.isActive }, newValue: input });
      return { ok: true };
    });
  }

  @Post('webhooks/:id/rotate-secret')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  rotate(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const s = await tx.webhookSubscription.findUnique({ where: { id } });
      if (!s) throw new NotFoundException({ code: 'WEBHOOK_NOT_FOUND', message: 'Webhook not found' });
      const secret = `whsec_${randomToken(24).replace(/[^A-Za-z0-9]/g, '')}`;
      await tx.webhookSubscription.update({ where: { id }, data: { secretEncrypted: encrypt(secret) } });
      await this.db.audit(tx, { entity: 'webhook', entityId: id, action: 'webhook.secret_rotated' });
      return { secret };
    });
  }

  /** Sends a "ping" right away and returns the result. */
  @Post('webhooks/:id/test')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  async test(@Param('id') id: string) {
    const d = await this.db.tenant(async (tx) => {
      const s = await tx.webhookSubscription.findUnique({ where: { id } });
      if (!s) throw new NotFoundException({ code: 'WEBHOOK_NOT_FOUND', message: 'Webhook not found' });
      return tx.webhookDelivery.create({ data: { tenantId: tenantId(), subscriptionId: id, event: 'ping', payload: { event: 'ping', occurredAt: new Date().toISOString(), workspaceId: null, data: { message: `Test from ${ctx().tenant?.name}` } } } });
    });
    await this.dispatcher.deliver(d.id);
    return this.db.tenant((tx) => tx.webhookDelivery.findUnique({ where: { id: d.id } }));
  }

  @Get('webhooks/:id/deliveries')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  deliveries(@Param('id') id: string, @Query('status') status?: string) {
    return this.db.tenant((tx) => tx.webhookDelivery.findMany({ where: { subscriptionId: id, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }));
  }

  @Post('webhook-deliveries/:id/retry')
  @RequireFeature('module.integrations')
  @RequirePermission('integrations.developer', 'ORGANIZATION')
  async retry(@Param('id') id: string) {
    await this.db.tenant(async (tx) => {
      const d = await tx.webhookDelivery.findUnique({ where: { id } });
      if (!d) throw new NotFoundException({ code: 'DELIVERY_NOT_FOUND', message: 'Delivery not found' });
      await tx.webhookDelivery.update({ where: { id }, data: { status: 'pending', nextAttemptAt: new Date() } });
    });
    await this.dispatcher.deliver(id);
    return this.db.tenant((tx) => tx.webhookDelivery.findUnique({ where: { id } }));
  }

  // ── Web forms ──

  @Get('forms')
  @RequireFeature('module.crm')
  @RequirePermission('crm.lead.view')
  forms(@Query('archived') archived?: string) {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const rows = await tx.leadForm.findMany({ where: { workspaceId: ws, isArchived: archived === 'true' }, orderBy: { createdAt: 'desc' } });
      return {
        canManage: this.canManage(ws),
        targets: [...Object.entries(FORM_TARGETS).map(([value, label]) => ({ value, label })), ...(await tx.leadField.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { position: 'asc' } })).map((f) => ({ value: `cf:${f.key}`, label: f.label }))],
        duplicateModes: Object.entries(DUPLICATE_MODES).map(([value, label]) => ({ value, label })),
        forms: rows.map((f) => this.withLinks(f)),
      };
    });
  }

  @Post('forms')
  @RequireFeature('module.crm')
  @RequirePermission('crm.form.manage')
  createForm(@Body() body: unknown) {
    const input = parse(FormBody, body);
    const ws = this.ws();
    this.assertManage(ws);
    return this.db.tenant(async (tx) => {
      await this.checkForm(tx, ws, input);
      const slug = input.slug ?? (await this.freeSlug(tx, input.name));
      if (await tx.leadForm.findFirst({ where: { slug } })) throw new BadRequestException({ code: 'SLUG_TAKEN', message: 'Another form already uses this link' });
      const f = await tx.leadForm.create({ data: { tenantId: tenantId(), workspaceId: ws, createdById: auth().userId, ...input, slug, description: input.description ?? null, redirectUrl: input.redirectUrl ?? null, fields: input.fields } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'form', entityId: f.id, action: 'form.created', newValue: { name: f.name, slug } });
      return this.withLinks(f);
    });
  }

  @Put('forms/:id')
  @RequireFeature('module.crm')
  @RequirePermission('crm.form.manage')
  updateForm(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(FormBody, body);
    return this.db.tenant(async (tx) => {
      const f = await tx.leadForm.findUnique({ where: { id } });
      if (!f) throw new NotFoundException({ code: 'FORM_NOT_FOUND', message: 'Form not found' });
      this.assertManage(f.workspaceId);
      await this.checkForm(tx, f.workspaceId, input);
      const slug = input.slug ?? f.slug;
      if (slug !== f.slug && (await tx.leadForm.findFirst({ where: { slug } }))) throw new BadRequestException({ code: 'SLUG_TAKEN', message: 'Another form already uses this link' });
      const u = await tx.leadForm.update({ where: { id }, data: { ...input, slug, description: input.description ?? null, redirectUrl: input.redirectUrl ?? null, fields: input.fields } });
      await this.db.audit(tx, { workspaceId: f.workspaceId, entity: 'form', entityId: id, action: 'form.updated', oldValue: { name: f.name, slug: f.slug, isActive: f.isActive }, newValue: { name: u.name, slug, isActive: u.isActive } });
      return this.withLinks(u);
    });
  }

  @Post('forms/:id/archive')
  @RequireFeature('module.crm')
  @RequirePermission('crm.form.manage')
  archiveForm(@Param('id') id: string, @Body() body: unknown) {
    const { archived } = parse(z.object({ archived: z.boolean().default(true) }), body ?? {});
    return this.db.tenant(async (tx) => {
      const f = await tx.leadForm.findUnique({ where: { id } });
      if (!f) throw new NotFoundException({ code: 'FORM_NOT_FOUND', message: 'Form not found' });
      this.assertManage(f.workspaceId);
      await tx.leadForm.update({ where: { id }, data: { isArchived: archived } });
      await this.db.audit(tx, { workspaceId: f.workspaceId, entity: 'form', entityId: id, action: archived ? 'form.archived' : 'form.restored' });
      return { ok: true };
    });
  }

  // ── helpers ──

  private withLinks<T extends { slug: string }>(f: T) {
    const slug = ctx().tenant!.slug;
    const url = `${WEB()}/f/${slug}/${f.slug}`;
    return {
      ...f, hostedUrl: url, postUrl: `${API()}/public/forms/${slug}/${f.slug}`,
      embedCode: `<iframe src="${url}?embed=1" style="width:100%;max-width:560px;height:640px;border:0" title="Enquiry form" loading="lazy"></iframe>`,
    };
  }

  private async freeSlug(tx: Tx, name: string) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'form';
    for (let i = 0; i < 50; i++) {
      const s = i ? `${base}-${i + 1}` : base;
      if (!(await tx.leadForm.findFirst({ where: { slug: s } }))) return s;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  private async checkForm(tx: Tx, ws: string, input: z.infer<typeof FormBody>) {
    const targets = input.fields.map((f) => f.target);
    if (new Set(targets).size !== targets.length) throw new BadRequestException({ code: 'DUPLICATE_FIELD', message: 'Each field can appear once' });
    if (!targets.includes('name')) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'The form needs a Name field' });
    const byEmail = (await tx.organizationSetting.findFirst())?.leadIdentifier === 'email';
    const id = byEmail ? 'email' : 'mobile';
    if (!input.fields.some((f) => f.target === id && f.required)) throw new BadRequestException({ code: 'LEAD_ID_REQUIRED', message: `The form needs a required ${byEmail ? 'Email' : 'Mobile'} field (it is your Lead ID)` });
    const cf = targets.filter((t) => t.startsWith('cf:')).map((t) => t.slice(3));
    if (cf.length && (await tx.leadField.count({ where: { workspaceId: ws, key: { in: cf }, isArchived: false } })) !== cf.length) throw new BadRequestException({ code: 'UNKNOWN_FIELD', message: 'A field is not a lead field of this business line' });
  }

  private ws() {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return ws;
  }

  private canManage(ws: string) {
    const scope = auth().permissions['crm.form.manage'];
    return scope === 'ORGANIZATION' || (!!scope && auth().workspaceId === ws);
  }

  private assertManage(ws: string) {
    if (!this.canManage(ws)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can change its forms' });
  }
}
