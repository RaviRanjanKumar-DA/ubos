import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/db.service';
import { activity } from '../../common/lead-ops';
import { queueRescore } from '../../common/lead-rules';
import { live } from '../../common/live';
import { notify } from '../../common/notify';
import { MessagingService } from '../messaging/messaging.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

export interface FlowStep { id: string; type: 'message' | 'buttons' | 'question' | 'handoff'; text: string; next?: string; saveTo?: string; options?: { label: string; next?: string }[] }
interface Conv { id: string; tenantId: string; channel: string; waId: string; workspaceId: string | null; leadId: string | null; customerId: string | null; assigneeId: string | null }

const STOP_WORDS = /^\s*(stop|unsubscribe|stop all|cancel|start|unstop|subscribe)\s*$/i;
const HUMAN_QUIET_MS = 30 * 60_000;
const SESSION_MS = 24 * 3_600_000;
const MAX_CHAIN = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Runs button and question flows on WhatsApp and website chat, and sends scheduled messages. A person replying always takes over. */
@Injectable()
export class ChatbotService {
  private readonly log = new Logger('Chatbot');
  constructor(private db: DbService, private wa: WhatsAppService, private messaging: MessagingService) {
    wa.onCustomerMessage = (conv, text) => this.onMessage(conv, text).catch((e) => this.log.error(e instanceof Error ? e.message : e));
  }

  private async send(conv: Conv, text: string, options: string[]) {
    if (conv.channel === 'whatsapp') return this.wa.sendBot(conv.tenantId, conv.id, conv.waId, text, options);
    await this.db.tenant((tx) => tx.message.create({ data: { tenantId: conv.tenantId, conversationId: conv.id, direction: 'out', type: 'text', body: text, options, status: 'sent' } }));
    live.publish(conv.tenantId, { type: 'message.updated', conversationId: conv.id });
  }

  /** Called after a customer's message is stored. */
  async onMessage(conv: Conv, text: string) {
    if (!text.trim() || !conv.workspaceId || STOP_WORDS.test(text)) return;
    const state = await this.db.tenant(async (tx) => {
      const human = await tx.message.findFirst({ where: { conversationId: conv.id, direction: 'out', userId: { not: null }, createdAt: { gte: new Date(Date.now() - HUMAN_QUIET_MS) } }, select: { id: true } });
      const session = await tx.chatSession.findFirst({ where: { conversationId: conv.id, status: 'active' } });
      if (human) { if (session) await tx.chatSession.update({ where: { id: session.id }, data: { status: 'handoff' } }); return null; }
      if (session && Date.now() - session.updatedAt.getTime() > SESSION_MS) { await tx.chatSession.update({ where: { id: session.id }, data: { status: 'done' } }); return { session: null }; }
      return { session };
    });
    if (!state) return;
    if (state.session) return this.answer(conv, state.session, text);
    const flow = await this.db.tenant(async (tx) => {
      const flows = await tx.chatFlow.findMany({ where: { workspaceId: conv.workspaceId!, channel: conv.channel, isActive: true, isArchived: false }, orderBy: { createdAt: 'asc' } });
      const said = text.trim().toLowerCase();
      const keyword = flows.find((f) => f.trigger === 'keyword' && f.keywords.some((k) => said === k.toLowerCase() || said.split(/\s+/).includes(k.toLowerCase())));
      if (keyword) return keyword;
      const inbound = await tx.message.count({ where: { conversationId: conv.id, direction: 'in' } });
      return inbound === 1 ? flows.find((f) => f.trigger === 'first_message') ?? null : null;
    });
    if (!flow) return;
    const steps = flow.steps as unknown as FlowStep[];
    const session = await this.db.tenant(async (tx) => {
      await tx.chatFlow.update({ where: { id: flow.id }, data: { runs: { increment: 1 } } });
      return tx.chatSession.create({ data: { tenantId: conv.tenantId, conversationId: conv.id, flowId: flow.id, stepId: steps[0].id } });
    }).catch(() => null); // two messages at once: the other one started it
    if (session) await this.run(conv, session.id, steps, steps[0].id);
  }

  private optionLabels = (s: FlowStep) => (s.type === 'buttons' ? (s.options ?? []).map((o) => o.label) : []);

  /** Sends steps until one needs an answer or the flow ends. */
  private async run(conv: Conv, sessionId: string, steps: FlowStep[], startId: string | undefined) {
    let id = startId;
    for (let i = 0; i < MAX_CHAIN && id; i++) {
      const step = steps.find((s) => s.id === id);
      if (!step) break;
      await this.send(conv, step.text, this.optionLabels(step));
      if (step.type === 'handoff') return this.handoff(conv, sessionId);
      if (step.type !== 'message') { await this.db.tenant((tx) => tx.chatSession.update({ where: { id: sessionId }, data: { stepId: step.id, retries: 0 } })); return; }
      id = step.next;
    }
    await this.db.tenant((tx) => tx.chatSession.update({ where: { id: sessionId }, data: { status: 'done' } }));
  }

