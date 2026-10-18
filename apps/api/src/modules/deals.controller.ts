import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { normalizeMobile } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { activity, assignmentAvailability, defaultStatus, eligibleOwners, makeAssigner } from '../common/lead-ops';
import { findCustomer, nextCustomerCode } from '../common/customers';
import { notify } from '../common/notify';
import { startProcessesOnWin } from '../common/process-engine';

const Paise = z.number().int().min(1).max(10_000_000_000);
const Mode = z.enum(['cash', 'upi', 'card', 'bank', 'cheque', 'online']);
const PaymentBody = z.object({
  amountPaise: Paise, kind: z.enum(['token', 'instalment', 'balance', 'full']).default('instalment'), mode: Mode.default('upi'),
  reference: z.string().trim().max(80).nullable().optional(), receivedAt: z.coerce.date().optional(), note: z.string().trim().max(500).nullable().optional(),
  runId: z.string().uuid().nullable().optional(), packageId: z.string().uuid().nullable().optional(),
});
const Incoming = z.object({
  mobile: z.string().trim().max(20).optional(), email: z.string().trim().email().max(120).optional(), name: z.string().trim().min(2).max(80).optional(),
  amountPaise: Paise, packageId: z.string().uuid().nullable().optional(), mode: Mode.default('online'), reference: z.string().trim().max(80).nullable().optional(),
});
const Rules = z.object({
  rules: z.array(z.object({
    name: z.string().trim().min(2).max(60), minAmountPaise: z.number().int().min(0).nullable().optional(), maxAmountPaise: z.number().int().min(0).nullable().optional(),
    packageIds: z.array(z.string().uuid()).max(50).default([]), action: z.enum(['new_sale', 'instalment']),
  })).max(30),
});
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });
const TeamBody = z.object({ userId: z.string().uuid(), roleLabel: z.string().trim().min(2).max(40) });
const Accepting = z.object({ accepting: z.boolean() });
const CoverBody = z.object({
  userId: z.string().uuid().optional(), coverUserId: z.string().uuid(), startsAt: z.coerce.date(), endsAt: z.coerce.date(), note: z.string().trim().max(300).nullable().optional(),
});

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Payments (token, instalments, balance) and payment rules; lead team; accepting-new-leads switch; temporary cover. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class DealsController {
  constructor(private db: DbService) {}

  // ── Payments ──

  @Post('leads/:id/payments')
  @RequirePermission('process.payment')
  record(@Param('id') leadId: string, @Body() body: unknown) {
    const input = parse(PaymentBody, body);
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, leadId, 'process.payment');
      let runId = input.runId ?? null;
      if (runId) {
        if (!(await tx.processRun.findFirst({ where: { id: runId, leadId } }))) throw new BadRequestException({ code: 'INVALID_RUN', message: 'That process is not on this lead' });
      } else {
        runId = (await tx.processRun.findFirst({ where: { leadId, status: 'active' }, orderBy: { startedAt: 'desc' } }))?.id ?? null;
      }
      const p = await tx.payment.create({
        data: {
          tenantId: tenantId(), workspaceId: lead.workspaceId, customerId: lead.customerId, leadId, runId, packageId: input.packageId ?? null, amountPaise: input.amountPaise,
          kind: input.kind, mode: input.mode, reference: input.reference ?? null, receivedAt: input.receivedAt ?? new Date(), note: input.note ?? null, createdById: auth().userId,
        },
      });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'payment', remark: `${rupees(p.amountPaise)} received (${p.kind}, ${p.mode})`, data: { paymentId: p.id, runId } }) });
      await this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'payment', entityId: p.id, action: 'payment.recorded', newValue: { leadId, amountPaise: p.amountPaise, kind: p.kind, mode: p.mode, reference: p.reference } });
      return p;
    });
  }

  /** A wrong entry is voided (never deleted); audited. */
  @Post('payments/:id/void')
  @RequirePermission('process.payment')
  void(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Reason, body);
    return this.db.tenant(async (tx) => {
      const p = await tx.payment.findUnique({ where: { id } });
      if (!p) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: 'Payment not found' });
      if (p.leadId) await this.lead(tx, p.leadId, 'process.payment');
      if (p.isVoided) throw new BadRequestException({ code: 'ALREADY_VOIDED', message: 'This payment is already voided' });
      await tx.payment.update({ where: { id }, data: { isVoided: true, voidReason: input.reason, voidedById: auth().userId } });
      const lead = p.leadId ? await tx.lead.findUnique({ where: { id: p.leadId } }) : null;
      if (lead) await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'payment', remark: `Payment of ${rupees(p.amountPaise)} voided: ${input.reason}`, data: { paymentId: id } }) });
      await this.db.audit(tx, { workspaceId: p.workspaceId, entity: 'payment', entityId: id, action: 'payment.voided', oldValue: { amountPaise: p.amountPaise }, newValue: input });
      return { ok: true };
    });
  }

  @Get('workspaces/:id/payment-rules')
  @RequirePermission('crm.lead.view')
  rules(@Param('id') id: string) {
    return this.db.tenant(async (tx) => ({
      canManage: this.canManage(id),
      rules: await tx.paymentRule.findMany({ where: { workspaceId: id, isArchived: false }, orderBy: { position: 'asc' } }),
    }));
  }

  /** Replaces the rules (old ones are archived). The first matching rule decides; no match → instalment if a process is running, else a new sale. */
  @Put('workspaces/:id/payment-rules')
  @RequirePermission('crm.product.manage')
  saveRules(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Rules, body);
    if (!this.canManage(id)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can change payment rules' });
    return this.db.tenant(async (tx) => {
      const pkgs = [...new Set(input.rules.flatMap((r) => r.packageIds))];
      if (pkgs.length && (await tx.package.count({ where: { id: { in: pkgs }, workspaceId: id } })) !== pkgs.length) throw new BadRequestException({ code: 'INVALID_PRODUCT', message: 'Choose products of this business line' });
      if (input.rules.some((r) => r.minAmountPaise != null && r.maxAmountPaise != null && r.minAmountPaise > r.maxAmountPaise)) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'The minimum amount is above the maximum' });
      const old = await tx.paymentRule.findMany({ where: { workspaceId: id, isArchived: false } });
      await tx.paymentRule.updateMany({ where: { workspaceId: id, isArchived: false }, data: { isArchived: true } });
      await tx.paymentRule.createMany({ data: input.rules.map((r, position) => ({ tenantId: tenantId(), workspaceId: id, position, name: r.name, minAmountPaise: r.minAmountPaise ?? null, maxAmountPaise: r.maxAmountPaise ?? null, packageIds: r.packageIds, action: r.action })) });
      await this.db.audit(tx, { workspaceId: id, entity: 'workspace', entityId: id, action: 'workspace.payment_rules_changed', oldValue: old.map((r) => ({ name: r.name, action: r.action })), newValue: input });
      return { ok: true };
    });
  }

  /**
   * A payment that arrives without a lead (gateway, bank statement, walk-in): the payment rules decide whether it is a
   * new sale (a won lead is created and its process starts) or an instalment of the customer's running process.
   */
  @Post('payments/incoming')
  @RequirePermission('process.payment')
  incoming(@Body() body: unknown) {
    const input = parse(Incoming, body);
    const a = auth();
    if (!a.workspaceId) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    const ws = a.workspaceId;
    return this.db.tenant(async (tx) => {
      const mobile = input.mobile ? normalizeMobile(input.mobile) : null;
      if (input.mobile && !mobile) throw new BadRequestException({ code: 'INVALID_MOBILE', message: 'Enter a valid mobile number' });
      if (!mobile && !input.email) throw new BadRequestException({ code: 'CUSTOMER_REQUIRED', message: 'Give the customer’s mobile or email' });
      if (input.packageId && !(await tx.package.findFirst({ where: { id: input.packageId, workspaceId: ws } }))) throw new BadRequestException({ code: 'INVALID_PRODUCT', message: 'Choose a product of this business line' });
      const match = await findCustomer(tx, { mobile, email: input.email ?? null });
      const running = match ? await tx.processRun.findFirst({ where: { customerId: match.customer.id, workspaceId: ws, status: 'active' }, orderBy: { startedAt: 'desc' } }) : null;

      const rules = await tx.paymentRule.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { position: 'asc' } });
      const rule = rules.find((r) => (r.minAmountPaise == null || input.amountPaise >= r.minAmountPaise) && (r.maxAmountPaise == null || input.amountPaise <= r.maxAmountPaise)
        && (!r.packageIds.length || (!!input.packageId && r.packageIds.includes(input.packageId))));
      let action: 'new_sale' | 'instalment' = rule ? (rule.action as 'new_sale' | 'instalment') : running ? 'instalment' : 'new_sale';
      const fallback = action === 'instalment' && !running;
      if (fallback) action = 'new_sale'; // nothing running to attach to

      const base = { tenantId: tenantId(), workspaceId: ws, amountPaise: input.amountPaise, mode: input.mode, reference: input.reference ?? null, packageId: input.packageId ?? null, source: rule ? 'rule' : 'manual', createdById: a.userId };
      if (action === 'instalment' && running && match) {
        const p = await tx.payment.create({ data: { ...base, customerId: match.customer.id, leadId: running.leadId, runId: running.id, kind: 'instalment' } });
        const lead = await tx.lead.findUniqueOrThrow({ where: { id: running.leadId } });
        await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'payment', remark: `${rupees(p.amountPaise)} received as an instalment${rule ? ` (rule: ${rule.name})` : ''}`, data: { paymentId: p.id, runId: running.id } }) });
        if (lead.ownerId) await notify(tx, [lead.ownerId], { type: 'payment', title: `Payment received: ${rupees(p.amountPaise)} from ${match.customer.name}`, link: `/app/leads/${lead.id}?tab=process` });
        await this.db.audit(tx, { workspaceId: ws, entity: 'payment', entityId: p.id, action: 'payment.recorded', newValue: { action, rule: rule?.name ?? null, amountPaise: p.amountPaise } });
        return { action, rule: rule?.name ?? null, paymentId: p.id, leadId: lead.id, runId: running.id, fallback };
      }

      // New sale: the customer (matched or new) gets a won lead in this business line; its process starts.
      let customer = match?.customer ?? null;
      if (!customer) {
        if (!input.name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'New customer — give their name' });
        customer = await tx.customer.create({ data: { tenantId: tenantId(), name: input.name, mobile, email: input.email ?? null, code: await nextCustomerCode(tx) } });
      }
      const pipeline = await tx.pipeline.findFirst({ where: { workspaceId: ws }, orderBy: { position: 'asc' }, include: { stages: { orderBy: { position: 'asc' } } } });
      const won = pipeline?.stages.find((s) => s.isWon);
      if (!pipeline || !won) throw new BadRequestException({ code: 'NO_WON_STAGE', message: 'This business line has no Won stage' });
      const wsRow = await tx.workspace.findUniqueOrThrow({ where: { id: ws } });
      const eligible = (await eligibleOwners(tx, ws)).map((u) => u.id);
      const assigner = makeAssigner(wsRow, eligible, a.userId, await assignmentAvailability(tx));
      const ownerId = assigner.pick(customer.primaryRmId);
      await tx.workspace.update({ where: { id: ws }, data: { assignmentCursor: assigner.state.cursor } });
      const lead = await tx.lead.create({
        data: {
          tenantId: tenantId(), workspaceId: ws, pipelineId: pipeline.id, stageId: won.id, customerId: customer.id, source: 'payment', ownerId, assignedAt: new Date(),
          status: await defaultStatus(tx, ws), lastActivityAt: new Date(),
        },
      });
      if (!customer.primaryRmId) await tx.customer.update({ where: { id: customer.id }, data: { primaryRmId: ownerId } });
      const p = await tx.payment.create({ data: { ...base, customerId: customer.id, leadId: lead.id, kind: 'token' } });
      await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'payment', remark: `New sale from a payment of ${rupees(p.amountPaise)}${rule ? ` (rule: ${rule.name})` : ''}`, data: { paymentId: p.id } }) });
      const runs = await startProcessesOnWin(tx, lead.id, a.userId);
      if (ownerId) await notify(tx, [ownerId], { type: 'payment', title: `New sale: ${rupees(p.amountPaise)} from ${customer.name}`, link: `/app/leads/${lead.id}?tab=process` });
      await this.db.audit(tx, { workspaceId: ws, entity: 'payment', entityId: p.id, action: 'payment.new_sale', newValue: { rule: rule?.name ?? null, amountPaise: p.amountPaise, leadId: lead.id } });
      return { action: 'new_sale' as const, rule: rule?.name ?? null, paymentId: p.id, leadId: lead.id, runId: runs[0]?.id ?? null, fallback };
    });
  }

  // ── Lead team ──

  @Get('leads/:id/team')
  @RequirePermission('crm.lead.view')
  team(@Param('id') leadId: string) {
    return this.db.tenant(async (tx) => {
      await this.lead(tx, leadId, 'crm.lead.view');
      const rows = await tx.leadTeamMember.findMany({ where: { leadId, removedAt: null }, orderBy: { createdAt: 'asc' } });
      const users = await tx.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, email: true } });
      return rows.map((r) => ({ ...r, name: users.find((u) => u.id === r.userId)?.name ?? '', email: users.find((u) => u.id === r.userId)?.email ?? '' }));
    });
  }

  @Post('leads/:id/team')
  @RequirePermission('crm.lead.update')
  addMember(@Param('id') leadId: string, @Body() body: unknown) {
    const input = parse(TeamBody, body);
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, leadId, 'crm.lead.update');
      const user = await tx.user.findFirst({ where: { id: input.userId, isActive: true } });
      if (!user) throw new BadRequestException({ code: 'INVALID_USER', message: 'Choose an active person' });
      if (user.id === lead.ownerId) throw new BadRequestException({ code: 'ALREADY_OWNER', message: 'This person already owns the lead' });
      if (await tx.leadTeamMember.findFirst({ where: { leadId, userId: user.id, removedAt: null } })) throw new BadRequestException({ code: 'ALREADY_MEMBER', message: 'Already on this lead’s team' });
      const m = await tx.leadTeamMember.create({ data: { tenantId: tenantId(), leadId, userId: user.id, roleLabel: input.roleLabel, addedById: auth().userId } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'team', remark: `${user.name} added to the team as ${input.roleLabel}`, data: { userId: user.id } }) });
      await notify(tx, [user.id], { type: 'team', title: `You were added to a lead as ${input.roleLabel}`, link: `/app/leads/${leadId}` });
      await this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'lead', entityId: leadId, action: 'lead.team_member_added', newValue: input });
      return m;
    });
  }

  @Post('leads/:id/team/:memberId/remove')
  @RequirePermission('crm.lead.update')
  removeMember(@Param('id') leadId: string, @Param('memberId') memberId: string) {
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, leadId, 'crm.lead.update');
      const m = await tx.leadTeamMember.findFirst({ where: { id: memberId, leadId, removedAt: null } });
      if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Team member not found' });
      await tx.leadTeamMember.update({ where: { id: memberId }, data: { removedAt: new Date() } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'team', remark: `Removed from the team (${m.roleLabel})`, data: { userId: m.userId } }) });
      await this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'lead', entityId: leadId, action: 'lead.team_member_removed', oldValue: { userId: m.userId, roleLabel: m.roleLabel } });
      return { ok: true };
    });
  }

  // ── Availability: accepting new leads, temporary cover ──

  @Get('me/availability')
  availability() {
    return this.db.tenant(async (tx) => {
      const me = await tx.user.findUniqueOrThrow({ where: { id: auth().userId }, select: { acceptingLeads: true } });
      return { acceptingLeads: me.acceptingLeads, covers: await this.coverList(tx, false) };
    });
  }

  @Put('me/accepting-leads')
  setMine(@Body() body: unknown) {
    return this.setAccepting(auth().userId, parse(Accepting, body).accepting);
  }

  @Put('users/:id/accepting-leads')
  @RequirePermission('org.user.manage')
  setUser(@Param('id') id: string, @Body() body: unknown) {
    return this.setAccepting(id, parse(Accepting, body).accepting);
  }

  @Get('covers')
  @RequirePermission('org.user.view')
  covers() {
    return this.db.tenant((tx) => this.coverList(tx, !!auth().permissions['org.user.manage']));
  }

  /** "I'm away from … to …, X covers for me" — for yourself, or for anyone with user management rights. */
  @Post('covers')
  createCover(@Body() body: unknown) {
    const input = parse(CoverBody, body);
    const a = auth();
    const userId = input.userId ?? a.userId;
    if (userId !== a.userId && !a.permissions['org.user.manage']) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You can set cover only for yourself' });
    if (input.endsAt <= input.startsAt) throw new BadRequestException({ code: 'INVALID_DATES', message: 'The end must be after the start' });
    if (input.endsAt.getTime() - input.startsAt.getTime() > 90 * 86_400_000) throw new BadRequestException({ code: 'TOO_LONG', message: 'A cover can be at most 90 days' });
    if (input.coverUserId === userId) throw new BadRequestException({ code: 'INVALID_COVER', message: 'Choose someone else to cover' });
    return this.db.tenant(async (tx) => {
      const [who, cover] = await Promise.all([tx.user.findFirst({ where: { id: userId, isActive: true } }), tx.user.findFirst({ where: { id: input.coverUserId, isActive: true } })]);
      if (!who || !cover) throw new BadRequestException({ code: 'INVALID_USER', message: 'Choose active people' });
      const overlap = await tx.userCover.findFirst({ where: { userId, cancelledAt: null, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt } } });
      if (overlap) throw new BadRequestException({ code: 'OVERLAP', message: 'There is already a cover for these dates' });
      const c = await tx.userCover.create({ data: { tenantId: tenantId(), userId, coverUserId: cover.id, startsAt: input.startsAt, endsAt: input.endsAt, note: input.note ?? null, createdById: a.userId } });
      await notify(tx, [cover.id], { type: 'cover', title: `You are covering for ${who.name}`, body: `${input.startsAt.toDateString()} – ${input.endsAt.toDateString()}: their new leads and steps come to you, and you can see their leads.`, link: '/app/leads' });
      await this.db.audit(tx, { entity: 'user', entityId: userId, action: 'user.cover_set', newValue: { coverUserId: cover.id, startsAt: input.startsAt, endsAt: input.endsAt } });
      return c;
    });
  }

  @Post('covers/:id/cancel')
  cancelCover(@Param('id') id: string) {
    const a = auth();
    return this.db.tenant(async (tx) => {
      const c = await tx.userCover.findUnique({ where: { id } });
      if (!c || c.cancelledAt) throw new NotFoundException({ code: 'COVER_NOT_FOUND', message: 'Cover not found' });
      if (c.userId !== a.userId && !a.permissions['org.user.manage']) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You can end only your own cover' });
      await tx.userCover.update({ where: { id }, data: { cancelledAt: new Date() } });
      await this.db.audit(tx, { entity: 'user', entityId: c.userId, action: 'user.cover_ended', oldValue: { coverUserId: c.coverUserId } });
      return { ok: true };
    });
  }

  // ── helpers ──

  private canManage(workspaceId: string) {
    const a = auth();
    const scope = a.permissions['crm.product.manage'];
    return scope === 'ORGANIZATION' || (!!scope && a.workspaceId === workspaceId);
  }

  private async lead(tx: Tx, id: string, perm: 'crm.lead.view' | 'crm.lead.update' | 'process.payment') {
    const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, perm), { id }] } });
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return lead;
  }

  private setAccepting(userId: string, accepting: boolean) {
    return this.db.tenant(async (tx) => {
      const u = await tx.user.findUnique({ where: { id: userId } });
      if (!u) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
      await tx.user.update({ where: { id: userId }, data: { acceptingLeads: accepting } });
      await this.db.audit(tx, { entity: 'user', entityId: userId, action: accepting ? 'user.accepting_leads_on' : 'user.accepting_leads_off', oldValue: { acceptingLeads: u.acceptingLeads }, newValue: { acceptingLeads: accepting } });
      return { acceptingLeads: accepting };
    });
  }

  /** Current and upcoming covers: all of them for user managers, otherwise the ones involving me. */
  private async coverList(tx: Tx, all: boolean) {
    const me = auth().userId;
    const rows = await tx.userCover.findMany({
      where: { cancelledAt: null, endsAt: { gt: new Date() }, ...(all ? {} : { OR: [{ userId: me }, { coverUserId: me }] }) },
      orderBy: { startsAt: 'asc' }, take: 200,
    });
    const users = new Map((await tx.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.userId, r.coverUserId]) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const now = new Date();
    return rows.map((r) => ({ ...r, userName: users.get(r.userId) ?? '', coverName: users.get(r.coverUserId) ?? '', isActive: r.startsAt <= now }));
  }
}
