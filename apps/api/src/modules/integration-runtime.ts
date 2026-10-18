import { HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { DUPLICATE_MODES, parseCsv, type DuplicateMode } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { contextStore, ctx, TenantInfo } from '../common/context';
import { decrypt, encrypt } from '../auth/crypto';
import { applyMapping, intakeLead, type IntakeInput, type IntakeResult } from '../common/lead-intake';

export interface IntegrationConfig {
  values: Record<string, string>; webhookToken?: string; lastSyncAt?: string;
  mapping?: { sourceFields: string[]; map: Record<string, string>; duplicateMode: string; defaultSource: string };
}
export const readConfig = (blob: string | null | undefined): IntegrationConfig => {
  if (!blob) return { values: {} };
  try { return JSON.parse(decrypt(blob)); } catch { return { values: {} }; }
};
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const ID_FIELDS = ['UNIQUE_QUERY_ID', 'leadgen_id', 'lead_id', 'enquiry_id', 'id', 'external_id'];
const asMode = (m: string | undefined): DuplicateMode => (m && m in DUPLICATE_MODES ? (m as DuplicateMode) : 'add_remark');

/** Simple fixed-window limiter per key (in memory; enough for one API instance). */
const windows = new Map<string, { start: number; count: number }>();
export function rateLimit(key: string, perMinute: number) {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start > 60_000) { windows.set(key, { start: now, count: 1 }); return; }
  if (++w.count > perMinute) throw new HttpException({ code: 'RATE_LIMITED', message: `Too many requests — at most ${perMinute} a minute` }, 429);
}

