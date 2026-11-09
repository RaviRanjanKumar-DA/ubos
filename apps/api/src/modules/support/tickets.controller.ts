import { BadRequestException, Body, Controller, ForbiddenException, Get, Logger, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, Tx } from '@ubos/database';
import type { PermissionKey } from '@ubos/shared';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, ctx, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { coveredUserIds, scopeFilter } from '../../common/scope';
import { contact, fieldAccess } from '../../common/field-access';
import { notify } from '../../common/notify';
import { Mailer } from '../../auth/mailer';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_SLA: Record<Priority, { firstResponseMin: number; resolutionMin: number }> = {
  urgent: { firstResponseMin: 30, resolutionMin: 240 }, high: { firstResponseMin: 60, resolutionMin: 480 }, normal: { firstResponseMin: 240, resolutionMin: 1440 }, low: { firstResponseMin: 480, resolutionMin: 4320 },
};
const STATUS_LABEL: Record<string, string> = { open: 'Open', pending: 'Waiting on customer', resolved: 'Resolved', closed: 'Closed' };
const MIN = 60_000;

const Create = z.object({
  customerId: z.string().uuid(), leadId: z.string().uuid().nullable().optional(), subject: z.string().trim().min(3).max(160), description: z.string().trim().max(5000).optional(),
  priority: z.enum(PRIORITIES).default('normal'), category: z.string().trim().max(60).optional(), source: z.enum(['manual', 'call', 'email', 'whatsapp', 'walk_in']).default('manual'), assigneeId: z.string().uuid().nullable().optional(),
});
const Update = z.object({ subject: z.string().trim().min(3).max(160).optional(), status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(), priority: z.enum(PRIORITIES).optional(), category: z.string().trim().max(60).nullable().optional(), assigneeId: z.string().uuid().nullable().optional() });
const Message = z.object({ kind: z.enum(['reply', 'note']), body: z.string().trim().min(1).max(5000), email: z.boolean().default(true) });
const ListQuery = z.object({ view: z.enum(['open', 'mine', 'unassigned', 'overdue', 'all']).default('open'), status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(), priority: z.enum(PRIORITIES).optional(), q: z.string().trim().max(100).optional(), customerId: z.string().uuid().optional() });
const Sla = z.object({ policies: z.array(z.object({ priority: z.enum(PRIORITIES), firstResponseMin: z.number().int().min(1).max(100_000), resolutionMin: z.number().int().min(1).max(200_000) })).min(1).max(4) });

type SlaRow = { status: string; firstResponseDueAt: Date; resolutionDueAt: Date; firstRespondedAt: Date | null; resolvedAt: Date | null; pausedAt: Date | null; createdAt: Date };

/** Where a ticket stands against its targets. Waiting on the customer stops the clock. */
export function slaState(t: SlaRow, now = new Date()) {
  const first = t.firstRespondedAt ? (t.firstRespondedAt <= t.firstResponseDueAt ? 'met' : 'missed') : t.status === 'pending' ? 'paused' : now > t.firstResponseDueAt ? 'breached' : 'running';
  let resolution: string;
  if (t.resolvedAt) resolution = t.resolvedAt <= t.resolutionDueAt ? 'met' : 'missed';
  else if (t.status === 'pending') resolution = 'paused';
  else if (now > t.resolutionDueAt) resolution = 'breached';
  else resolution = t.resolutionDueAt.getTime() - now.getTime() < (t.resolutionDueAt.getTime() - t.createdAt.getTime()) * 0.25 ? 'at_risk' : 'running';
  return { first, resolution, overdue: first === 'breached' || resolution === 'breached' };
}

