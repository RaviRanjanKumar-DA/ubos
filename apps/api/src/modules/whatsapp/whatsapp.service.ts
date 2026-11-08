import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { normalizeMobile } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { activity } from '../../common/lead-ops';
import { intakeLead } from '../../common/lead-intake';
import { live } from '../../common/live';
import { assertPublicUrl, readConfig, type IntegrationConfig } from '../integration-runtime';
import { fillVariables } from '../messaging/messaging.service';
import { emitEvent } from '../../common/events';

const WINDOW_MS = 24 * 3_600_000;
const STATUS_ORDER = ['queued', 'sent', 'delivered', 'read'];
const STOP = /^\s*(stop|unsubscribe|stop all|cancel)\s*$/i;
const START = /^\s*(start|unstop|subscribe)\s*$/i;

export const toWaId = (mobile: string) => mobile.replace(/[^\d]/g, '');
export const windowOpen = (lastInboundAt: Date | null) => !!lastInboundAt && Date.now() - lastInboundAt.getTime() < WINDOW_MS;

interface WaMessage { from: string; id: string; timestamp?: string; type: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }; image?: { caption?: string }; document?: { filename?: string } }
interface WaStatus { id: string; status: string; errors?: { title?: string; message?: string }[] }

/** WhatsApp Cloud API: incoming messages and delivery statuses, replies, templates, broadcasts, opt-out. */
@Injectable()
export class WhatsAppService {
  constructor(private db: DbService) {}

  async config(tx: Tx): Promise<IntegrationConfig | null> {
    const conn = await tx.integrationConnection.findFirst({ where: { key: 'whatsapp', workspaceId: null, status: 'active' } });
    return conn ? readConfig(conn.configEncrypted) : null;
  }

