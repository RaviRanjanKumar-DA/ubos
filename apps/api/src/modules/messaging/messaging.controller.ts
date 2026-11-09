import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { asTenant } from '../integration-runtime';
import { countBlanks, MessagingService, unsubscribeCustomerId } from './messaging.service';

const Variable = z.string().regex(/^(name|mobile|city|owner|cf:[a-z][a-z0-9_]*|text:.{1,60})$/, 'Use name, mobile, city, owner, cf:<field> or text:<fixed text>');
const TemplateBody = z.object({
  channel: z.enum(['sms', 'email']), name: z.string().trim().regex(/^[a-z0-9_]{2,80}$/, 'Use lowercase letters, digits and _'), category: z.enum(['marketing', 'utility']).default('marketing'),
  body: z.string().trim().min(1).max(5000), subject: z.string().trim().max(200).nullable().optional(), variables: z.array(Variable).max(20).default([]),
  dltTemplateId: z.string().trim().regex(/^\d{10,25}$/, 'The DLT template ID is the 10–25 digit number from your DLT portal').nullable().optional(), providerTemplateId: z.string().trim().max(60).nullable().optional(),
});
const OptOut = z.object({ channel: z.enum(['sms', 'email']), optedOut: z.boolean() });

/** SMS and email templates, sending them to leads one by one or in bulk, and opt-outs. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class MessagingController {
  constructor(private db: DbService, private messaging: MessagingService) {}

  @Get('outreach/templates')
  @RequirePermission('crm.message.send')
  templates(@Query('channel') channel?: string) {
    return this.db.tenant(async (tx) => ({
      canManage: !!auth().permissions['crm.message.manage'],
      templates: await tx.messageTemplate.findMany({ where: { channel: channel === 'sms' || channel === 'email' ? channel : { in: ['sms', 'email'] }, isArchived: false }, orderBy: [{ channel: 'asc' }, { name: 'asc' }] }),
    }));
  }

  @Post('outreach/templates')
  @RequirePermission('crm.message.manage')
  create(@Body() body: unknown) {
    const input = parse(TemplateBody, body);
    if (input.channel === 'sms' && !input.dltTemplateId) throw new BadRequestException({ code: 'DLT_REQUIRED', message: 'SMS templates need their DLT template ID (India rule)' });
    if (input.channel === 'email' && !input.subject) throw new BadRequestException({ code: 'SUBJECT_REQUIRED', message: 'Write the email subject' });
    const n = Math.max(countBlanks(input.channel, input.body), input.channel === 'email' ? countBlanks('email', input.subject ?? '') : 0);
    if (n !== input.variables.length) throw new BadRequestException({ code: 'VARIABLES_MISMATCH', message: `The text has ${n} blank(s) — say what fills each one` });
    return this.db.tenant(async (tx) => {
      if (await tx.messageTemplate.findFirst({ where: { channel: input.channel, name: input.name, language: 'en' } })) throw new BadRequestException({ code: 'DUPLICATE_TEMPLATE', message: 'A template with this name already exists' });
      const t = await tx.messageTemplate.create({ data: { tenantId: tenantId(), createdById: auth().userId, ...input, subject: input.subject ?? null, dltTemplateId: input.dltTemplateId ?? null, providerTemplateId: input.providerTemplateId ?? null } });
      await this.db.audit(tx, { entity: 'message_template', entityId: t.id, action: 'message_template.created', newValue: { channel: t.channel, name: t.name } });
      return t;
    });
  }

  @Patch('outreach/templates/:id')
  @RequirePermission('crm.message.manage')
  archive(@Param('id') id: string, @Body() body: unknown) {
    const { isArchived } = parse(z.object({ isArchived: z.boolean() }), body);
    return this.db.tenant(async (tx) => {
      const t = await tx.messageTemplate.findFirst({ where: { id, channel: { in: ['sms', 'email'] } } });
      if (!t) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
      await tx.messageTemplate.update({ where: { id }, data: { isArchived } });
      await this.db.audit(tx, { entity: 'message_template', entityId: id, action: isArchived ? 'message_template.archived' : 'message_template.restored' });
      return { ok: true };
    });
  }

  /** SMS / email tab on a lead: what was sent, and whether the customer opted out. */
  @Get('leads/:id/outreach')
  @RequirePermission('crm.message.send')
  leadLog(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, id, 'crm.message.send');
      const convs = await tx.conversation.findMany({ where: { customerId: lead.customerId, channel: { in: ['sms', 'email'] } }, select: { id: true, channel: true } });
      const rows = await tx.message.findMany({ where: { conversationId: { in: convs.map((c) => c.id) } }, orderBy: { createdAt: 'desc' }, take: 50 });
      const users = new Map((await tx.user.findMany({ where: { id: { in: rows.map((m) => m.userId).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const sms = await tx.integrationConnection.findFirst({ where: { key: 'sms_dlt', workspaceId: null, status: 'active' }, select: { id: true } });
      return {
        smsConnected: !!sms, smsOptOut: lead.customer.smsOptOut, emailOptOut: lead.customer.emailOptOut, hasMobile: !!lead.customer.mobile, hasEmail: !!lead.customer.email,
        messages: rows.map((m) => ({ id: m.id, channel: m.type, direction: m.direction, subject: m.subject, tracked: !!m.trackToken, openedAt: m.openedAt, openCount: m.openCount, clickCount: m.clickCount, templateName: m.templateName, body: m.body, status: m.status, error: m.error, at: m.createdAt, by: m.userId ? users.get(m.userId) ?? null : null })),
      };
    });
  }

  @Post('leads/:id/outreach')
  @RequirePermission('crm.message.send')
  async sendOne(@Param('id') id: string, @Body() body: unknown) {
    const { templateId } = parse(z.object({ templateId: z.string().uuid() }), body);
    await this.db.tenant((tx) => this.lead(tx, id, 'crm.message.send'));
    return this.messaging.send(tenantId(), id, templateId, auth().userId);
  }

  /** Records that the customer asked to stop (or restart) SMS or email; audited. */
  @Post('leads/:id/outreach/opt-out')
  @RequirePermission('crm.lead.update')
  optOut(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(OptOut, body);
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, id, 'crm.lead.update');
      await tx.customer.update({ where: { id: lead.customerId }, data: input.channel === 'sms' ? { smsOptOut: input.optedOut } : { emailOptOut: input.optedOut } });
      await this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'customer', entityId: lead.customerId, action: 'customer.opt_out_changed', newValue: input });
      return { ok: true };
    });
  }

  /** One template to many leads in the person's scope. Opted-out people and leads without the address are skipped. */
  @Post('outreach/broadcasts')
  @RequirePermission('crm.message.manage')
  async broadcast(@Body() body: unknown) {
    const input = parse(z.object({ name: z.string().trim().min(2).max(80), templateId: z.string().uuid(), leadIds: z.array(z.string().uuid()).min(1).max(1000) }), body);
    const { leads, b, channel } = await this.db.tenant(async (tx) => {
      const t = await tx.messageTemplate.findFirst({ where: { id: input.templateId, isArchived: false, channel: { in: ['sms', 'email'] } } });
      if (!t) throw new BadRequestException({ code: 'TEMPLATE_NOT_FOUND', message: 'Choose an active template' });
      const leads = await tx.lead.findMany({ where: { AND: [await scopeFilter(tx, 'crm.message.manage'), { id: { in: input.leadIds } }] }, include: { customer: true } });
      const b = await tx.broadcast.create({ data: { tenantId: tenantId(), templateId: t.id, name: input.name, total: leads.length, createdById: auth().userId } });
      return { leads, b, channel: t.channel };
    });
    let sent = 0, skipped = 0, failed = 0;
    const seen = new Set<string>();
    for (const l of leads) {
      const address = channel === 'sms' ? l.customer.mobile : l.customer.email?.toLowerCase();
      const optedOut = channel === 'sms' ? l.customer.smsOptOut : l.customer.emailOptOut;
      if (!address || optedOut || seen.has(address)) { skipped++; continue; } // one message per person
      seen.add(address);
      try { await this.messaging.send(tenantId(), l.id, input.templateId, auth().userId, b.id); sent++; } catch { failed++; }
    }
    return this.db.tenant(async (tx) => {
      const done = await tx.broadcast.update({ where: { id: b.id }, data: { sent, skipped, failed } });
      await this.db.audit(tx, { entity: 'broadcast', entityId: b.id, action: 'broadcast.sent', newValue: { channel, name: input.name, total: leads.length, sent, skipped, failed } });
      return done;
    });
  }

  @Get('outreach/broadcasts')
  @RequirePermission('crm.message.manage')
  async broadcasts() {
    return this.db.tenant(async (tx) => {
      const ids = (await tx.messageTemplate.findMany({ where: { channel: { in: ['sms', 'email'] } }, select: { id: true } })).map((t) => t.id);
      return tx.broadcast.findMany({ where: { templateId: { in: ids } }, orderBy: { createdAt: 'desc' }, take: 100 });
    });
  }

  private async lead(tx: Tx, id: string, perm: 'crm.message.send' | 'crm.lead.update') {
    const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, perm), { id }] }, include: { customer: true } });
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return lead;
  }
}