/** Tells the owner and the desk's managers once when a ticket passes its target. Runs from the scheduler. */
export async function notifyTicketBreaches(db: DbService) {
  return db.tenant(async (tx) => {
    const now = new Date();
    const late = await tx.ticket.findMany({ where: { status: 'open', breachNotifiedAt: null, OR: [{ resolutionDueAt: { lt: now } }, { firstRespondedAt: null, firstResponseDueAt: { lt: now } }] }, take: 200 });
    for (const t of late) {
      const managers = await tx.user.findMany({ where: { isActive: true, roles: { some: { OR: [{ workspaceId: t.workspaceId }, { workspaceId: null }], role: { permissions: { some: { isDeny: false, permission: { key: 'support.ticket.assign' } } } } } } }, select: { id: true } });
      await notify(tx, [...new Set([t.assigneeId ?? t.createdById, ...managers.map((m) => m.id)])], { type: 'sla', title: `Ticket #${t.number} is past its target`, body: t.subject, link: `/app/tickets/${t.id}` });
      await tx.ticket.update({ where: { id: t.id }, data: { breachNotifiedAt: now } });
    }
    return late.length;
  });
}

/** Help desk: tickets on the customer record, a conversation with internal notes, SLA targets and clocks. */
@Controller('api/v1')
@RequireFeature('module.support')
export class TicketsController {
  private readonly log = new Logger('Tickets');
  constructor(private db: DbService, private mailer: Mailer) {}

  @Get('tickets/options')
  @RequirePermission('support.ticket.view')
  options() {
    const ws = auth().workspaceId;
    return this.db.tenant(async (tx) => {
      const [users, cats] = await Promise.all([
        ws ? this.agents(tx, ws) : Promise.resolve([]),
        tx.ticket.findMany({ where: { category: { not: null }, ...(ws ? { workspaceId: ws } : {}) }, distinct: ['category'], select: { category: true }, take: 100 }),
      ]);
      return { canManage: !!ws && this.canManage(ws), canAssign: !!auth().permissions['support.ticket.assign'], canWork: !!auth().permissions['support.ticket.work'], me: auth().userId, users: users.map((u) => ({ value: u.id, label: u.name })), categories: cats.map((c) => c.category) };
    });
  }