  /** Meta signs every webhook with the app secret (X-Hub-Signature-256); checked when the secret is set. */
  verifySignature(cfg: IntegrationConfig, raw: Buffer | undefined, header: string | undefined) {
    if (!cfg.values.appSecret) return true;
    if (!raw || !header?.startsWith('sha256=')) return false;
    const want = Buffer.from(`sha256=${createHmac('sha256', cfg.values.appSecret).update(raw).digest('hex')}`);
    const got = Buffer.from(header);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** One webhook body: new messages become conversations (and leads for new numbers), statuses update sent messages. */
  async receive(tenantId: string, cfg: IntegrationConfig, body: unknown) {
    const changes = ((body as { entry?: { changes?: { value?: { contacts?: { wa_id: string; profile?: { name?: string } }[]; messages?: WaMessage[]; statuses?: WaStatus[] } }[] }[] })?.entry ?? []).flatMap((e) => e.changes ?? []);
    const out = { messages: 0, duplicates: 0, statuses: 0 };
    for (const ch of changes) {
      const v = ch.value ?? {};
      for (const m of v.messages ?? []) {
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        (await this.inbound(tenantId, cfg, m, name)) ? out.messages++ : out.duplicates++;
      }
      for (const s of v.statuses ?? []) { await this.status(tenantId, s); out.statuses++; }
    }
    return out;
  }

  private async inbound(tenantId: string, cfg: IntegrationConfig, m: WaMessage, profileName: string | null) {
    const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.image?.caption ?? m.document?.filename ?? null;
    const type = ['text', 'button', 'interactive'].includes(m.type) ? 'text' : ['image', 'document', 'audio'].includes(m.type) ? m.type : 'other';
    const at = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
    const r = await this.db.tenant(async (tx) => {
      if (await tx.message.findFirst({ where: { waMessageId: m.id } })) return null; // Meta retries: stored once
      const waId = toWaId(m.from);
      const mobile = normalizeMobile(`+${waId}`) ?? `+${waId}`;
      let conv = await tx.conversation.findUnique({ where: { tenantId_channel_waId: { tenantId, channel: 'whatsapp', waId } } });
      if (!conv || !conv.leadId) {
        // A new chat: the customer's open lead (or a new one in the chosen business line) is linked once.
        let leadId: string | null = null, customerId: string | null = null, workspaceId: string | null = null;
        const ws = cfg.values.businessLine;
        if (ws) {
          const res = await intakeLead(tx, tenantId, ws, { name: profileName ?? `WhatsApp ${mobile}`, mobile, source: 'whatsapp', remark: text ? `WhatsApp: ${text}` : 'Started a WhatsApp chat' }, 'skip', 'WhatsApp');
          leadId = res.leadId; customerId = res.customerId; workspaceId = ws;
        }
        const lead = leadId ? await tx.lead.findUnique({ where: { id: leadId } }) : null;
        conv = conv
          ? await tx.conversation.update({ where: { id: conv.id }, data: { leadId, customerId, workspaceId, assigneeId: conv.assigneeId ?? lead?.ownerId ?? null } })
          : await tx.conversation.create({ data: { tenantId, waId, leadId, customerId, workspaceId, assigneeId: lead?.ownerId ?? null } });
      }
      const msg = await tx.message.create({ data: { tenantId, conversationId: conv.id, direction: 'in', type, body: text, waMessageId: m.id, status: 'received', createdAt: at } });
      // A late retry of an old message must not restart the 24-hour window.
      const newer = !conv.lastInboundAt || at > conv.lastInboundAt;
      await tx.conversation.update({ where: { id: conv.id }, data: { ...(newer ? { lastInboundAt: at } : {}), ...(at > conv.lastMessageAt ? { lastMessageAt: at } : {}), unread: { increment: 1 }, status: 'open' } });
      if (conv.leadId) await tx.lead.update({ where: { id: conv.leadId }, data: { lastActivityAt: at } });
      // A reply ends sequences that stop on reply.
      if (conv.leadId) {
        await tx.sequenceEnrollment.updateMany({ where: { leadId: conv.leadId, status: 'active', sequence: { stopOnReply: true } }, data: { status: 'stopped', stopReason: 'customer replied' } });
        await emitEvent(tx, tenantId, conv.workspaceId, 'whatsapp.received', { leadId: conv.leadId, customerId: conv.customerId, conversationId: conv.id, text });
      }
      // Opt-out / opt-in words (also required by WhatsApp's business policy).
      if (text && conv.customerId && (STOP.test(text) || START.test(text))) {
        const optOut = STOP.test(text);
        await tx.customer.update({ where: { id: conv.customerId }, data: { whatsappOptOut: optOut } });
        const lead = conv.leadId ? await tx.lead.findUnique({ where: { id: conv.leadId } }) : null;
        if (lead) await tx.leadActivity.create({ data: activity(lead, null, { type: 'remark', remark: optOut ? 'Opted out of WhatsApp messages (replied STOP)' : 'Opted back in to WhatsApp messages', data: { via: 'whatsapp' } }) });
      }
      return { conv, msg };
    });
    if (!r) return false;
    live.publish(tenantId, { type: 'message.received', conversationId: r.conv.id, leadId: r.conv.leadId, userId: r.conv.assigneeId });
    return true;
  }

  private async status(tenantId: string, s: WaStatus) {
    const conv = await this.db.tenant(async (tx) => {
      const msg = await tx.message.findFirst({ where: { waMessageId: s.id } });
      if (!msg) return null;
      const failed = s.status === 'failed';
      // Statuses can arrive out of order: only move forward (sent → delivered → read), failure always wins.
      if (!failed && STATUS_ORDER.indexOf(s.status) <= STATUS_ORDER.indexOf(msg.status)) return null;
      await tx.message.update({ where: { id: msg.id }, data: { status: s.status, ...(failed ? { error: s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? 'Failed' } : {}) } });
      return msg.conversationId;
    });
    if (conv) live.publish(tenantId, { type: 'message.updated', conversationId: conv });
  }

  /** Calls the Graph API; returns WhatsApp's message id. */
  private async graph(cfg: IntegrationConfig, payload: Record<string, unknown>) {
    const base = (cfg.values.apiBase || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
    const url = `${base}/${encodeURIComponent(cfg.values.phoneNumberId ?? '')}/messages`;
    await assertPublicUrl(url);
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${cfg.values.accessToken ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }) })
      .catch((e) => { throw new HttpException({ code: 'WHATSAPP_UNREACHABLE', message: `WhatsApp could not be reached: ${e instanceof Error ? e.message : e}` }, 502); });
    const b = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok || !b.messages?.[0]?.id) throw new HttpException({ code: 'WHATSAPP_REFUSED', message: `WhatsApp refused the message: ${b.error?.message ?? `HTTP ${res.status}`}` }, 502);
    return b.messages[0].id;
  }

  /** A free-text reply: only inside the 24-hour window after the customer's last message (WhatsApp rule). */
  async sendText(tenantId: string, conversationId: string, userId: string, text: string) {
    const { cfg, conv } = await this.db.tenant(async (tx) => ({ cfg: await this.config(tx), conv: await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } }) }));
    if (!cfg) throw new BadRequestException({ code: 'WHATSAPP_OFF', message: 'WhatsApp is not connected (Integrations → WhatsApp Cloud API)' });
    if (!windowOpen(conv.lastInboundAt)) throw new BadRequestException({ code: 'WINDOW_CLOSED', message: 'More than 24 hours since the customer’s last message — send an approved template instead' });
    return this.deliver(tenantId, conv.id, conv.waId, userId, { type: 'text', body: text }, () => this.graph(cfg, { to: conv.waId, type: 'text', text: { body: text, preview_url: true } }));
  }

  /** An approved template with {{n}} placeholders filled from the lead; refused for customers who opted out. */
  async sendTemplate(tenantId: string, leadId: string, templateId: string, userId: string, broadcastId?: string) {
    const prep = await this.db.tenant(async (tx) => {
      const cfg = await this.config(tx);
      if (!cfg) throw new BadRequestException({ code: 'WHATSAPP_OFF', message: 'WhatsApp is not connected (Integrations → WhatsApp Cloud API)' });
      const t = await tx.messageTemplate.findFirst({ where: { id: templateId, isArchived: false } });
      if (!t) throw new BadRequestException({ code: 'TEMPLATE_NOT_FOUND', message: 'Choose an active template' });
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, include: { customer: true } });
      if (!lead.customer.mobile) throw new BadRequestException({ code: 'NO_NUMBER', message: 'This lead has no mobile number' });
      if (lead.customer.whatsappOptOut) throw new BadRequestException({ code: 'OPTED_OUT', message: `${lead.customer.name} opted out of WhatsApp messages` });
      const owner = lead.ownerId ? await tx.user.findUnique({ where: { id: lead.ownerId }, select: { name: true } }) : null;
      const params = fillVariables(t.variables, lead, owner?.name ?? null);
      const body = t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
      const waId = toWaId(lead.customer.mobile);
      let conv = await tx.conversation.findUnique({ where: { tenantId_channel_waId: { tenantId, channel: 'whatsapp', waId } } });
      if (!conv) conv = await tx.conversation.create({ data: { tenantId, waId, leadId: lead.id, customerId: lead.customerId, workspaceId: lead.workspaceId, assigneeId: lead.ownerId } });
      else if (!conv.leadId) conv = await tx.conversation.update({ where: { id: conv.id }, data: { leadId: lead.id, customerId: lead.customerId, workspaceId: lead.workspaceId } });
      return { cfg, t, params, body, conv };
    });
    const payload = { to: prep.conv.waId, type: 'template', template: { name: prep.t.name, language: { code: prep.t.language }, ...(prep.params.length ? { components: [{ type: 'body', parameters: prep.params.map((text) => ({ type: 'text', text })) }] } : {}) } };
    return this.deliver(tenantId, prep.conv.id, prep.conv.waId, userId, { type: 'template', body: prep.body, templateName: prep.t.name, broadcastId }, () => this.graph(prep.cfg, payload));
  }

  /** Stores the message as queued, sends it, then records sent (with WhatsApp's id) or failed (with the reason). */
  private async deliver(tenantId: string, conversationId: string, _waId: string, userId: string, m: { type: string; body: string; templateName?: string; broadcastId?: string }, send: () => Promise<string>) {
    const msg = await this.db.tenant((tx) => tx.message.create({ data: { tenantId, conversationId, direction: 'out', type: m.type, body: m.body, templateName: m.templateName ?? null, status: 'queued', userId, broadcastId: m.broadcastId ?? null } }));
    try {
      const waMessageId = await send();
      const done = await this.db.tenant(async (tx) => {
        await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), unread: 0 } });
        return tx.message.update({ where: { id: msg.id }, data: { status: 'sent', waMessageId } });
      });
      live.publish(tenantId, { type: 'message.updated', conversationId });
      return done;
    } catch (e) {
      await this.db.tenant((tx) => tx.message.update({ where: { id: msg.id }, data: { status: 'failed', error: e instanceof Error ? e.message.slice(0, 300) : 'Failed' } }));
      throw e;
    }
  }
}