  private async handoff(conv: Conv, sessionId: string) {
    await this.db.tenant(async (tx) => {
      await tx.chatSession.update({ where: { id: sessionId }, data: { status: 'handoff' } });
      const owner = conv.assigneeId ?? (conv.leadId ? (await tx.lead.findUnique({ where: { id: conv.leadId }, select: { ownerId: true } }))?.ownerId : null);
      if (owner) await notify(tx, [owner], { type: 'mention', title: 'A customer is waiting in chat', body: 'The chatbot handed this chat to you.', link: `/app/inbox?c=${conv.id}` });
      if (conv.leadId) { const l = await tx.lead.findUnique({ where: { id: conv.leadId } }); if (l) await tx.leadActivity.create({ data: activity(l, null, { type: 'remark', remark: 'The chatbot handed the chat to a person', data: { conversationId: conv.id } }) }); }
    });
  }

  private async answer(conv: Conv, session: { id: string; flowId: string; stepId: string; retries: number }, text: string) {
    const flow = await this.db.tenant((tx) => tx.chatFlow.findUnique({ where: { id: session.flowId } }));
    const steps = (flow?.steps ?? []) as unknown as FlowStep[];
    const step = steps.find((s) => s.id === session.stepId);
    if (!flow || !step) return void (await this.db.tenant((tx) => tx.chatSession.update({ where: { id: session.id }, data: { status: 'done' } })));
    const said = text.trim();
    let value: string | null = said;
    let next = step.next;
    if (step.type === 'buttons') {
      const options = step.options ?? [];
      const chosen = options.find((o) => o.label.toLowerCase() === said.toLowerCase()) ?? (/^\d$/.test(said) ? options[Number(said) - 1] : undefined);
      value = chosen?.label ?? null;
      next = chosen?.next ?? step.next;
    } else if (step.saveTo === 'email' && !EMAIL.test(said)) value = null;
    if (value === null) {
      if (session.retries >= 1) { await this.send(conv, 'Let me connect you with a person who can help.', []); return this.handoff(conv, session.id); }
      await this.db.tenant((tx) => tx.chatSession.update({ where: { id: session.id }, data: { retries: { increment: 1 } } }));
      return this.send(conv, step.type === 'buttons' ? `Please choose one of the options.\n\n${step.text}` : `Sorry, I did not get that.\n\n${step.text}`, this.optionLabels(step));
    }
    if (step.saveTo) await this.save(conv, step.saveTo, value);
    await this.run(conv, session.id, steps, next);
  }

  private async save(conv: Conv, target: string, value: string) {
    if (!conv.leadId) return;
    await this.db.tenant(async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: conv.leadId! }, include: { customer: true } });
      if (!lead) return;
      if (target === 'city') await tx.customer.update({ where: { id: lead.customerId }, data: { city: value.slice(0, 80) } });
      else if (target === 'email') { if (!lead.customer.email) await tx.customer.update({ where: { id: lead.customerId }, data: { email: value.toLowerCase().slice(0, 160) } }); }
      else if (target.startsWith('cf:')) {
        const key = target.slice(3);
        const def = await tx.leadField.findFirst({ where: { workspaceId: lead.workspaceId, key, isArchived: false } });
        if (def) await tx.lead.update({ where: { id: lead.id }, data: { customFields: { ...(lead.customFields as object), [key]: value.slice(0, 500) } } });
      }
      await tx.leadActivity.create({ data: activity(lead, null, { type: 'remark', remark: `Chatbot: ${value.slice(0, 500)}`, data: { conversationId: conv.id, saveTo: target } }) });
      await queueRescore(tx, lead);
    });
  }

  /** Every minute for each organization. A message is claimed first, so it can never go out twice. */
  async sendDue(tenantId: string) {
    const due = await this.db.tenant((tx) => tx.scheduledMessage.findMany({ where: { status: 'pending', sendAt: { lte: new Date() } }, orderBy: { sendAt: 'asc' }, take: 100 }));
    let sent = 0;
    for (const m of due) {
      const claimed = await this.db.tenant((tx) => tx.scheduledMessage.updateMany({ where: { id: m.id, status: 'pending' }, data: { status: 'sending' } }));
      if (!claimed.count) continue;
      try {
        const t = await this.db.tenant((tx) => tx.messageTemplate.findUniqueOrThrow({ where: { id: m.templateId } }));
        if (t.isArchived) throw new Error('The template was archived');
        if (t.channel === 'whatsapp') await this.wa.sendTemplate(tenantId, m.leadId, t.id, m.createdById);
        else await this.messaging.send(tenantId, m.leadId, t.id, m.createdById);
        await this.db.tenant((tx) => tx.scheduledMessage.update({ where: { id: m.id }, data: { status: 'sent', sentAt: new Date() } }));
        sent++;
      } catch (e) {
        const error = (e instanceof Error ? e.message : 'Failed').slice(0, 300);
        await this.db.tenant(async (tx) => {
          await tx.scheduledMessage.update({ where: { id: m.id }, data: { status: 'failed', error } });
          await notify(tx, [m.createdById], { type: 'reminder', title: 'A scheduled message was not sent', body: error, link: `/app/leads/${m.leadId}?tab=outreach` });
        });
      }
    }
    return sent;
  }
}