  @Get('tickets/sla')
  @RequirePermission('support.ticket.view')
  sla() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const rows = await tx.ticketSla.findMany({ where: { workspaceId: ws } });
      return PRIORITIES.map((priority) => { const r = rows.find((x) => x.priority === priority); return { priority, firstResponseMin: r?.firstResponseMin ?? DEFAULT_SLA[priority].firstResponseMin, resolutionMin: r?.resolutionMin ?? DEFAULT_SLA[priority].resolutionMin }; });
    });
  }

  /** New targets apply to tickets raised from now on. */
  @Put('tickets/sla')
  @RequirePermission('support.manage')
  saveSla(@Body() body: unknown) {
    const input = parse(Sla, body);
    const ws = this.ws();
    this.assertManage(ws);
    if (input.policies.some((p) => p.resolutionMin < p.firstResponseMin)) throw new BadRequestException({ code: 'INVALID_SLA', message: 'The resolution target cannot be shorter than the first response target' });
    return this.db.tenant(async (tx) => {
      for (const p of input.policies) await tx.ticketSla.upsert({ where: { workspaceId_priority: { workspaceId: ws, priority: p.priority } }, create: { tenantId: tenantId(), workspaceId: ws, ...p }, update: { firstResponseMin: p.firstResponseMin, resolutionMin: p.resolutionMin } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'ticket_sla', entityId: ws, action: 'ticket.sla_updated', newValue: input.policies });
      return { ok: true };
    });
  }

  @Get('tickets/summary')
  @RequirePermission('support.ticket.view')
  summary() {
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const scope = await this.scope(tx, 'support.ticket.view');
      const active = await tx.ticket.findMany({ where: { AND: [scope, { status: { in: ['open', 'pending'] } }] }, take: 5000 });
      const recent = await tx.ticket.findMany({ where: { AND: [scope, { resolvedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } }] }, select: { resolvedAt: true, resolutionDueAt: true }, take: 5000 });
      const met = recent.filter((t) => t.resolvedAt! <= t.resolutionDueAt).length;
      return {
        open: active.filter((t) => t.status === 'open').length, waiting: active.filter((t) => t.status === 'pending').length, unassigned: active.filter((t) => !t.assigneeId).length,
        overdue: active.filter((t) => slaState(t, now).overdue).length, resolved30d: recent.length, slaMetPct: recent.length ? Math.round((met / recent.length) * 100) : null,
      };
    });
  }

  @Get('tickets')
  @RequirePermission('support.ticket.view')
  list(@Query() query: unknown) {
    const q = parse(ListQuery, query);
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const a = auth();
      const and: Prisma.TicketWhereInput[] = [await this.scope(tx, 'support.ticket.view')];
      if (q.customerId) {
        // Tickets stay on the original record when customers are merged, so a merge can be undone cleanly.
        and.push({ customerId: { in: await this.mergedIds(tx, q.customerId) } });
      } else if (q.status) and.push({ status: q.status });
      else if (q.view !== 'all') and.push({ status: { in: q.view === 'overdue' ? ['open'] : ['open', 'pending'] } });
      if (q.view === 'mine') and.push({ assigneeId: a.userId });
      if (q.view === 'unassigned') and.push({ assigneeId: null });
      if (q.view === 'overdue') and.push({ OR: [{ resolutionDueAt: { lt: now } }, { firstRespondedAt: null, firstResponseDueAt: { lt: now } }] });
      if (q.priority) and.push({ priority: q.priority });
      if (q.q) {
        const n = /^#?\d+$/.test(q.q) ? Number(q.q.replace('#', '')) : null;
        and.push({ OR: [{ subject: { contains: q.q, mode: 'insensitive' } }, { customer: { name: { contains: q.q, mode: 'insensitive' } } }, ...(n !== null && n < 2_000_000_000 ? [{ number: n }] : [])] });
      }
      const rows = await tx.ticket.findMany({ where: { AND: and }, include: { customer: { select: { id: true, name: true } } }, orderBy: [{ createdAt: 'desc' }], take: 200 });
      const names = await this.names(tx, rows.map((r) => r.assigneeId));
      return rows.map((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, category: t.category, customerId: t.customer.id, customerName: t.customer.name, assigneeId: t.assigneeId, assignee: t.assigneeId ? names.get(t.assigneeId) ?? '' : null, sla: slaState(t, now), resolutionDueAt: t.resolutionDueAt, createdAt: t.createdAt }));
    });
  }

  @Post('tickets')
  @RequirePermission('support.ticket.work')
  create(@Body() body: unknown) {
    const input = parse(Create, body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      // Only customers this person can already see, the same rule as Customer 360.
      const customer = await tx.customer.findFirst({ where: { id: input.customerId, mergedIntoId: null, leads: { some: await scopeFilter(tx, 'crm.customer.view') } }, select: { id: true } });
      if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
      if (input.leadId) {
        const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.lead.view'), { id: input.leadId, customerId: input.customerId }] }, select: { id: true } });
        if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found for this customer' });
      }
      if (input.assigneeId && input.assigneeId !== auth().userId) this.assertAssign();
      if (input.assigneeId) await this.assertAgent(tx, ws, input.assigneeId);
      const target = await this.target(tx, ws, input.priority);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ticket-number:' || current_setting('app.tenant_id')))`;
      const number = ((await tx.ticket.aggregate({ _max: { number: true } }))._max.number ?? 0) + 1;
      const now = Date.now();
      const t = await tx.ticket.create({
        data: {
          tenantId: tenantId(), workspaceId: ws, number, customerId: input.customerId, leadId: input.leadId ?? null, subject: input.subject, description: input.description ?? null, priority: input.priority, category: input.category || null, source: input.source,
          assigneeId: input.assigneeId ?? null, createdById: auth().userId, firstResponseDueAt: new Date(now + target.firstResponseMin * MIN), resolutionDueAt: new Date(now + target.resolutionMin * MIN),
        },
      });
      await this.db.audit(tx, { workspaceId: ws, entity: 'ticket', entityId: t.id, action: 'ticket.created', newValue: { number, priority: t.priority, customerId: t.customerId } });
      if (t.assigneeId && t.assigneeId !== auth().userId) await notify(tx, [t.assigneeId], { type: 'assignment', title: `Ticket #${number} assigned to you`, body: t.subject, link: `/app/tickets/${t.id}` });
      return { id: t.id, number };
    });
  }

  @Get('tickets/:id')
  @RequirePermission('support.ticket.view')
  detail(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const t = await this.ticket(tx, id, 'support.ticket.view');
      const [fa, messages, customer] = await Promise.all([fieldAccess(tx), tx.ticketMessage.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' }, take: 500 }), tx.customer.findUniqueOrThrow({ where: { id: t.customerId } })]);
      const names = await this.names(tx, [t.assigneeId, t.createdById, ...messages.map((m) => m.authorId)]);
      const canWork = !!(await tx.ticket.findFirst({ where: { AND: [await this.scope(tx, 'support.ticket.work'), { id }] }, select: { id: true } }));
      return {
        id: t.id, number: t.number, subject: t.subject, description: t.description, status: t.status, priority: t.priority, category: t.category, source: t.source, workspaceId: t.workspaceId, leadId: t.leadId, assigneeId: t.assigneeId, assignee: t.assigneeId ? names.get(t.assigneeId) ?? '' : null, createdBy: names.get(t.createdById) ?? '',
        createdAt: t.createdAt, firstResponseDueAt: t.firstResponseDueAt, resolutionDueAt: t.resolutionDueAt, firstRespondedAt: t.firstRespondedAt, resolvedAt: t.resolvedAt, sla: slaState(t), canWork,
        customer: { id: customer.id, code: customer.code, name: customer.name, mobile: contact(fa, 'mobile', customer.mobile), email: contact(fa, 'email', customer.email), hasEmail: !!customer.email },
        messages: messages.map((m) => ({ id: m.id, kind: m.kind, body: m.body, emailStatus: m.emailStatus, createdAt: m.createdAt, author: m.authorId ? names.get(m.authorId) ?? '' : 'System' })),
      };
    });
  }

  @Patch('tickets/:id')
  @RequirePermission('support.ticket.work')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Update, body);
    return this.db.tenant(async (tx) => {
      const t = await this.ticket(tx, id, 'support.ticket.work');
      const me = auth().userId;
      const data: Prisma.TicketUpdateInput = {};
      const events: string[] = [];
      if (input.subject && input.subject !== t.subject) data.subject = input.subject;
      if (input.category !== undefined && (input.category || null) !== t.category) { data.category = input.category || null; }
      if (input.assigneeId !== undefined && input.assigneeId !== t.assigneeId) {
        const takingUnassigned = input.assigneeId === me && !t.assigneeId;
        if (!takingUnassigned) this.assertAssign();
        if (input.assigneeId) await this.assertAgent(tx, t.workspaceId, input.assigneeId);
        data.assigneeId = input.assigneeId;
        const name = input.assigneeId ? (await this.names(tx, [input.assigneeId])).get(input.assigneeId) : null;
        events.push(name ? `Assigned to ${name}` : 'Unassigned');
        if (input.assigneeId && input.assigneeId !== me) await notify(tx, [input.assigneeId], { type: 'assignment', title: `Ticket #${t.number} assigned to you`, body: t.subject, link: `/app/tickets/${t.id}` });
      }
      if (input.priority && input.priority !== t.priority) {
        const target = await this.target(tx, t.workspaceId, input.priority);
        // New targets count from when the ticket was raised, keeping any time it spent waiting on the customer.
        const pausedMs = t.resolutionDueAt.getTime() - t.createdAt.getTime() - (await this.target(tx, t.workspaceId, t.priority as Priority)).resolutionMin * MIN;
        const shift = Math.max(0, pausedMs);
        data.priority = input.priority;
        data.resolutionDueAt = new Date(t.createdAt.getTime() + target.resolutionMin * MIN + shift);
        if (!t.firstRespondedAt) data.firstResponseDueAt = new Date(t.createdAt.getTime() + target.firstResponseMin * MIN + shift);
        data.breachNotifiedAt = null;
        events.push(`Priority set to ${input.priority}`);
      }
      if (input.status && input.status !== t.status) Object.assign(data, this.statusChange(t, input.status));
      if (input.status && input.status !== t.status) events.push(`Status set to ${STATUS_LABEL[input.status]}`);
      if (!Object.keys(data).length) return { ok: true };
      await tx.ticket.update({ where: { id }, data });
      for (const e of events) await tx.ticketMessage.create({ data: { tenantId: tenantId(), ticketId: id, authorId: me, kind: 'event', body: e } });
      await this.db.audit(tx, { workspaceId: t.workspaceId, entity: 'ticket', entityId: id, action: 'ticket.updated', oldValue: { status: t.status, priority: t.priority, assigneeId: t.assigneeId }, newValue: input });
      return { ok: true };
    });
  }

  /** A reply to the customer (emailed when asked) or an internal note. A reply meets the first response target. */
  @Post('tickets/:id/messages')
  @RequirePermission('support.ticket.work')
  async addMessage(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Message, body);
    const org = ctx().tenant!.name;
    const r = await this.db.tenant(async (tx) => {
      const t = await this.ticket(tx, id, 'support.ticket.work');
      if (t.status === 'closed') throw new BadRequestException({ code: 'TICKET_CLOSED', message: 'This ticket is closed. Reopen it to add to it.' });
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: t.customerId }, select: { email: true } });
      const sendTo = input.kind === 'reply' && input.email ? customer.email : null;
      const m = await tx.ticketMessage.create({ data: { tenantId: tenantId(), ticketId: id, authorId: auth().userId, kind: input.kind, body: input.body, emailStatus: sendTo ? 'sending' : 'none' } });
      if (input.kind === 'reply' && !t.firstRespondedAt) await tx.ticket.update({ where: { id }, data: { firstRespondedAt: new Date() } });
      await this.db.audit(tx, { workspaceId: t.workspaceId, entity: 'ticket', entityId: id, action: input.kind === 'reply' ? 'ticket.replied' : 'ticket.noted', newValue: { messageId: m.id, emailed: !!sendTo } });
      return { messageId: m.id, sendTo, number: t.number, subject: t.subject };
    });
    if (!r.sendTo) return { id: r.messageId, emailStatus: 'none' };
    // Sent after saving, so a mail server problem never loses the reply; the person sees that it failed.
    let emailStatus = 'sent';
    try { await this.mailer.send(r.sendTo, `[Ticket #${r.number}] ${r.subject}`, `${input.body}\n\n${org} support`); } catch (e) { emailStatus = 'failed'; this.log.warn(`Ticket reply email failed: ${e instanceof Error ? e.message : e}`); }
    await this.db.tenant((tx) => tx.ticketMessage.update({ where: { id: r.messageId }, data: { emailStatus } }));
    return { id: r.messageId, emailStatus };
  }

  // ── Helpers ──

  /** Status fields, stopping the clock while waiting on the customer and moving the targets on when it restarts. */
  private statusChange(t: SlaRow & { closedAt: Date | null }, to: string): Prisma.TicketUpdateInput {
    const now = new Date();
    const data: Prisma.TicketUpdateInput = { status: to };
    if (to === 'pending') data.pausedAt = now;
    if (t.status === 'pending' && t.pausedAt) {
      const waited = now.getTime() - t.pausedAt.getTime();
      data.pausedAt = null;
      data.resolutionDueAt = new Date(t.resolutionDueAt.getTime() + waited);
      if (!t.firstRespondedAt) data.firstResponseDueAt = new Date(t.firstResponseDueAt.getTime() + waited);
    }
    if (to === 'resolved') data.resolvedAt = t.resolvedAt ?? now;
    if (to === 'closed') { data.closedAt = now; data.resolvedAt = t.resolvedAt ?? now; }
    if (to === 'open' || to === 'pending') { data.resolvedAt = null; data.closedAt = null; }
    return data;
  }

  private async target(tx: Tx, ws: string, priority: Priority) {
    return (await tx.ticketSla.findUnique({ where: { workspaceId_priority: { workspaceId: ws, priority } } })) ?? DEFAULT_SLA[priority];
  }

  /** Assigned to me or a colleague in my scope, or nobody's yet (so the queue can be picked up). */
  private async scope(tx: Tx, perm: PermissionKey): Promise<Prisma.TicketWhereInput> {
    const a = auth();
    const s = a.permissions[perm];
    if (!s) return { id: '__none__' };
    const base: Prisma.TicketWhereInput = a.workspaceId ? { workspaceId: a.workspaceId } : { workspaceId: { in: a.accessibleWorkspaceIds } };
    if (s === 'WORKSPACE' || s === 'ORGANIZATION') return base;
    let people = [a.userId, ...(await coveredUserIds(tx, a.userId))];
    if (s !== 'OWN') {
      const me = await tx.user.findUnique({ where: { id: a.userId }, include: { team: { include: { department: true } } } });
      if (me?.team) {
        const teamWhere: Prisma.TeamWhereInput = s === 'TEAM' ? { id: me.team.id } : s === 'DEPARTMENT' ? { departmentId: me.team.departmentId } : { department: { branchId: me.team.department.branchId } };
        people = [...people, ...(await tx.user.findMany({ where: { team: teamWhere }, select: { id: true } })).map((u) => u.id)];
      }
    }
    return { ...base, OR: [{ assigneeId: null }, { assigneeId: { in: people } }, { createdById: a.userId }] };
  }

  private async ticket(tx: Tx, id: string, perm: PermissionKey) {
    const t = await tx.ticket.findFirst({ where: { AND: [await this.scope(tx, perm), { id }] } });
    if (!t) throw new NotFoundException({ code: 'TICKET_NOT_FOUND', message: 'Ticket not found' });
    return t;
  }

  private async mergedIds(tx: Tx, id: string) {
    const ids = [id];
    let frontier = [id];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      frontier = (await tx.customer.findMany({ where: { mergedIntoId: { in: frontier } }, select: { id: true } })).map((c) => c.id);
      ids.push(...frontier);
    }
    return ids;
  }

  private async names(tx: Tx, ids: (string | null)[]) {
    const rows = await tx.user.findMany({ where: { id: { in: [...new Set(ids.filter(Boolean) as string[])] } }, select: { id: true, name: true } });
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private agents(tx: Tx, ws: string) {
    return tx.user.findMany({ where: { isActive: true, roles: { some: { OR: [{ workspaceId: ws }, { workspaceId: null }], role: { permissions: { some: { isDeny: false, permission: { key: 'support.ticket.work' } } } } } } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }
  private async assertAgent(tx: Tx, ws: string, userId: string) {
    if (!(await this.agents(tx, ws)).some((u) => u.id === userId)) throw new BadRequestException({ code: 'INVALID_ASSIGNEE', message: 'This person cannot work on tickets in this business line' });
  }
  private assertAssign() {
    if (!auth().permissions['support.ticket.assign']) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You cannot assign tickets to other people' });
  }
  private ws() {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return ws;
  }
  private canManage(ws: string) {
    const s = auth().permissions['support.manage'];
    return s === 'ORGANIZATION' || (!!s && auth().workspaceId === ws);
  }
  private assertManage(ws: string) {
    if (!this.canManage(ws)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can change this' });
  }
}
