import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { authFor } from '../../common/auth-for';
import { resolvePermissions } from '@ubos/shared';
import { auth, AuthInfo, contextStore, ctx, TenantInfo } from '../../common/context';
import { activity } from '../../common/lead-ops';
import { notify } from '../../common/notify';
import { scopeFilter } from '../../common/scope';
import { decrypt, encrypt, keyedHash, randomToken } from '../../auth/crypto';
import { apiBase, isMailProvider, MAIL, type MailProvider } from './providers';

interface Tokens { access: string; refresh?: string; expiresAt: number }
interface Account { id: string; tenantId: string; userId: string; provider: string; email: string; tokensEncrypted: string | null; connectedAt: Date; syncedTo: Date | null }
interface Meta { id: string; from: string[]; to: string[]; subject: string; at: Date }

class ReconnectNeeded extends Error {}

const FIRST_SYNC_DAYS = 14;
const PAGES = 3;
const ADDRESS = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const addresses = (v: string | undefined | null) => (v ?? '').match(ADDRESS)?.map((a) => a.toLowerCase()) ?? [];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const stripHtml = (s: string) => s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();
export const clickSignature = (token: string, url: string) => keyedHash(`click:${token}:${url}`).slice(0, 32);

export function emailHtml(body: string, track: { slug: string; token: string } | null) {
  const link = (u: string) => (track ? `${apiBase()}/t/c/${track.slug}/${track.token}?u=${encodeURIComponent(u)}&s=${clickSignature(track.token, u)}` : u);
  const parts = body.split(/(https?:\/\/[^\s<>"]+)/g).map((p, i) => (i % 2 ? `<a href="${esc(link(p))}">${esc(p)}</a>` : esc(p)));
  return `<div style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:14px">${parts.join('')}</div>${track ? `<img src="${apiBase()}/t/o/${track.slug}/${track.token}.gif" width="1" height="1" alt="" style="display:none">` : ''}`;
}

/** One person's connected Gmail or Outlook: mail with known customers comes into UBOS; everything else is never stored. */
@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  constructor(private db: DbService) {}

  private async access(a: Account) {
    if (!a.tokensEncrypted) throw new ReconnectNeeded('Not connected');
    const t = JSON.parse(decrypt(a.tokensEncrypted)) as Tokens;
    if (t.expiresAt > Date.now() + 60_000) return t.access;
    if (!t.refresh) throw new ReconnectNeeded('Permission expired');
    const p = MAIL[a.provider as MailProvider];
    const res = await fetch(p.token(), { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: p.clientId() ?? '', client_secret: p.clientSecret() ?? '', grant_type: 'refresh_token', refresh_token: t.refresh }) });
    if (res.status === 400 || res.status === 401) throw new ReconnectNeeded('Permission was withdrawn');
    if (!res.ok) throw new Error(`Token refresh failed (HTTP ${res.status})`);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const next: Tokens = { access: j.access_token, refresh: j.refresh_token ?? t.refresh, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    await this.db.tenant((tx) => tx.mailAccount.update({ where: { id: a.id }, data: { tokensEncrypted: encrypt(JSON.stringify(next)) } }));
    return next.access;
  }

  private async call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'IdType="ImmutableId"', ...(init.headers ?? {}) } });
    const text = await res.text();
    // A 403 can also be a temporary rate limit, which must not make someone reconnect.
    if (res.status === 401 || (res.status === 403 && /insufficient|access.?denied|not.?authorized/i.test(text))) throw new ReconnectNeeded('The mailbox refused access');
    if (!res.ok) throw new Error(`The mailbox answered HTTP ${res.status}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async list(provider: MailProvider, token: string, since: Date): Promise<Meta[]> {
    const out: Meta[] = [];
    const api = MAIL[provider].api();
    if (provider === 'google') {
      let page: string | undefined;
      for (let i = 0; i < PAGES; i++) {
        const q = new URLSearchParams({ q: `after:${Math.floor(since.getTime() / 1000)}`, maxResults: '100', ...(page ? { pageToken: page } : {}) });
        const r = await this.call<{ messages?: { id: string }[]; nextPageToken?: string }>(token, `${api}/gmail/v1/users/me/messages?${q}`);
        for (const m of r.messages ?? []) {
          const d = await this.call<{ id: string; internalDate: string; payload?: { headers?: { name: string; value: string }[] } }>(token, `${api}/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`);
          const h = (n: string) => d.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value;
          out.push({ id: d.id, from: addresses(h('from')), to: [...addresses(h('to')), ...addresses(h('cc'))], subject: h('subject') ?? '', at: new Date(Number(d.internalDate)) });
        }
        page = r.nextPageToken;
        if (!page) break;
      }
      return out;
    }
    type Who = { emailAddress?: { address?: string } };
    let url: string | undefined = `${api}/me/messages?${new URLSearchParams({ $filter: `receivedDateTime ge ${since.toISOString()}`, $orderby: 'receivedDateTime desc', $top: '100', $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime' })}`;
    for (let i = 0; i < PAGES && url; i++) {
      const r: { value?: { id: string; subject?: string; from?: Who; toRecipients?: Who[]; ccRecipients?: Who[]; receivedDateTime: string }[]; '@odata.nextLink'?: string } = await this.call(token, url);
      for (const m of r.value ?? []) out.push({ id: m.id, from: addresses(m.from?.emailAddress?.address), to: [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].flatMap((w) => addresses(w.emailAddress?.address)), subject: m.subject ?? '', at: new Date(m.receivedDateTime) });
      url = r['@odata.nextLink'];
    }
    return out;
  }

  /** Only called for mail with a known customer, so other mail bodies are never downloaded. */
  private async body(provider: MailProvider, token: string, id: string) {
    const api = MAIL[provider].api();
    if (provider === 'microsoft') {
      const m = await this.call<{ body?: { contentType?: string; content?: string } }>(token, `${api}/me/messages/${id}?$select=body`, { headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } });
      const c = m.body?.content ?? '';
      return m.body?.contentType === 'html' ? stripHtml(c) : c;
    }
    type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };
    const m = await this.call<{ snippet?: string; payload?: Part }>(token, `${api}/gmail/v1/users/me/messages/${id}?format=full`);
    const find = (p: Part | undefined, type: string): string | undefined => { if (!p) return undefined; if (p.mimeType === type && p.body?.data) return p.body.data; for (const c of p.parts ?? []) { const f = find(c, type); if (f) return f; } return undefined; };
    const plain = find(m.payload, 'text/plain');
    if (plain) return Buffer.from(plain, 'base64url').toString('utf8');
    const html = find(m.payload, 'text/html');
    return html ? stripHtml(Buffer.from(html, 'base64url').toString('utf8')) : m.snippet ?? '';
  }

  /** Sync runs as the mailbox owner, and notify skips the person acting, so these are sent as the system. */
  private tell(tx: Tx, ids: string[], n: Parameters<typeof notify>[2]) {
    return contextStore.run({ ...ctx(), auth: undefined }, () => notify(tx, ids, n));
  }

  private asUser<T>(tenant: TenantInfo, who: AuthInfo, fn: () => Promise<T>) {
    return contextStore.run({ traceId: `mail-${Date.now()}`, ip: null, tenant, auth: who }, fn);
  }

  /** Runs one mailbox as its owner, so only customers that person can already see are matched. */
  async syncAccount(accountId: string) {
    const tenant = ctx().tenant!;
    const account = await this.db.tenant((tx) => tx.mailAccount.findFirst({ where: { id: accountId, status: { in: ['active', 'error'] } } }));
    if (!account) return { stored: 0, checked: 0 };
    const who = await authFor(this.db, tenant, account.userId, 'mail-sync');
    return this.asUser(tenant, who, async () => {
      const started = new Date();
      try {
        const out = await this.pull(account);
        await this.db.tenant((tx) => tx.mailAccount.update({ where: { id: account.id }, data: { status: 'active', lastError: null, lastSyncAt: started, syncedTo: new Date(started.getTime() - 120_000), stored: { increment: out.stored } } }));
        return out;
      } catch (e) {
        const reconnect = e instanceof ReconnectNeeded;
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        await this.db.tenant(async (tx) => {
          await tx.mailAccount.update({ where: { id: account.id }, data: { status: reconnect ? 'error' : account.status, lastError: message, lastSyncAt: started } });
          if (reconnect && account.status === 'active') await this.tell(tx, [account.userId], { type: 'reminder', title: `Reconnect your mailbox ${account.email}`, body: 'UBOS can no longer read or send email from it.', link: '/app/connected' });
        });
        return { stored: 0, checked: 0, error: message };
      }
    });
  }

  private async pull(a: Account) {
    const provider = a.provider as MailProvider;
    const token = await this.access(a);
    const since = a.syncedTo ?? new Date(a.connectedAt.getTime() - FIRST_SYNC_DAYS * 86_400_000);
    const metas = await this.list(provider, token, since);
    const own = a.email.toLowerCase();
    const counterpart = (m: Meta) => (m.from.includes(own) ? m.to.filter((x) => x !== own) : m.from);
    const all = [...new Set(metas.flatMap(counterpart))];
    const known = new Set((await this.db.tenant((tx) => tx.customer.findMany({ where: { email: { in: all }, mergedIntoId: null }, select: { email: true } }))).map((c) => c.email));
    let stored = 0;
    for (const m of metas.filter((x) => counterpart(x).some((c) => known.has(c)))) {
      const providerId = `${provider}:${m.id}`;
      const exists = await this.db.tenant((tx) => tx.message.findFirst({ where: { waMessageId: providerId }, select: { id: true } }));
      if (exists) continue;
      const addrs = counterpart(m).filter((c) => known.has(c));
      const lead = await this.visibleLead(addrs);
      if (!lead) continue; // a customer this person cannot see: not stored
      const text = (await this.body(provider, token, m.id)).slice(0, 20_000);
      const inbound = !m.from.includes(own);
      stored += await this.db.tenant(async (tx) => {
        const conv = await tx.conversation.upsert({
          where: { tenantId_channel_waId: { tenantId: a.tenantId, channel: 'email', waId: lead.customer.email! } },
          create: { tenantId: a.tenantId, channel: 'email', waId: lead.customer.email!, leadId: lead.id, customerId: lead.customerId, workspaceId: lead.workspaceId, assigneeId: lead.ownerId, lastMessageAt: m.at },
          update: { lastMessageAt: m.at },
        });
        const made = await tx.message.createMany({ skipDuplicates: true, data: { tenantId: a.tenantId, conversationId: conv.id, direction: inbound ? 'in' : 'out', type: 'email', subject: oneLine(m.subject).slice(0, 300), body: text, waMessageId: providerId, status: inbound ? 'received' : 'sent', userId: inbound ? null : a.userId, createdAt: m.at } });
        if (!made.count) return 0;
        await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'message', remark: `Email ${inbound ? 'received' : 'sent'}: ${oneLine(m.subject).slice(0, 200) || '(no subject)'}`, data: { channel: 'email', provider, direction: inbound ? 'in' : 'out' } }) });
        // Mail from before the mailbox was connected is history, not news.
        if (inbound && m.at > a.connectedAt && lead.ownerId) await this.tell(tx, [lead.ownerId], { type: 'mention', title: `Email from ${lead.customer.name}`, body: oneLine(m.subject).slice(0, 200), link: `/app/leads/${lead.id}?tab=outreach` });
        return 1;
      });
    }
    return { stored, checked: metas.length };
  }

  /** The newest lead with one of these customers that the mailbox owner can see. Roles differ per business line, so each is checked on its own. */
  private async visibleLead(addrs: string[]) {
    const who = auth();
    const found = await this.db.tenant((tx) => tx.lead.findMany({ where: { workspaceId: { in: who.accessibleWorkspaceIds }, customer: { email: { in: addrs }, mergedIntoId: null } }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, workspaceId: true } }));
    for (const workspaceId of [...new Set(found.map((l) => l.workspaceId))]) {
      const view: AuthInfo = { ...who, workspaceId, permissions: resolvePermissions(who.assignments, { workspaceId, features: who.features }) };
      const lead = await contextStore.run({ ...ctx(), auth: view }, () => this.db.tenant(async (tx) => tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.lead.view'), { id: { in: found.filter((l) => l.workspaceId === workspaceId).map((l) => l.id) } }] }, orderBy: { updatedAt: 'desc' }, include: { customer: true } })));
      if (lead) return lead;
    }
    return null;
  }

  /** Every minute from the scheduler; each mailbox is read at most once every MAIL_SYNC_MINUTES (default 5). */
  async syncDue() {
    const every = Math.max(1, Number(process.env.MAIL_SYNC_MINUTES) || 5) * 60_000;
    const due = await this.db.platform.mailAccount.findMany({ where: { status: 'active', OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(Date.now() - every) } }] }, take: 50, orderBy: { lastSyncAt: 'asc' } });
    for (const a of due) {
      const t = await this.db.platform.tenant.findUnique({ where: { id: a.tenantId } });
      if (!t || !['active', 'trial'].includes(t.status)) continue;
      await contextStore.run({ traceId: `mail-${Date.now()}`, ip: null, tenant: { id: t.id, slug: t.slug, name: t.name, status: t.status } }, () => this.syncAccount(a.id)).catch((e) => this.log.error(e instanceof Error ? e.message : e));
    }
  }

  /** A one-to-one email from the person's own mailbox, optionally tracked. */
  async send(lead: { id: string; customerId: string; workspaceId: string; ownerId: string | null }, input: { subject: string; body: string; track: boolean }) {
    const c = ctx(), tenantId = c.tenant!.id, userId = c.auth!.userId;
    const prep = await this.db.tenant(async (tx: Tx) => {
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: lead.customerId } });
      if (!customer.email) throw new BadRequestException({ code: 'NO_ADDRESS', message: `${customer.name} has no email address` });
      if (customer.emailOptOut) throw new BadRequestException({ code: 'OPTED_OUT', message: `${customer.name} opted out of email` });
      const account = await tx.mailAccount.findFirst({ where: { userId, status: 'active' }, orderBy: { connectedAt: 'desc' } });
      if (!account) throw new BadRequestException({ code: 'NO_MAILBOX', message: 'Connect your mailbox first (Connected accounts)' });
      const conv = await tx.conversation.upsert({
        where: { tenantId_channel_waId: { tenantId, channel: 'email', waId: customer.email } },
        create: { tenantId, channel: 'email', waId: customer.email, leadId: lead.id, customerId: lead.customerId, workspaceId: lead.workspaceId, assigneeId: lead.ownerId },
        update: { leadId: lead.id, customerId: lead.customerId, workspaceId: lead.workspaceId },
      });
      const trackToken = input.track ? randomToken(24) : null;
      const msg = await tx.message.create({ data: { tenantId, conversationId: conv.id, direction: 'out', type: 'email', subject: oneLine(input.subject).slice(0, 300), body: input.body, status: 'queued', userId, trackToken } });
      return { account, conv, msg, to: customer.email, trackToken };
    });
    try {
      const html = emailHtml(input.body, prep.trackToken ? { slug: c.tenant!.slug, token: prep.trackToken } : null);
      const id = await this.deliver(prep.account, prep.to, oneLine(input.subject), input.body, html);
      return await this.db.tenant(async (tx) => {
        await tx.conversation.update({ where: { id: prep.conv.id }, data: { lastMessageAt: new Date() } });
        await tx.leadActivity.create({ data: activity(lead as never, userId, { type: 'message', remark: `Email sent: ${oneLine(input.subject).slice(0, 200)}`, data: { messageId: prep.msg.id, channel: 'email' } }) });
        return tx.message.update({ where: { id: prep.msg.id }, data: { status: 'sent', waMessageId: `${prep.account.provider}:${id}` } });
      });
    } catch (e) {
      const message = (e instanceof Error ? e.message : 'Failed').slice(0, 300);
      await this.db.tenant(async (tx) => {
        await tx.message.update({ where: { id: prep.msg.id }, data: { status: 'failed', error: message } });
        if (e instanceof ReconnectNeeded) await tx.mailAccount.update({ where: { id: prep.account.id }, data: { status: 'error', lastError: message } });
      });
      throw new HttpException({ code: e instanceof ReconnectNeeded ? 'RECONNECT_MAILBOX' : 'EMAIL_FAILED', message: e instanceof ReconnectNeeded ? 'Reconnect your mailbox, then try again' : `The email could not be sent: ${message}` }, 502);
    }
  }

  private async deliver(a: Account, to: string, subject: string, text: string, html: string) {
    if (!isMailProvider(a.provider)) throw new Error('Unknown mailbox');
    const token = await this.access(a);
    const api = MAIL[a.provider].api();
    if (a.provider === 'google') {
      const raw = await new Promise<Buffer>((ok, no) => new MailComposer({ from: a.email, to, subject, text, html }).compile().build((e, b) => (e ? no(e) : ok(b))));
      const r = await this.call<{ id?: string }>(token, `${api}/gmail/v1/users/me/messages/send`, { method: 'POST', body: JSON.stringify({ raw: raw.toString('base64url') }) });
      return r.id ?? randomUUID();
    }
    const draft = await this.call<{ id: string }>(token, `${api}/me/messages`, { method: 'POST', body: JSON.stringify({ subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }) });
    await this.call(token, `${api}/me/messages/${draft.id}/send`, { method: 'POST' });
    return draft.id;
  }
}
