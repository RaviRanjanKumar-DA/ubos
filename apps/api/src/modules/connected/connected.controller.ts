import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpException, Logger, NotFoundException, Param, Patch, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { authFor } from '../../common/auth-for';
import { auth, ctx, tenantId, type TenantInfo } from '../../common/context';
import { parse } from '../../common/errors';
import { activity } from '../../common/lead-ops';
import { notify } from '../../common/notify';
import { scopeFilter } from '../../common/scope';
import { decrypt, encrypt, randomToken } from '../../auth/crypto';
import { asTenant, IntakeService } from '../integration-runtime';
import { clickSignature, MailService } from './mail.service';
import { connectCallback, isMailProvider, MAIL, mailConfigured, META, webBase, type MailProvider } from './providers';
import { LIVE_TENANT_STATUSES } from '@ubos/shared';

const COOKIE = 'ubos_connect';
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const appSecret = () => process.env.META_APP_SECRET ?? '';
const PageRoute = z.object({ workspaceId: z.string().uuid(), formRoutes: z.record(z.string().regex(/^\d+$/), z.string().uuid()).default({}) });
const EmailBody = z.object({ subject: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(20_000), track: z.boolean().default(true) });

async function graph<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${META.graph()}${path}`, { ...init, signal: AbortSignal.timeout(15_000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `Facebook answered HTTP ${res.status}`);
  return body;
}

/** Facebook's answers become lead fields. A question matching a custom field fills it; anything else goes in the remark so nothing is lost. */
export function leadFromAnswers(a: Record<string, string>, defs: { key: string; label: string }[]) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const used = new Set<string>();
  const take = (...names: string[]) => { for (const n of names) { const k = Object.keys(a).find((x) => norm(x) === norm(n) && a[x]); if (k) { used.add(k); return a[k]; } } return null; };
  const first = take('first_name'), last = take('last_name');
  const name = take('full_name', 'name') ?? ([first, last].filter(Boolean).join(' ') || null);
  const mobile = take('phone_number', 'phone', 'mobile', 'mobile_number', 'whatsapp_number');
  const email = take('email', 'work_email');
  const city = take('city');
  const customFields: Record<string, unknown> = {};
  for (const d of defs) { const v = take(d.key, d.label); if (v) customFields[d.key] = v; }
  const rest = Object.entries(a).filter(([k, v]) => !used.has(k) && v).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  return { name, mobile, email, city, customFields, remark: rest.join('\n') || null };
}

/** Starting a connection: the signed state travels through the provider; a cookie ties it to this browser, so someone else's link cannot attach an account. */
async function startState(jwt: JwtService, res: Response, provider: string, verifier: string | null) {
  const nonce = randomToken(16);
  const state = await jwt.signAsync({ nonce, tenant: ctx().tenant!.slug, userId: auth().userId, provider, verifier, typ: 'connect' }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: 600 });
  res.cookie(COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', path: '/connect', maxAge: 600_000 });
  return state;
}

@Controller('api/v1/connected')
@RequireFeature('module.crm')
export class ConnectedController {
  constructor(private db: DbService, private jwt: JwtService, private mail: MailService) {}

  // ── Mailboxes (each person connects their own) ──
  @Get('mail')
  @RequirePermission('crm.message.send')
  mailboxes() {
    return this.db.tenant(async (tx) => ({
      providers: { google: mailConfigured('google'), microsoft: mailConfigured('microsoft') },
      accounts: await tx.mailAccount.findMany({ where: { userId: auth().userId, status: { not: 'disconnected' } }, select: { id: true, provider: true, email: true, status: true, connectedAt: true, lastSyncAt: true, lastError: true, stored: true } }),
    }));
  }

  @Post('mail/:provider/start')
  @RequirePermission('crm.message.send')
  async startMail(@Param('provider') provider: string, @Res({ passthrough: true }) res: Response) {
    if (!isMailProvider(provider)) throw new NotFoundException({ code: 'UNKNOWN_PROVIDER', message: 'Unknown provider' });
    if (!mailConfigured(provider)) throw new BadRequestException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'This provider has not been set up on the server yet' });
    const verifier = randomToken(32);
    const state = await startState(this.jwt, res, provider, verifier);
    const p = MAIL[provider];
    const url = new URL(p.authorize());
    url.search = new URLSearchParams({ client_id: p.clientId()!, redirect_uri: connectCallback(provider), response_type: 'code', scope: p.scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...p.extra }).toString();
    return { url: url.toString() };
  }

  @Post('mail/:id/sync')
  @RequirePermission('crm.message.send')
  async syncNow(@Param('id') id: string) {
    const a = await this.db.tenant((tx) => tx.mailAccount.findFirst({ where: { id, userId: auth().userId } }));
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Mailbox not found' });
    return this.mail.syncAccount(a.id);
  }

  /** The access is removed; emails already stored on leads stay. */
  @Post('mail/:id/disconnect')
  @HttpCode(200)
  @RequirePermission('crm.message.send')
  disconnect(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const a = await tx.mailAccount.findFirst({ where: { id, userId: auth().userId } });
      if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Mailbox not found' });
      await tx.mailAccount.update({ where: { id }, data: { status: 'disconnected', tokensEncrypted: null } });
      await this.db.audit(tx, { entity: 'mail_account', entityId: id, action: 'mailbox.disconnected', newValue: { email: a.email, provider: a.provider } });
      return { ok: true };
    });
  }

  @Post('leads/:id/email')
  @RequirePermission('crm.message.send')
  async sendEmail(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(EmailBody, body);
    const lead = await this.db.tenant(async (tx) => {
      const l = await tx.lead.findFirst({ where: { AND: [{ id }, await scopeFilter(tx, 'crm.message.send')] } });
      if (!l) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      return l;
    });
    return this.mail.send(lead, input);
  }

  // ── Facebook pages (one admin connects them for the organization) ──
  @Get('facebook')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  facebook() {
    return this.db.tenant(async (tx) => ({
      configured: META.configured(),
      callbackUrl: connectCallback('facebook'),
      pages: (await tx.metaPage.findMany({ where: { status: { not: 'disconnected' } }, orderBy: { name: 'asc' } })).map(({ tokenEncrypted: _t, ...p }) => p),
    }));
  }

  @Post('facebook/start')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  async startFacebook(@Res({ passthrough: true }) res: Response) {
    if (!META.configured()) throw new BadRequestException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'The Facebook app has not been set up on the server yet' });
    const state = await startState(this.jwt, res, 'facebook', null);
    const url = new URL(META.dialog());
    url.search = new URLSearchParams({ client_id: process.env.META_APP_ID!, redirect_uri: connectCallback('facebook'), response_type: 'code', scope: META.scope, state }).toString();
    return { url: url.toString() };
  }

  private async page(tx: Tx, id: string) {
    const p = await tx.metaPage.findFirst({ where: { id, status: { not: 'disconnected' } } });
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Page not found' });
    return p;
  }

  @Get('facebook/pages/:id/forms')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  async forms(@Param('id') id: string) {
    const p = await this.db.tenant((tx) => this.page(tx, id));
    try {
      const r = await graph<{ data?: { id: string; name: string; status?: string }[] }>(`/${p.pageId}/leadgen_forms?fields=id,name,status&limit=100`, decrypt(p.tokenEncrypted!));
      return r.data ?? [];
    } catch (e) { throw new HttpException({ code: 'FACEBOOK_FAILED', message: e instanceof Error ? e.message : 'Facebook could not be reached' }, 502); }
  }

  /** Choosing a business line turns the page on: Facebook starts sending its new leads. */
  @Patch('facebook/pages/:id')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  async route(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(PageRoute, body);
    const p = await this.db.tenant(async (tx) => {
      const page = await this.page(tx, id);
      const ids = [...new Set([input.workspaceId, ...Object.values(input.formRoutes)])];
      if ((await tx.workspace.count({ where: { id: { in: ids }, isArchived: false } })) !== ids.length) throw new BadRequestException({ code: 'WORKSPACE_NOT_FOUND', message: 'Choose an active business line' });
      return page;
    });
    const other = await this.db.platform.metaPage.findFirst({ where: { pageId: p.pageId, status: 'active', tenantId: { not: tenantId() } }, select: { id: true } });
    if (other) throw new BadRequestException({ code: 'PAGE_TAKEN', message: 'This page is already connected to another organization' });
    if (p.status !== 'active') {
      await graph(`/${p.pageId}/subscribed_apps`, decrypt(p.tokenEncrypted!), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ subscribed_fields: 'leadgen' }) })
        .catch((e) => { throw new HttpException({ code: 'FACEBOOK_FAILED', message: e instanceof Error ? e.message : 'Facebook could not be reached' }, 502); });
    }
    return this.db.tenant(async (tx) => {
      const updated = await tx.metaPage.update({ where: { id }, data: { status: 'active', workspaceId: input.workspaceId, formRoutes: input.formRoutes, lastError: null } });
      await this.setCatalogue(tx, true);
      await this.db.audit(tx, { entity: 'meta_page', entityId: id, action: 'facebook_page.routed', newValue: { page: p.name, workspaceId: input.workspaceId, forms: Object.keys(input.formRoutes).length } });
      const { tokenEncrypted: _t, ...safe } = updated;
      return safe;
    });
  }

  @Post('facebook/pages/:id/disconnect')
  @HttpCode(200)
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  async disconnectPage(@Param('id') id: string) {
    const p = await this.db.tenant((tx) => this.page(tx, id));
    if (p.tokenEncrypted) await graph(`/${p.pageId}/subscribed_apps`, decrypt(p.tokenEncrypted), { method: 'DELETE' }).catch(() => undefined); // still disconnected here if Facebook is unreachable
    return this.db.tenant(async (tx) => {
      await tx.metaPage.update({ where: { id }, data: { status: 'disconnected', tokenEncrypted: null } });
      if (!(await tx.metaPage.count({ where: { status: 'active' } }))) await this.setCatalogue(tx, false);
      await this.db.audit(tx, { entity: 'meta_page', entityId: id, action: 'facebook_page.disconnected', newValue: { page: p.name } });
      return { ok: true };
    });
  }

  private async setCatalogue(tx: Tx, on: boolean) {
    const row = await tx.integrationConnection.findFirst({ where: { key: 'facebook_leads', workspaceId: null } });
    const status = on ? 'active' : 'inactive';
    if (row) await tx.integrationConnection.update({ where: { id: row.id }, data: { status } });
    else await tx.integrationConnection.create({ data: { tenantId: tenantId(), key: 'facebook_leads', status, activatedById: auth().userId, activatedAt: new Date() } });
  }
}

/** The browser returns here from Facebook, Google or Microsoft; Facebook also delivers new leads here. */
@Controller('connect')
export class ConnectCallbackController {
  private readonly log = new Logger('Connect');
  constructor(private db: DbService, private jwt: JwtService, private intake: IntakeService) {}

  @Get(':provider/callback')
  async callback(@Param('provider') provider: string, @Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    const done = (outcome: string) => res.redirect(`${webBase()}/app/connected?result=${encodeURIComponent(outcome)}`);
    try {
      const cookie = req.cookies?.[COOKIE] as string | undefined;
      res.clearCookie(COOKIE, { path: '/connect' });
      const st = q.state ? await this.jwt.verifyAsync(q.state, { secret: process.env.JWT_ACCESS_SECRET }).catch(() => null) : null;
      if (!st || st.typ !== 'connect' || st.provider !== provider || !cookie || !safeEq(String(st.nonce), cookie)) return done('STATE_INVALID');
      if (q.error || !q.code) return done('CANCELLED');
      const t = await this.db.app.tenant.findUnique({ where: { slug: st.tenant } });
      if (!t || !LIVE_TENANT_STATUSES.includes(t.status)) return done('STATE_INVALID');
      const info: TenantInfo = { id: t.id, slug: t.slug, name: t.name, status: t.status };
      ctx().tenant = info;
      ctx().auth = await authFor(this.db, info, st.userId, 'connect');
      if (provider === 'facebook') return done(await this.connectFacebook(q.code));
      if (isMailProvider(provider)) return done(await this.connectMail(provider, q.code, st.verifier));
      return done('STATE_INVALID');
    } catch (e) {
      this.log.error(e instanceof Error ? e.message : e);
      return done('FAILED');
    }
  }

  private async connectFacebook(code: string) {
    const id = process.env.META_APP_ID!, secret = appSecret();
    const short = await graph<{ access_token: string }>(`/oauth/access_token?${new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: connectCallback('facebook'), code })}`, null);
    const long = await graph<{ access_token: string }>(`/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: id, client_secret: secret, fb_exchange_token: short.access_token })}`, null);
    const pages = await graph<{ data?: { id: string; name: string; access_token: string }[] }>('/me/accounts?fields=id,name,access_token&limit=100', long.access_token);
    if (!pages.data?.length) return 'NO_PAGES';
    await this.db.tenant(async (tx) => {
      for (const p of pages.data!) {
        const tokenEncrypted = encrypt(p.access_token);
        const before = await tx.metaPage.findUnique({ where: { tenantId_pageId: { tenantId: tenantId(), pageId: p.id } } });
        await tx.metaPage.upsert({
          where: { tenantId_pageId: { tenantId: tenantId(), pageId: p.id } },
          create: { tenantId: tenantId(), pageId: p.id, name: p.name.slice(0, 200), tokenEncrypted, connectedById: auth().userId },
          update: { name: p.name.slice(0, 200), tokenEncrypted, connectedById: auth().userId, status: before?.status === 'active' ? 'active' : 'pending' },
        });
      }
      await this.db.audit(tx, { entity: 'meta_page', entityId: 'facebook', action: 'facebook_pages.connected', newValue: { pages: pages.data!.map((p) => p.name) } });
    });
    return 'FACEBOOK_OK';
  }

  private async connectMail(provider: MailProvider, code: string, verifier: string) {
    const p = MAIL[provider];
    const res = await fetch(p.token(), { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: p.clientId()!, client_secret: p.clientSecret()!, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: connectCallback(provider) }) });
    if (!res.ok) return 'FAILED';
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const who = await fetch(p.userinfo(), { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15_000) });
    if (!who.ok) return 'FAILED';
    const u = (await who.json()) as { email?: string; preferred_username?: string };
    const email = (u.email ?? u.preferred_username ?? '').toLowerCase();
    if (!email) return 'FAILED';
    const tokensEncrypted = encrypt(JSON.stringify({ access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 }));
    await this.db.tenant(async (tx) => {
      const key = { tenantId_userId_provider: { tenantId: tenantId(), userId: auth().userId, provider } };
      const row = await tx.mailAccount.upsert({ where: key, create: { tenantId: tenantId(), userId: auth().userId, provider, email, tokensEncrypted }, update: { email, tokensEncrypted, status: 'active', lastError: null } });
      await this.db.audit(tx, { entity: 'mail_account', entityId: row.id, action: 'mailbox.connected', newValue: { email, provider } });
    });
    return 'MAIL_OK';
  }

  @Get('meta/webhook')
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') vt: string, @Query('hub.challenge') challenge: string) {
    const want = process.env.META_VERIFY_TOKEN ?? '';
    if (mode !== 'subscribe' || !want || !vt || !safeEq(want, vt)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
    return challenge ?? '';
  }

  /** A failure to fetch a lead answers 502, so Facebook sends it again. A lead we cannot accept is kept in the inbox instead. */
  @Post('meta/webhook')
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') sig: string | undefined, @Body() body: { object?: string; entry?: { changes?: { field?: string; value?: { page_id?: string | number; form_id?: string | number; leadgen_id?: string | number } }[] }[] }) {
    const want = `sha256=${createHmac('sha256', appSecret()).update(req.rawBody ?? Buffer.alloc(0)).digest('hex')}`;
    if (!appSecret() || !sig || !safeEq(want, sig)) throw new UnauthorizedException({ code: 'BAD_SIGNATURE', message: 'Signature does not match' });
    let retry = false;
    for (const entry of body.entry ?? []) for (const c of entry.changes ?? []) {
      if (c.field !== 'leadgen' || !c.value?.leadgen_id || !c.value.page_id) continue;
      const page = await this.db.platform.metaPage.findFirst({ where: { pageId: String(c.value.page_id), status: 'active' } });
      if (!page?.tokenEncrypted) continue;
      const t = await this.db.platform.tenant.findUnique({ where: { id: page.tenantId } });
      if (!t || !LIVE_TENANT_STATUSES.includes(t.status)) continue;
      ctx().tenant = { id: t.id, slug: t.slug, name: t.name, status: t.status };
      try { await this.ingest(page, String(c.value.leadgen_id), c.value.form_id ? String(c.value.form_id) : null); }
      catch (e) {
        retry = true;
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        this.log.error(message);
        await this.db.tenant((tx) => tx.metaPage.update({ where: { id: page.id }, data: { lastError: message } })).catch(() => undefined);
      }
    }
    if (retry) throw new HttpException({ code: 'RETRY', message: 'Try again' }, 502);
    return { ok: true };
  }

  private async ingest(page: { id: string; tenantId: string; pageId: string; name: string; tokenEncrypted: string | null; workspaceId: string | null; formRoutes: unknown }, leadgenId: string, formId: string | null) {
    const seen = await this.db.tenant((tx) => tx.webhookInbox.findFirst({ where: { integrationKey: 'facebook_leads', externalId: leadgenId, status: { in: ['processed', 'skipped'] } }, select: { id: true } }));
    if (seen) return;
    const lead = await graph<{ id: string; created_time?: string; form_id?: string; field_data?: { name: string; values?: string[] }[] }>(`/${leadgenId}?fields=id,created_time,form_id,field_data`, decrypt(page.tokenEncrypted!));
    const form = formId ?? lead.form_id ?? null;
    const workspaceId = (form ? (page.formRoutes as Record<string, string>)[form] : undefined) ?? page.workspaceId;
    if (!workspaceId) throw new Error(`${page.name} has no business line`);
    const answers = Object.fromEntries((lead.field_data ?? []).map((f) => [f.name, (f.values ?? []).join(', ')]));
    const defs = await this.db.tenant((tx) => tx.leadField.findMany({ where: { workspaceId, isArchived: false }, select: { key: true, label: true } }));
    const m = leadFromAnswers(answers, defs);
    const out = await this.intake.process({
      tenantId: page.tenantId, integrationKey: 'facebook_leads', workspaceId, mode: 'add_remark', via: `Facebook page “${page.name}”`, record: { leadgen_id: leadgenId, form_id: form, page: page.name, ...answers }, externalId: leadgenId,
      input: { name: m.name, mobile: m.mobile, email: m.email, city: m.city, customFields: m.customFields, remark: m.remark, source: 'facebook' },
    });
    await this.db.tenant((tx) => tx.metaPage.update({ where: { id: page.id }, data: { lastLeadAt: new Date(), lastError: out.outcome === 'rejected' ? out.errors.join('; ').slice(0, 300) : null, ...(out.outcome === 'created' ? { leads: { increment: 1 } } : {}) } }));
  }
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Open and click tracking for emails sent from a connected mailbox. These never fail visibly to the reader. */
@Controller('t')
export class TrackingController {
  constructor(private db: DbService) {}

  private async record(org: string, token: string, kind: 'open' | 'click') {
    await asTenant(this.db, org, () => this.db.tenant(async (tx) => {
      const m = await tx.message.findFirst({ where: { trackToken: token } });
      if (!m) return;
      const now = new Date();
      const first = kind === 'open' ? !m.openedAt : !m.clickedAt;
      await tx.message.update({ where: { id: m.id }, data: kind === 'open' ? { openCount: { increment: 1 }, openedAt: m.openedAt ?? now } : { clickCount: { increment: 1 }, clickedAt: m.clickedAt ?? now, openCount: m.openCount || 1, openedAt: m.openedAt ?? now } });
      if (!first) return;
      const conv = await tx.conversation.findUnique({ where: { id: m.conversationId } });
      const lead = conv?.leadId ? await tx.lead.findUnique({ where: { id: conv.leadId } }) : null;
      if (!lead) return;
      await tx.leadActivity.create({ data: activity(lead, m.userId, { type: 'message', remark: `Email ${kind === 'open' ? 'opened' : 'link clicked'}: ${m.subject ?? ''}`.slice(0, 250), data: { messageId: m.id, channel: 'email' } }) });
      if (m.userId) await notify(tx, [m.userId], { type: 'mention', title: `${kind === 'open' ? 'Email opened' : 'Link clicked'}: ${m.subject ?? ''}`.slice(0, 200), link: `/app/leads/${lead.id}?tab=outreach` });
    }));
  }

  @Get('o/:org/:file')
  async open(@Param('org') org: string, @Param('file') file: string, @Res() res: Response) {
    await this.record(org, file.replace(/\.gif$/, ''), 'open').catch(() => undefined);
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(GIF);
  }

  @Get('c/:org/:token')
  async click(@Param('org') org: string, @Param('token') token: string, @Query('u') url: string, @Query('s') sig: string, @Res() res: Response) {
    // Only addresses UBOS signed when the email went out can be redirected to.
    if (!url || !sig || !safeEq(clickSignature(token, url), sig) || !/^https?:\/\//i.test(url)) return res.status(404).send('Not found');
    await this.record(org, token, 'click').catch(() => undefined);
    return res.redirect(url);
  }
}
