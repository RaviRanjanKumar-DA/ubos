import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'crypto';
import { DbService } from '../../common/db.service';
import { activity } from '../../common/lead-ops';
import { live } from '../../common/live';
import { keyedHash } from '../../auth/crypto';
import { Mailer } from '../../auth/mailer';
import { assertPublicUrl, readConfig, type IntegrationConfig } from '../integration-runtime';

const API = () => (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const STATUS_ORDER = ['queued', 'sent', 'delivered'];
export const unsubscribeToken = (tenantId: string, customerId: string) => `${customerId}.${keyedHash(`unsub:${tenantId}:${customerId}`).slice(0, 32)}`;
export function unsubscribeCustomerId(tenantId: string, token: string) {
  const id = token.split('.')[0];
  const want = Buffer.from(unsubscribeToken(tenantId, id));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

/** What fills each template blank, in order: lead fields, the owner, or fixed words. */
export function fillVariables(variables: string[], lead: { customFields: unknown; customer: { name: string; mobile: string | null; city: string | null } }, ownerName: string | null) {
  const cf = (lead.customFields ?? {}) as Record<string, unknown>;
  return variables.map((v) => String(
    v === 'name' ? lead.customer.name : v === 'mobile' ? lead.customer.mobile ?? '' : v === 'city' ? lead.customer.city ?? '' : v === 'owner' ? ownerName ?? '' :
      v.startsWith('cf:') ? cf[v.slice(3)] ?? '' : v.startsWith('text:') ? v.slice(5) : '',
  ));
}
export const countBlanks = (channel: string, text: string) => (channel === 'sms' ? (text.match(/\{#var#\}/gi) ?? []).length : Math.max(0, ...[...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))));
const fill = (channel: string, text: string, params: string[]) => {
  if (channel === 'sms') { let i = 0; return text.replace(/\{#var#\}/gi, () => params[i++] ?? ''); }
  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
};

/** SMS (DLT-registered templates through the organization's gateway) and email (the organization's SMTP) to leads. */
@Injectable()
export class MessagingService {
  constructor(private db: DbService, private mailer: Mailer) {}

  /** Sends one template to one lead; refuses opted-out customers; records the message and the lead's journey. */
  async send(tenantId: string, leadId: string, templateId: string, userId: string, broadcastId?: string) {
    const prep = await this.db.tenant(async (tx) => {
      const t = await tx.messageTemplate.findFirst({ where: { id: templateId, isArchived: false, channel: { in: ['sms', 'email'] } } });
      if (!t) throw new BadRequestException({ code: 'TEMPLATE_NOT_FOUND', message: 'Choose an active template' });
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, include: { customer: true } });
      const c = lead.customer;
      const address = t.channel === 'sms' ? c.mobile?.replace(/\D/g, '') : c.email?.toLowerCase();
      if (!address) throw new BadRequestException({ code: 'NO_ADDRESS', message: `${c.name} has no ${t.channel === 'sms' ? 'mobile number' : 'email address'}` });
      if (t.channel === 'sms' ? c.smsOptOut : c.emailOptOut) throw new BadRequestException({ code: 'OPTED_OUT', message: `${c.name} opted out of ${t.channel === 'sms' ? 'SMS' : 'email'}` });
      let cfg: IntegrationConfig | null = null;
      if (t.channel === 'sms') {
        const conn = await tx.integrationConnection.findFirst({ where: { key: 'sms_dlt', workspaceId: null, status: 'active' } });
        if (!conn) throw new BadRequestException({ code: 'SMS_OFF', message: 'SMS is not connected (Integrations → SMS (DLT))' });
        cfg = readConfig(conn.configEncrypted);
      }
      const owner = lead.ownerId ? await tx.user.findUnique({ where: { id: lead.ownerId }, select: { name: true } }) : null;
      const params = fillVariables(t.variables, lead, owner?.name ?? null);
      const conv = await tx.conversation.upsert({
        where: { tenantId_channel_waId: { tenantId, channel: t.channel, waId: address } },
        create: { tenantId, channel: t.channel, waId: address, leadId: lead.id, customerId: lead.customerId, workspaceId: lead.workspaceId, assigneeId: lead.ownerId },
        update: { leadId: lead.id, customerId: lead.customerId, workspaceId: lead.workspaceId },
      });
      const body = fill(t.channel, t.body, params);
      const msg = await tx.message.create({ data: { tenantId, conversationId: conv.id, direction: 'out', type: t.channel, body, templateName: t.name, status: 'queued', userId, broadcastId: broadcastId ?? null } });
      return { t, lead, cfg, params, body, address, conv, msg, customerName: c.name };
    });
    try {
      const providerId = prep.t.channel === 'sms'
        ? await this.sms(prep.cfg!, prep.t, prep.address, prep.body, prep.params)
        : await this.email(tenantId, prep.lead.customerId, prep.address, fill('email', prep.t.subject ?? '', prep.params), prep.body);
      return await this.db.tenant(async (tx) => {
        await tx.conversation.update({ where: { id: prep.conv.id }, data: { lastMessageAt: new Date() } });
        await tx.leadActivity.create({ data: activity(prep.lead, userId, { type: 'message', remark: `${prep.t.channel === 'sms' ? 'SMS' : 'Email'} sent: ${prep.t.name}`, data: { messageId: prep.msg.id, channel: prep.t.channel } }) });
        return tx.message.update({ where: { id: prep.msg.id }, data: { status: 'sent', waMessageId: providerId } });
      });
    } catch (e) {
      await this.db.tenant((tx) => tx.message.update({ where: { id: prep.msg.id }, data: { status: 'failed', error: (e instanceof Error ? e.message : 'Failed').slice(0, 300) } }));
      throw e;
    }
  }

  private async email(tenantId: string, customerId: string, to: string, subject: string, body: string) {
    const link = `${API()}/public/unsubscribe/${await this.slug(tenantId)}/${unsubscribeToken(tenantId, customerId)}`;
    await this.mailer.send(to, subject, `${body}\n\n—\nTo stop these emails: ${link}`).catch((e) => { throw new HttpException({ code: 'EMAIL_FAILED', message: `The email could not be sent: ${e instanceof Error ? e.message : e}` }, 502); });
    return `email-${randomUUID()}`;
  }

  private async slug(tenantId: string) { return (await this.db.platform.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } })).slug; }

  /** MSG91 flow API, or any gateway through a URL pattern ({to} {text} {sender} {dlt} {entity} {key}). */
  private async sms(cfg: IntegrationConfig, t: { dltTemplateId: string | null; providerTemplateId: string | null }, to: string, text: string, params: string[]) {
    const v = cfg.values;
    const refuse = (why: string) => new HttpException({ code: 'SMS_REFUSED', message: `The SMS gateway refused the message: ${why}` }, 502);
    const down = (e: unknown) => new HttpException({ code: 'SMS_UNREACHABLE', message: `The SMS gateway could not be reached: ${e instanceof Error ? e.message : e}` }, 502);
    if (v.provider === 'MSG91') {
      if (!t.providerTemplateId) throw new BadRequestException({ code: 'PROVIDER_TEMPLATE_REQUIRED', message: 'This template needs its MSG91 template ID' });
      const url = `${(v.apiBase || 'https://control.msg91.com/api/v5').replace(/\/$/, '')}/flow`;
      await assertPublicUrl(url);
      const recipient = { mobiles: to, ...Object.fromEntries(params.map((p, i) => [`var${i + 1}`, p])) };
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { authkey: v.apiKey ?? '', 'Content-Type': 'application/json' }, body: JSON.stringify({ template_id: t.providerTemplateId, short_url: 0, recipients: [recipient] }) }).catch((e) => { throw down(e); });
      const b = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
      if (!res.ok || b.type === 'error') throw refuse(b.message ?? `HTTP ${res.status}`);
      return b.message ?? `sms-${randomUUID()}`;
    }
    if (!v.gatewayUrl) throw new BadRequestException({ code: 'GATEWAY_REQUIRED', message: 'Add the Gateway URL in Integrations → SMS (DLT)' });
    const values: Record<string, string> = { to, text, sender: v.senderId ?? '', dlt: t.dltTemplateId ?? '', entity: v.entityId ?? '', key: v.apiKey ?? '' };
    const url = v.gatewayUrl.replace(/\{(to|text|sender|dlt|entity|key)\}/g, (_, k) => encodeURIComponent(values[k]));
    await assertPublicUrl(url);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((e) => { throw down(e); });
    const raw = await res.text();
    if (!res.ok) throw refuse(raw.slice(0, 160) || `HTTP ${res.status}`);
    let id: unknown;
    try { const j = JSON.parse(raw); if (j.status === 'error' || j.type === 'error') throw refuse(String(j.message ?? 'error')); id = j.id ?? j.message_id ?? j.messageId ?? j.request_id ?? j.batch_id; } catch (e) { if (e instanceof HttpException) throw e; }
    return id ? String(id) : `sms-${randomUUID()}`;
  }

  /** Delivery reports from the SMS gateway: moves sent → delivered, or records the failure. Field names vary per gateway. */
  async deliveryReport(tenantId: string, records: Record<string, unknown>[]) {
    let updated = 0;
    for (const r of records) {
      const id = ['requestId', 'request_id', 'message_id', 'messageId', 'id'].map((k) => r[k]).find((x) => x !== undefined && x !== null && x !== '');
      const report = Array.isArray(r.report) ? (r.report[0] as Record<string, unknown>) : r;
      const raw = String(report.status ?? report.state ?? r.status ?? '').toLowerCase();
      const status = /^(1|deliv|success)/.test(raw) ? 'delivered' : /^(2|9|16|25|fail|undeliv|reject|ndnc|expired)/.test(raw) ? 'failed' : null;
      if (!id || !status) continue;
      const conv = await this.db.tenant(async (tx) => {
        const m = await tx.message.findFirst({ where: { waMessageId: String(id), type: 'sms' } });
        if (!m || (status !== 'failed' && STATUS_ORDER.indexOf(status) <= STATUS_ORDER.indexOf(m.status))) return null;
        await tx.message.update({ where: { id: m.id }, data: { status, ...(status === 'failed' ? { error: String(report.desc ?? report.description ?? report.reason ?? 'Not delivered').slice(0, 200) } : {}) } });
        return m.conversationId;
      });
      if (conv) { updated++; live.publish(tenantId, { type: 'message.updated', conversationId: conv }); }
    }
    return { updated };
  }
}