/** Runs `fn` as the organization with this slug (public routes have no signed-in user). */
export async function asTenant<T>(db: DbService, slug: string, fn: (t: TenantInfo) => Promise<T>): Promise<T> {
  const t = await db.app.tenant.findUnique({ where: { slug: slug.toLowerCase() } });
  if (!t || !['active', 'trial'].includes(t.status)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
  const info: TenantInfo = { id: t.id, slug: t.slug, name: t.name, status: t.status };
  ctx().tenant = info;
  return fn(info);
}

/**
 * Turns incoming records (webhook bodies, sheet rows, form posts) into leads. Every record is first stored in the
 * inbox (its own transaction, so nothing is lost if processing fails), then processed through lead intake, and the
 * inbox row gets the outcome. A record with an id the sender already sent is not processed twice.
 */
@Injectable()
export class IntakeService {
  constructor(private db: DbService) {}

  /** Webhook bodies come as one object, an array, or wrapped ({ RESPONSE: {...} } / { data: [...] } / { leads: [...] }). */
  records(body: unknown): Record<string, unknown>[] {
    return this.unwrap(body).map(flatten);
  }

  private unwrap(body: unknown): Record<string, unknown>[] {
    if (Array.isArray(body)) return body.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
    if (!body || typeof body !== 'object') return [];
    const b = body as Record<string, unknown>;
    for (const k of ['RESPONSE', 'data', 'leads', 'entry']) {
      const v = b[k];
      if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
      if (v && typeof v === 'object') return [v as Record<string, unknown>];
    }
    return [b];
  }

  externalIdOf(record: Record<string, unknown>, header?: string | null) {
    if (header) return String(header).slice(0, 120);
    for (const f of ID_FIELDS) if (record[f] !== undefined && record[f] !== null && record[f] !== '') return String(record[f]).slice(0, 120);
    return null;
  }

  /** Stores, de-duplicates and processes one record. */
  async process(o: {
    tenantId: string; integrationKey: string; workspaceId: string; mode: DuplicateMode; via: string;
    record: Record<string, unknown>; input: IntakeInput; externalId: string | null; headers?: Record<string, unknown>; inboxId?: string;
  }): Promise<IntakeResult & { inboxId: string; duplicate?: boolean }> {
    if (o.externalId && !o.inboxId) {
      const seen = await this.db.tenant((tx) => tx.webhookInbox.findFirst({ where: { integrationKey: o.integrationKey, externalId: o.externalId, status: { in: ['processed', 'skipped'] } } }));
      if (seen) {
        const dup = await this.db.tenant((tx) => tx.webhookInbox.create({
          data: { tenantId: o.tenantId, integrationKey: o.integrationKey, headers: (o.headers ?? {}) as object, body: JSON.stringify(o.record).slice(0, 65_000), externalId: o.externalId, status: 'duplicate', outcome: seen.outcome, leadId: seen.leadId, processedAt: new Date() },
        }));
        return { outcome: (seen.outcome ?? 'skip') as IntakeResult['outcome'], leadId: seen.leadId, customerId: null, errors: [], inboxId: dup.id, duplicate: true };
      }
    }
    const inbox = o.inboxId
      ? await this.db.tenant((tx) => tx.webhookInbox.update({ where: { id: o.inboxId }, data: { attempts: { increment: 1 } } }))
      : await this.db.tenant((tx) => tx.webhookInbox.create({
        data: { tenantId: o.tenantId, integrationKey: o.integrationKey, headers: (o.headers ?? {}) as object, body: JSON.stringify(o.record).slice(0, 65_000), externalId: o.externalId, attempts: 1 },
      }));
    try {
      const r = await this.db.tenant((tx) => intakeLead(tx, o.tenantId, o.workspaceId, o.input, o.mode, o.via));
      await this.db.tenant((tx) => tx.webhookInbox.update({
        where: { id: inbox.id },
        data: { status: r.outcome === 'rejected' ? 'failed' : r.outcome === 'skip' ? 'skipped' : 'processed', outcome: r.outcome, leadId: r.leadId, error: r.errors.join('; ') || null, processedAt: new Date() },
      }));
      return { ...r, inboxId: inbox.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.db.tenant((tx) => tx.webhookInbox.update({ where: { id: inbox.id }, data: { status: 'failed', error: msg.slice(0, 500), processedAt: new Date() } }));
      return { outcome: 'rejected', leadId: null, customerId: null, errors: [msg], inboxId: inbox.id };
    }
  }

  /** Processes a record through an integration's saved mapping. */
  async viaMapping(tenantId: string, key: string, via: string, cfg: IntegrationConfig, record: Record<string, unknown>, externalId: string | null, headers?: Record<string, unknown>, inboxId?: string) {
    const ws = cfg.values.businessLine;
    if (!ws || !cfg.mapping) return { outcome: 'rejected' as const, leadId: null, customerId: null, errors: ['Set the business line and save the field mapping first'], inboxId: inboxId ?? null };
    const input = applyMapping(record, cfg.mapping.map, cfg.values.defaultSource || cfg.mapping.defaultSource || key);
    return this.process({ tenantId, integrationKey: key, workspaceId: ws, mode: asMode(cfg.mapping.duplicateMode), via, record, input, externalId, headers, inboxId });
  }

  /** Google Sheets: reads the sheet as CSV (published or shared-by-link) and brings in rows not seen before. */
  async syncSheet(tenantId: string) {
    const conn = await this.db.tenant((tx) => tx.integrationConnection.findFirst({ where: { key: 'google_sheets', workspaceId: null } }));
    const cfg = readConfig(conn?.configEncrypted);
    if (!conn || !cfg.values.sheetUrl) throw new HttpException({ code: 'NOT_CONFIGURED', message: 'Paste the sheet link and save first' }, 400);
    const url = sheetCsvUrl(cfg.values.sheetUrl, cfg.values.tab);
    await assertPublicUrl(url);
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new HttpException({ code: 'SHEET_UNREACHABLE', message: `The sheet could not be read (HTTP ${res.status}). Publish it to the web as CSV, or share it with “anyone with the link”.` }, 400);
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new HttpException({ code: 'SHEET_NOT_PUBLIC', message: 'Google returned a sign-in page — publish the sheet as CSV or share it with “anyone with the link”.' }, 400);
    const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
    if (!rows.length) return { rows: 0, created: 0, linked: 0, updated: 0, skipped: 0, failed: 0, seen: 0 };
    const headers = rows[0].map((h) => h.trim());
    const result = { rows: rows.length - 1, created: 0, linked: 0, updated: 0, skipped: 0, failed: 0, seen: 0 };
    const known = new Set((await this.db.tenant((tx) => tx.webhookInbox.findMany({ where: { integrationKey: 'google_sheets', status: { in: ['processed', 'skipped', 'duplicate'] } }, select: { externalId: true } }))).map((r) => r.externalId));
    for (const r of rows.slice(1, 5001)) {
      const record = Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]));
      const id = sha256(JSON.stringify(record));
      if (known.has(id)) { result.seen++; continue; }
      const out = await this.viaMapping(tenantId, 'google_sheets', 'Google Sheets', cfg, record, id);
      if (out.outcome === 'created') result.created++;
      else if (out.outcome === 'linked') result.linked++;
      else if (out.outcome === 'rejected') result.failed++;
      else if (out.outcome === 'skip') result.skipped++;
      else result.updated++;
    }
    await this.db.tenant((tx) => tx.integrationConnection.update({ where: { id: conn.id }, data: { configEncrypted: encrypt(JSON.stringify({ ...cfg, lastSyncAt: new Date().toISOString() })), lastEventAt: new Date() } }));
    return result;
  }
}

/** A normal Google Sheets link becomes its CSV export link; published (/pub?output=csv) and other CSV links stay as they are. */
export function sheetCsvUrl(link: string, tab?: string) {
  const m = link.match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!m || /\/pub\b|output=csv|format=csv/.test(link)) return link;
  const gid = link.match(/[#&?]gid=(\d+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv${tab ? `&sheet=${encodeURIComponent(tab)}` : gid ? `&gid=${gid}` : ''}`;
}

/**
 * Outgoing calls must not reach private networks (SSRF), except while developing locally (NODE_ENV not production)
 * or when ALLOW_PRIVATE_WEBHOOKS=true.
 */
export async function assertPublicUrl(url: string) {
  let u: URL;
  try { u = new URL(url); } catch { throw new HttpException({ code: 'INVALID_URL', message: 'Invalid URL' }, 400); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpException({ code: 'INVALID_URL', message: 'Only http(s) URLs are allowed' }, 400);
  if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_PRIVATE_WEBHOOKS === 'true') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  const priv = (ip: string) => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip);
  if (!ips.length || ips.some(priv)) throw new HttpException({ code: 'PRIVATE_URL', message: 'This address is not reachable from UBOS' }, 400);
}

