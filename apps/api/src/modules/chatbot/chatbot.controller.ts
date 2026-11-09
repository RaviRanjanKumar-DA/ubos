import { BadRequestException, Body, Controller, Get, Header, Headers, HttpCode, Ip, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { authFeatureCheck } from './feature';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { live } from '../../common/live';
import { notify } from '../../common/notify';
import { scopeFilter } from '../../common/scope';
import { randomToken, sha256 } from '../../auth/crypto';
import { asTenant, IntakeService, rateLimit } from '../integration-runtime';
import { webBase } from '../connected/providers';
import { ChatbotService, type FlowStep } from './chatbot.service';

const KEY = 'crm.chatbot.manage';
const StepId = z.string().regex(/^[a-z0-9_-]{1,30}$/);
const Step = z.object({
  id: StepId, type: z.enum(['message', 'buttons', 'question', 'handoff']), text: z.string().trim().min(1).max(1024), next: StepId.optional(), saveTo: z.string().regex(/^(city|email|remark|cf:[a-z][a-z0-9_]*)$/).optional(),
  options: z.array(z.object({ label: z.string().trim().min(1).max(20), next: StepId.optional() })).max(3).optional(),
});
const checkSteps = (steps: FlowStep[], ctx: z.RefinementCtx) => {
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) ctx.addIssue({ code: 'custom', message: 'Each step needs its own id' });
  for (const s of steps) {
    if (s.type === 'buttons' && !s.options?.length) ctx.addIssue({ code: 'custom', message: `Add options to the step “${s.text.slice(0, 30)}”` });
    for (const n of [s.next, ...(s.options ?? []).map((o) => o.next)]) if (n && !ids.has(n)) ctx.addIssue({ code: 'custom', message: 'A step points to a step that does not exist' });
  }
};
const FlowFields = { name: z.string().trim().min(2).max(80), channel: z.enum(['whatsapp', 'webchat']).default('whatsapp'), trigger: z.enum(['first_message', 'keyword']).default('first_message'), keywords: z.array(z.string().trim().min(1).max(40)).max(20).default([]), steps: z.array(Step).min(1).max(30) };
const NewFlow = z.object(FlowFields).superRefine((f, ctx) => { checkSteps(f.steps as FlowStep[], ctx); if (f.trigger === 'keyword' && !f.keywords.length) ctx.addIssue({ code: 'custom', message: 'Add at least one keyword' }); });
const EditFlow = z.object(FlowFields).partial().extend({ isActive: z.boolean().optional(), isArchived: z.boolean().optional() }).superRefine((f, ctx) => { if (f.steps) checkSteps(f.steps as FlowStep[], ctx); });
const WidgetBody = z.object({ name: z.string().trim().min(2).max(80), greeting: z.string().trim().min(1).max(300), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4a2bc2') });
const Start = z.object({ name: z.string().trim().min(2).max(120), mobile: z.string().trim().min(6).max(30), email: z.string().trim().email().max(160).optional().or(z.literal('')), message: z.string().trim().max(2000).optional().or(z.literal('')), _hp: z.string().optional() });
const Say = z.object({ text: z.string().trim().min(1).max(2000) });
const Later = z.object({ templateId: z.string().uuid(), sendAt: z.coerce.date() });

@Controller('api/v1')
@RequireFeature('module.whatsapp')
export class ChatbotController {
  constructor(private db: DbService) {}

  private ws() {
    const w = auth().workspaceId;
    if (!w) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return w;
  }

  @Get('chat-flows')
  @RequirePermission(KEY)
  flows() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const fields = await tx.leadField.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { position: 'asc' }, select: { key: true, label: true } });
      return { fields, flows: await tx.chatFlow.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { createdAt: 'asc' } }) };
    });
  }

  @Post('chat-flows')
  @RequirePermission(KEY)
  addFlow(@Body() body: unknown) {
    const input = parse(NewFlow, body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const f = await tx.chatFlow.create({ data: { ...input, tenantId: tenantId(), workspaceId: ws, createdById: auth().userId } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'chat_flow', entityId: f.id, action: 'chat_flow.created', newValue: { name: f.name, channel: f.channel } });
      return f;
    });
  }

  @Patch('chat-flows/:id')
  @RequirePermission(KEY)
  editFlow(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(EditFlow, body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      if (!(await tx.chatFlow.findFirst({ where: { id, workspaceId: ws, isArchived: false } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Flow not found' });
      const f = await tx.chatFlow.update({ where: { id }, data: input });
      await this.db.audit(tx, { workspaceId: ws, entity: 'chat_flow', entityId: id, action: input.isArchived ? 'chat_flow.archived' : 'chat_flow.updated', newValue: { name: f.name, isActive: f.isActive } });
      return f;
    });
  }

  @Get('chat-widgets')
  @RequirePermission(KEY)
  widgets() {
    const ws = this.ws();
    return this.db.tenant((tx) => tx.chatWidget.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { createdAt: 'asc' } }));
  }

  @Post('chat-widgets')
  @RequirePermission(KEY)
  addWidget(@Body() body: unknown) {
    const input = parse(WidgetBody, body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const w = await tx.chatWidget.create({ data: { ...input, tenantId: tenantId(), workspaceId: ws, publicKey: randomToken(12), createdById: auth().userId } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'chat_widget', entityId: w.id, action: 'chat_widget.created', newValue: { name: w.name } });
      return w;
    });
  }

  @Patch('chat-widgets/:id')
  @RequirePermission(KEY)
  editWidget(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(WidgetBody.partial().extend({ isActive: z.boolean().optional(), isArchived: z.boolean().optional() }), body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      if (!(await tx.chatWidget.findFirst({ where: { id, workspaceId: ws, isArchived: false } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Widget not found' });
      return tx.chatWidget.update({ where: { id }, data: input });
    });
  }
}

/** Sending a template later. Available with any plan that can message leads. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class ScheduledMessagesController {
  constructor(private db: DbService) {}

  private async lead(tx: Tx, id: string) {
    const l = await tx.lead.findFirst({ where: { AND: [{ id }, await scopeFilter(tx, 'crm.message.send')] } });
    if (!l) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return l;
  }

  @Get('leads/:id/scheduled')
  @RequirePermission('crm.message.send')
  list(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await this.lead(tx, id);
      const rows = await tx.scheduledMessage.findMany({ where: { leadId: id }, orderBy: { sendAt: 'desc' }, take: 50 });
      const names = new Map((await tx.messageTemplate.findMany({ where: { id: { in: rows.map((r) => r.templateId) } }, select: { id: true, name: true, channel: true } })).map((t) => [t.id, t]));
      return rows.map((r) => ({ id: r.id, sendAt: r.sendAt, status: r.status, error: r.error, template: names.get(r.templateId)?.name ?? '', channel: names.get(r.templateId)?.channel ?? '' }));
    });
  }

  @Post('leads/:id/scheduled')
  @RequirePermission('crm.message.send')
  add(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Later, body);
    if (input.sendAt.getTime() < Date.now() + 60_000) throw new BadRequestException({ code: 'TOO_SOON', message: 'Choose a time at least a minute from now' });
    if (input.sendAt.getTime() > Date.now() + 180 * 86_400_000) throw new BadRequestException({ code: 'TOO_FAR', message: 'Choose a time within the next 6 months' });
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, id);
      const t = await tx.messageTemplate.findFirst({ where: { id: input.templateId, isArchived: false } });
      if (!t) throw new BadRequestException({ code: 'TEMPLATE_NOT_FOUND', message: 'Choose an active template' });
      if (t.channel === 'whatsapp' && !auth().permissions['crm.whatsapp.chat']) throw new BadRequestException({ code: 'NOT_ALLOWED', message: 'You cannot send WhatsApp messages' });
      return tx.scheduledMessage.create({ data: { tenantId: tenantId(), workspaceId: lead.workspaceId, leadId: id, templateId: t.id, sendAt: input.sendAt, createdById: auth().userId } });
    });
  }

  @Post('scheduled-messages/:id/cancel')
  @HttpCode(200)
  @RequirePermission('crm.message.send')
  cancel(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const m = await tx.scheduledMessage.findUnique({ where: { id } });
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
      await this.lead(tx, m.leadId);
      const done = await tx.scheduledMessage.updateMany({ where: { id, status: 'pending' }, data: { status: 'cancelled' } });
      if (!done.count) throw new BadRequestException({ code: 'ALREADY_SENT', message: 'This message has already been sent' });
      return { ok: true };
    });
  }
}

/** The website chat a visitor uses. No sign-in: each chat has its own secret token, kept only in the visitor's browser. */
@Controller('public/chat')
export class PublicChatController {
  constructor(private db: DbService, private intake: IntakeService, private bot: ChatbotService) {}

  private async widget(tx: Tx, key: string) {
    const w = await tx.chatWidget.findFirst({ where: { publicKey: key, isActive: true, isArchived: false } });
    if (!w) throw new NotFoundException({ code: 'NOT_FOUND', message: 'This chat is not available' });
    return w;
  }
  private async mine(tx: Tx, token: string | undefined) {
    const conv = token ? await tx.conversation.findFirst({ where: { channel: 'webchat', waId: sha256(token) } }) : null;
    if (!conv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'This chat was not found' });
    return conv;
  }

  /** The small script a business pastes on its website. */
  @Get(':org/:key/widget.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  script(@Param('org') org: string, @Param('key') key: string) {
    return asTenant(this.db, org, async () => {
      const w = await this.db.tenant((tx) => this.widget(tx, key));
      const src = `${webBase()}/chat/${encodeURIComponent(org)}/${encodeURIComponent(key)}`;
      return `(function(){if(window.__ubosChat)return;window.__ubosChat=1;var o=false,c=${JSON.stringify(w.color)};var b=document.createElement('button');b.type='button';b.setAttribute('aria-label','Chat with us');b.style.cssText='position:fixed;right:20px;bottom:20px;width:58px;height:58px;border:0;border-radius:50%;background:'+c+';color:#fff;font-size:24px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:2147483000';b.textContent='\\u2709';var f=document.createElement('iframe');f.title='Chat';f.src=${JSON.stringify(src)};f.style.cssText='position:fixed;right:20px;bottom:90px;width:min(370px,calc(100vw - 40px));height:min(540px,calc(100vh - 120px));border:0;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;z-index:2147483000;background:#fff';b.onclick=function(){o=!o;f.style.display=o?'block':'none';};document.body.appendChild(f);document.body.appendChild(b);})();`;
    });
  }

  @Get(':org/:key')
  info(@Param('org') org: string, @Param('key') key: string) {
    return asTenant(this.db, org, async (t) => this.db.tenant(async (tx) => {
      await authFeatureCheck(tx);
      const w = await this.widget(tx, key);
      return { organization: t.name, greeting: w.greeting, color: w.color };
    }));
  }

  @Post(':org/:key/start')
  @HttpCode(200)
  start(@Param('org') org: string, @Param('key') key: string, @Body() body: unknown, @Ip() ip: string) {
    const input = parse(Start, body);
    return asTenant(this.db, org, async (t) => {
      rateLimit(`chat-start:${t.id}:${ip}`, 5);
      if (input._hp) return { token: randomToken(24) }; // the hidden field was filled: a bot
      const w = await this.db.tenant(async (tx) => { await authFeatureCheck(tx); return this.widget(tx, key); });
      const first = input.message || 'Started a chat';
      const out = await this.intake.process({ tenantId: t.id, integrationKey: `webchat:${w.id}`, workspaceId: w.workspaceId, mode: 'add_remark', via: `website chat “${w.name}”`, record: { name: input.name, mobile: input.mobile, email: input.email }, externalId: null, input: { name: input.name, mobile: input.mobile, email: input.email || null, remark: `Website chat: ${first}`, source: 'website_chat' } });
      if (out.outcome === 'rejected' || !out.leadId) throw new BadRequestException({ code: 'INVALID', message: out.errors.join('. ') || 'Please check your details' });
      const token = randomToken(24);
      const conv = await this.db.tenant(async (tx) => {
        const lead = await tx.lead.findUniqueOrThrow({ where: { id: out.leadId! } });
        const c = await tx.conversation.create({ data: { tenantId: t.id, channel: 'webchat', waId: sha256(token), leadId: lead.id, customerId: lead.customerId, workspaceId: lead.workspaceId, assigneeId: lead.ownerId, lastInboundAt: new Date(), unread: 1 } });
        await tx.message.create({ data: { tenantId: t.id, conversationId: c.id, direction: 'out', type: 'text', body: w.greeting, status: 'sent' } });
        await tx.message.create({ data: { tenantId: t.id, conversationId: c.id, direction: 'in', type: 'text', body: first, status: 'received' } });
        if (lead.ownerId) await notify(tx, [lead.ownerId], { type: 'mention', title: `${input.name} started a website chat`, body: first.slice(0, 200), link: `/app/inbox?c=${c.id}` });
        return c;
      });
      live.publish(t.id, { type: 'message.received', conversationId: conv.id, leadId: conv.leadId, userId: conv.assigneeId });
      await this.bot.onMessage(conv, first).catch(() => undefined);
      return { token };
    });
  }

  @Get(':org/:key/messages')
  messages(@Param('org') org: string, @Headers('x-chat-token') token: string | undefined, @Query('after') after?: string) {
    return asTenant(this.db, org, async () => this.db.tenant(async (tx) => {
      const conv = await this.mine(tx, token);
      const since = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : undefined;
      const rows = await tx.message.findMany({ where: { conversationId: conv.id, ...(since ? { createdAt: { gt: since } } : {}) }, orderBy: { createdAt: 'asc' }, take: 200 });
      return rows.map((m) => ({ id: m.id, from: m.direction === 'in' ? 'you' : 'them', text: m.body, options: m.options, at: m.createdAt }));
    }));
  }

  @Post(':org/:key/messages')
  @HttpCode(200)
  say(@Param('org') org: string, @Headers('x-chat-token') token: string | undefined, @Body() body: unknown) {
    const { text } = parse(Say, body);
    return asTenant(this.db, org, async (t) => {
      const conv = await this.db.tenant(async (tx) => {
        const c = await this.mine(tx, token);
        rateLimit(`chat:${c.id}`, 30);
        await tx.message.create({ data: { tenantId: t.id, conversationId: c.id, direction: 'in', type: 'text', body: text, status: 'received' } });
        await tx.conversation.update({ where: { id: c.id }, data: { lastInboundAt: new Date(), lastMessageAt: new Date(), unread: { increment: 1 }, status: 'open' } });
        if (c.leadId) await tx.lead.update({ where: { id: c.leadId }, data: { lastActivityAt: new Date() } });
        return c;
      });
      live.publish(t.id, { type: 'message.received', conversationId: conv.id, leadId: conv.leadId, userId: conv.assigneeId });
      await this.bot.onMessage(conv, text).catch(() => undefined);
      return { ok: true };
    });
  }
}