const page = (title: string, inner: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;text-align:center"><h2>${title}</h2>${inner}</body>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The unsubscribe link in emails. Opening it only asks (mail scanners open links); the button does the opt-out. */
@Controller('public/unsubscribe')
export class UnsubscribeController {
  constructor(private db: DbService) {}

  @Get(':slug/:token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  ask(@Param('slug') slug: string, @Param('token') token: string) {
    return asTenant(this.db, slug, async (t) => {
      if (!unsubscribeCustomerId(t.id, token)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
      return page('Stop these emails?', `<p>${esc(t.name)} will no longer send you emails like this.</p><form method="post"><button style="padding:10px 20px;font-size:15px">Unsubscribe</button></form>`);
    });
  }

  @Post(':slug/:token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  confirm(@Param('slug') slug: string, @Param('token') token: string) {
    return asTenant(this.db, slug, async (t) => {
      const id = unsubscribeCustomerId(t.id, token);
      if (!id) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
      await this.db.tenant(async (tx) => {
        await tx.customer.update({ where: { id }, data: { emailOptOut: true } });
        await this.db.audit(tx, { actorType: 'system', entity: 'customer', entityId: id, action: 'customer.opt_out_changed', newValue: { channel: 'email', optedOut: true, via: 'unsubscribe link' } });
      });
      return page('You are unsubscribed', `<p>${esc(t.name)} will not send you these emails any more.</p>`);
    });
  }
}