const BACKOFF_MIN = [1, 5, 30, 120, 360]; // minutes before retry 2..6
const MAX_ATTEMPTS = 6;

/**
 * Sends queued outgoing webhooks every few seconds: JSON body, `X-UBOS-Event`, `X-UBOS-Delivery`, and
 * `X-UBOS-Signature: t=<unix>,v1=<hmac-sha256(secret, "<t>.<body>")>`. Failures retry with back-off; a subscription
 * that keeps failing (20 in a row) is paused. Runs as the system across organizations (platform connection).
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Webhooks');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private db: DbService) {}

  onModuleInit() {
    if (process.env.WEBHOOKS_DISABLED === 'true') return;
    this.timer = setInterval(() => { this.run().catch((e) => this.log.error(e instanceof Error ? e.message : e)); }, 3_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async run(onlyTenantId?: string) {
    if (this.busy) return 0;
    this.busy = true;
    let sent = 0;
    try {
      const due = await this.db.platform.webhookDelivery.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: new Date() }, ...(onlyTenantId ? { tenantId: onlyTenantId } : {}) }, orderBy: { createdAt: 'asc' }, take: 50,
      });
      for (const d of due) { await this.deliver(d.id); sent++; }
    } finally { this.busy = false; }
    return sent;
  }

  async deliver(id: string) {
    const p = this.db.platform;
    const d = await p.webhookDelivery.findUnique({ where: { id } });
    if (!d) return;
    const sub = await p.webhookSubscription.findUnique({ where: { id: d.subscriptionId } });
    if (!sub || !sub.isActive) { await p.webhookDelivery.update({ where: { id }, data: { status: 'failed', error: 'Webhook is paused or removed' } }); return; }
    const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', decrypt(sub.secretEncrypted)).update(`${t}.${body}`).digest('hex');
    let status: number | null = null, text = '', error: string | null = null;
    try {
      await assertPublicUrl(sub.url);
      const res = await fetch(sub.url, {
        method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'UBOS-Webhooks/1.0', 'X-UBOS-Event': d.event, 'X-UBOS-Delivery': d.id, 'X-UBOS-Signature': `t=${t},v1=${sig}` },
      });
      status = res.status; text = (await res.text().catch(() => '')).slice(0, 1000);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const ok = status !== null && status >= 200 && status < 300;
    const attempts = d.attempts + 1;
    await p.webhookDelivery.update({
      where: { id },
      data: ok
        ? { status: 'delivered', attempts, responseStatus: status, responseBody: text, error: null, deliveredAt: new Date() }
        : { status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, responseStatus: status, responseBody: text, error: error ?? `HTTP ${status}`, nextAttemptAt: new Date(Date.now() + (BACKOFF_MIN[attempts - 1] ?? 360) * 60_000) },
    });
    const failures = ok ? 0 : sub.failureCount + 1;
    await p.webhookSubscription.update({ where: { id: sub.id }, data: { lastDeliveryAt: new Date(), lastStatus: status, failureCount: failures, ...(failures >= 20 ? { isActive: false } : {}) } });
  }
}

/**
 * Some senders put answers in a list: Google Ads lead forms (user_column_data: [{ column_id, string_value }]) and
 * Facebook (field_data: [{ name, values }]). They become plain fields so the mapping can use them.
 */
function flatten(r: Record<string, unknown>): Record<string, unknown> {
  const out = { ...r };
  if (Array.isArray(r.user_column_data)) for (const c of r.user_column_data as { column_id?: string; column_name?: string; string_value?: string }[]) { if (c.column_id) out[c.column_id] = c.string_value ?? ''; if (c.column_name) out[c.column_name] = c.string_value ?? ''; }
  if (Array.isArray(r.field_data)) for (const c of r.field_data as { name?: string; values?: string[] }[]) if (c.name) out[c.name] = (c.values ?? []).join(', ');
  return out;
}

/** Runs Google Sheets syncs that are due (called by the scheduler every minute). */
export async function dueSheetSyncs(db: DbService, intake: IntakeService) {
  const conns = await db.platform.integrationConnection.findMany({ where: { key: 'google_sheets', status: 'active', workspaceId: null } });
  for (const c of conns) {
    const cfg = readConfig(c.configEncrypted);
    const every = Math.max(5, Number(cfg.values.syncMinutes) || 15);
    if (cfg.lastSyncAt && Date.now() - new Date(cfg.lastSyncAt).getTime() < every * 60_000) continue;
    const t = await db.platform.tenant.findUnique({ where: { id: c.tenantId } });
    if (!t || !['active', 'trial'].includes(t.status)) continue;
    await contextStore.run({ traceId: `sheets-${Date.now()}`, ip: null, tenant: { id: t.id, slug: t.slug, name: t.name, status: t.status } }, () => intake.syncSheet(t.id).catch(() => undefined));
  }
}
