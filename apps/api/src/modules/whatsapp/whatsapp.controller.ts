import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { contact, fieldAccess } from '../../common/field-access';
import { toWaId, windowOpen, WhatsAppService } from './whatsapp.service';

const Variable = z.string().regex(/^(name|mobile|city|owner|cf:[a-z][a-z0-9_]*|text:.{1,60})$/, 'Use name, mobile, city, owner, cf:<field> or text:<fixed text>');
const TemplateBody = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Use the template name exactly as approved (lowercase, digits, _)'), language: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('en'),
  category: z.enum(['marketing', 'utility']).default('marketing'), body: z.string().trim().min(1).max(1024), variables: z.array(Variable).max(10).default([]),
});
const ListQuery = z.object({ view: z.enum(['mine', 'unassigned', 'all']).default('all'), q: z.string().trim().max(60).optional() });

/** Shared WhatsApp inbox, chat on a lead, templates and broadcasts. */
@Controller('api/v1')
@RequireFeature('module.whatsapp')
export class WhatsAppController {
  constructor(private db: DbService, private wa: WhatsAppService) {}

  @Get('conversations')
  @RequirePermission('crm.whatsapp.chat')
  list(@Query() query: unknown) {
    const q = parse(ListQuery, query);
    return this.db.tenant(async (tx) => {
      const me = auth().userId;
      const where: Prisma.ConversationWhereInput = {
        AND: [await this.visible(tx),
          q.view === 'mine' ? { assigneeId: me } : q.view === 'unassigned' ? { assigneeId: null } : {},
          q.q ? { OR: [{ waId: { contains: q.q.replace(/\D/g, '') || '§' } }, { leadId: { in: (await tx.lead.findMany({ where: { customer: { name: { contains: q.q, mode: 'insensitive' } } }, select: { id: true }, take: 200 })).map((l) => l.id) } }] } : {}],
      };
      const rows = await tx.conversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, take: 200 });
      return this.describe(tx, rows);
    });
  }

  @Get('conversations/:id')
  @RequirePermission('crm.whatsapp.chat')
  thread(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const conv = await this.conversation(tx, id);
      const messages = await tx.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' }, take: 500 });
      if (conv.unread && conv.assigneeId === auth().userId) await tx.conversation.update({ where: { id }, data: { unread: 0 } });
      const users = new Map((await tx.user.findMany({ where: { id: { in: messages.map((m) => m.userId).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const [desc] = await this.describe(tx, [conv]);
      return { ...desc, messages: messages.map((m) => ({ id: m.id, direction: m.direction, type: m.type, body: m.body, templateName: m.templateName, status: m.status, error: m.error, at: m.createdAt, by: m.userId ? users.get(m.userId) ?? null : null })) };
    });
  }

  @Post('conversations/:id/messages')
  @RequirePermission('crm.whatsapp.chat')
  async reply(@Param('id') id: string, @Body() body: unknown) {
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(4096) }), body);
    await this.db.tenant((tx) => this.conversation(tx, id));
    return this.wa.sendText(tenantId(), id, auth().userId, text);
  }

  @Post('conversations/:id/assign')
  @RequirePermission('crm.lead.assign')
  assign(@Param('id') id: string, @Body() body: unknown) {
    const { userId } = parse(z.object({ userId: z.string().uuid().nullable() }), body);
    return this.db.tenant(async (tx) => {
      const conv = await this.conversation(tx, id);
      if (userId && !(await tx.user.findFirst({ where: { id: userId, isActive: true } }))) throw new BadRequestException({ code: 'INVALID_USER', message: 'Choose an active person' });
      await tx.conversation.update({ where: { id }, data: { assigneeId: userId } });
      await this.db.audit(tx, { workspaceId: conv.workspaceId, entity: 'conversation', entityId: id, action: 'conversation.assigned', oldValue: { assigneeId: conv.assigneeId }, newValue: { assigneeId: userId } });
      return { ok: true };
    });
  }

  @Post('conversations/:id/status')
  @RequirePermission('crm.whatsapp.chat')
  setStatus(@Param('id') id: string, @Body() body: unknown) {
    const { status } = parse(z.object({ status: z.enum(['open', 'closed']) }), body);
    return this.db.tenant(async (tx) => { await this.conversation(tx, id); await tx.conversation.update({ where: { id }, data: { status } }); return { ok: true }; });
  }

  /** The lead's WhatsApp chat (by the customer's number) and what the person may do. */
  @Get('leads/:id/whatsapp')
  @RequirePermission('crm.whatsapp.chat')
  leadChat(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.whatsapp.chat'), { id }] }, include: { customer: true } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const conv = lead.customer.mobile ? await tx.conversation.findUnique({ where: { tenantId_channel_waId: { tenantId: tenantId(), channel: 'whatsapp', waId: toWaId(lead.customer.mobile) } } }) : null;
      const connected = !!(await this.wa.config(tx));
      return { connected, conversationId: conv?.id ?? null, windowOpen: windowOpen(conv?.lastInboundAt ?? null), optedOut: lead.customer.whatsappOptOut, hasNumber: !!lead.customer.mobile };
    });
  }

  @Post('leads/:id/whatsapp/template')
  @RequirePermission('crm.whatsapp.chat')
  async sendTemplate(@Param('id') id: string, @Body() body: unknown) {
    const { templateId } = parse(z.object({ templateId: z.string().uuid() }), body);
    await this.db.tenant(async (tx) => {
      if (!(await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.whatsapp.chat'), { id }] } }))) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    });
    return this.wa.sendTemplate(tenantId(), id, templateId, auth().userId);
  }

  // ── Templates ──

  @Get('message-templates')
  @RequirePermission('crm.whatsapp.chat')
  templates(@Query('archived') archived?: string) {
    return this.db.tenant(async (tx) => ({
      canManage: !!auth().permissions['crm.whatsapp.broadcast'],
      templates: await tx.messageTemplate.findMany({ where: { channel: 'whatsapp', isArchived: archived === 'true' }, orderBy: { name: 'asc' } }),
    }));
  }

  /** Templates are approved in WhatsApp Manager first; here they are registered with how their {{n}} are filled. */
  @Post('message-templates')
  @RequirePermission('crm.whatsapp.broadcast')
  createTemplate(@Body() body: unknown) {
    const input = parse(TemplateBody, body);
    const n = Math.max(0, ...[...input.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
    if (n !== input.variables.length) throw new BadRequestException({ code: 'VARIABLES_MISMATCH', message: `The text has ${n} placeholder(s) — say what fills each one` });
    return this.db.tenant(async (tx) => {
      if (await tx.messageTemplate.findFirst({ where: { channel: 'whatsapp', name: input.name, language: input.language } })) throw new BadRequestException({ code: 'DUPLICATE_TEMPLATE', message: 'This template is already registered' });
      const t = await tx.messageTemplate.create({ data: { tenantId: tenantId(), createdById: auth().userId, ...input } });
      await this.db.audit(tx, { entity: 'message_template', entityId: t.id, action: 'message_template.created', newValue: { name: t.name, language: t.language } });
      return t;
    });
  }

  @Patch('message-templates/:id')
  @RequirePermission('crm.whatsapp.broadcast')
  archiveTemplate(@Param('id') id: string, @Body() body: unknown) {
    const { isArchived } = parse(z.object({ isArchived: z.boolean() }), body);
    return this.db.tenant(async (tx) => {
      await tx.messageTemplate.update({ where: { id }, data: { isArchived } }).catch(() => { throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' }); });
      await this.db.audit(tx, { entity: 'message_template', entityId: id, action: isArchived ? 'message_template.archived' : 'message_template.restored' });
      return { ok: true };
    });
  }

  // ── Broadcasts ──

  /** Sends a template to many leads (in the person's scope). Opted-out customers and leads without a number are skipped. */
  @Post('broadcasts')
  @RequirePermission('crm.whatsapp.broadcast')
  async broadcast(@Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(2).max(80), templateId: z.string().uuid(), leadIds: z.array(z.string().uuid()).min(1).max(1000) }), body);
    const { leads, b } = await this.db.tenant(async (tx) => {
      const leads = await tx.lead.findMany({ where: { AND: [await scopeFilter(tx, 'crm.whatsapp.broadcast'), { id: { in: input.leadIds } }] }, include: { customer: true } });
      if (!(await tx.messageTemplate.findFirst({ where: { id: input.templateId, isArchived: false } }))) throw new BadRequestException({ code: 'TEMPLATE_NOT_FOUND', message: 'Choose an active template' });
      const b = await tx.broadcast.create({ data: { tenantId: tenantId(), templateId: input.templateId, name: input.name, total: leads.length, createdById: auth().userId } });
      return { leads, b };
    });
    let sent = 0, skipped = 0, failed = 0;
    const seen = new Set<string>();
    for (const l of leads) {
      const waId = l.customer.mobile ? toWaId(l.customer.mobile) : null;
      if (!waId || l.customer.whatsappOptOut || seen.has(waId)) { skipped++; continue; } // one message per person
      seen.add(waId);
      try { await this.wa.sendTemplate(tenantId(), l.id, input.templateId, auth().userId, b.id); sent++; } catch { failed++; }
    }
    return this.db.tenant(async (tx) => {
      const done = await tx.broadcast.update({ where: { id: b.id }, data: { sent, skipped, failed } });
      await this.db.audit(tx, { entity: 'broadcast', entityId: b.id, action: 'broadcast.sent', newValue: { name: input.name, total: leads.length, sent, skipped, failed } });
      return done;
    });
  }

  @Get('broadcasts')
  @RequirePermission('crm.whatsapp.broadcast')
  broadcasts() {
    return this.db.tenant((tx) => tx.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }));
  }

  // ── helpers ──

  /** Chats on leads in the person's scope, chats assigned to them, and unlinked chats for people who can assign. */
  private async visible(tx: Tx): Promise<Prisma.ConversationWhereInput> {
    const leads = await tx.lead.findMany({ where: await scopeFilter(tx, 'crm.whatsapp.chat'), select: { id: true }, take: 50_000 });
    return { OR: [{ leadId: { in: leads.map((l) => l.id) } }, { assigneeId: auth().userId }, ...(auth().permissions['crm.lead.assign'] ? [{ leadId: null }] : [])] };
  }

  private async conversation(tx: Tx, id: string) {
    const c = await tx.conversation.findFirst({ where: { AND: [await this.visible(tx), { id }] } });
    if (!c) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Chat not found' });
    return c;
  }

  private async describe(tx: Tx, rows: { id: string; waId: string; leadId: string | null; customerId: string | null; assigneeId: string | null; status: string; lastMessageAt: Date; lastInboundAt: Date | null; unread: number; workspaceId: string | null }[]) {
    const fa = await fieldAccess(tx);
    const [customers, users, lasts] = await Promise.all([
      tx.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId).filter(Boolean) as string[] } }, select: { id: true, name: true, whatsappOptOut: true } }),
      tx.user.findMany({ where: { id: { in: rows.map((r) => r.assigneeId).filter(Boolean) as string[] } }, select: { id: true, name: true } }),
      Promise.all(rows.map((r) => tx.message.findFirst({ where: { conversationId: r.id }, orderBy: { createdAt: 'desc' }, select: { body: true, direction: true, status: true } }))),
    ]);
    return rows.map((r, i) => {
      const c = customers.find((x) => x.id === r.customerId);
      return {
        id: r.id, phone: contact(fa, 'mobile', `+${r.waId}`), name: c?.name ?? `+${r.waId}`, leadId: r.leadId, workspaceId: r.workspaceId, assigneeId: r.assigneeId,
        assigneeName: users.find((u) => u.id === r.assigneeId)?.name ?? null, status: r.status, unread: r.unread, lastMessageAt: r.lastMessageAt,
        windowOpen: windowOpen(r.lastInboundAt), optedOut: !!c?.whatsappOptOut, last: lasts[i],
      };
    });
  }
}
