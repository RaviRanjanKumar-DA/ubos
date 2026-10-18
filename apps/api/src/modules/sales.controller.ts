import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, ctx, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { activity, applyStageChange } from '../common/lead-ops';
import { notify } from '../common/notify';
import { Mailer } from '../auth/mailer';

const Paise = z.number().int().min(0).max(10_000_000_000);
const ProductBody = z.object({
  name: z.string().trim().min(2).max(80), code: z.string().trim().max(30).nullable().optional(), description: z.string().trim().max(1000).nullable().optional(),
  category: z.string().trim().max(40).nullable().optional(), unit: z.string().trim().min(1).max(20).default('unit'),
  mrpPaise: Paise, gstRate: z.number().min(0).max(28).default(18),
});
const ProductPatch = ProductBody.partial().extend({ isArchived: z.boolean().optional() });
const PriceListBody = z.object({
  name: z.string().trim().min(2).max(60), isDefault: z.boolean().default(false),
  validFrom: z.coerce.date().nullable().optional(), validTo: z.coerce.date().nullable().optional(),
  items: z.array(z.object({ packageId: z.string().uuid(), pricePaise: Paise, minPricePaise: Paise.nullable().optional() })).max(500).default([]),
});
const PriceListPatch = PriceListBody.partial().extend({ isArchived: z.boolean().optional() });
const QuoteItemIn = z.object({
  packageId: z.string().uuid().nullable().optional(), name: z.string().trim().min(1).max(120).optional(), qty: z.number().int().min(1).max(10_000).default(1),
  pricePaise: Paise.optional(), gstRate: z.number().min(0).max(28).optional(),
});
const QuoteBody = z.object({
  priceListId: z.string().uuid().nullable().optional(), validUntil: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(), terms: z.string().trim().max(4000).nullable().optional(),
  items: z.array(QuoteItemIn).min(1).max(100),
});
const QuoteSettings = z.object({ quoteMaxDiscountPct: z.number().int().min(0).max(100), quoteTerms: z.string().trim().max(4000).nullable().optional() });
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });
const Accept = z.object({ markWon: z.boolean().default(true) });
const Send = z.object({ email: z.boolean().default(false) });
const ByWs = z.object({ workspaceId: z.string().uuid().optional(), archived: z.enum(['true', 'false']).default('false') });

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Products & packages, price lists and quotes (from a lead), with discount approval. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class SalesController {
  constructor(private db: DbService, private mailer: Mailer) {}

  // ── Products & packages ──

  @Get('products')
  @RequirePermission('crm.lead.view')
  products(@Query() query: unknown) {
    const q = parse(ByWs, query);
    const ws = this.ws(q.workspaceId);
    return this.db.tenant(async (tx) => {
      const rows = await tx.package.findMany({ where: { workspaceId: ws, isArchived: q.archived === 'true' }, orderBy: [{ category: 'asc' }, { name: 'asc' }], include: { _count: { select: { sales: true } } } });
      return rows.map(({ _count, gstRate, ...p }) => ({ ...p, gstRate: Number(gstRate), soldCount: _count.sales }));
    });
  }

  @Post('products')
  @RequirePermission('crm.product.manage')
  createProduct(@Body() body: unknown) {
    const input = parse(ProductBody, body);
    const ws = this.ws();
    this.assertManage(ws);
    return this.db.tenant(async (tx) => {
      const dup = await tx.package.findFirst({ where: { workspaceId: ws, name: { equals: input.name, mode: 'insensitive' }, isArchived: false } });
      if (dup) throw new BadRequestException({ code: 'DUPLICATE_PRODUCT', message: 'A product with this name already exists in this business line' });
      const p = await tx.package.create({ data: { tenantId: tenantId(), workspaceId: ws, ...input } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'product', entityId: p.id, action: 'product.created', newValue: input });
      return { ...p, gstRate: Number(p.gstRate) };
    });
  }

  @Patch('products/:id')
  @RequirePermission('crm.product.manage')
  updateProduct(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ProductPatch, body);
    return this.db.tenant(async (tx) => {
      const p = await tx.package.findUnique({ where: { id } });
      if (!p) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
      this.assertManage(p.workspaceId);
      const updated = await tx.package.update({ where: { id }, data: input });
      await this.db.audit(tx, {
        workspaceId: p.workspaceId, entity: 'product', entityId: id,
        action: input.isArchived === true ? 'product.archived' : input.isArchived === false ? 'product.restored' : 'product.updated',
        oldValue: { name: p.name, mrpPaise: p.mrpPaise, gstRate: Number(p.gstRate) }, newValue: input,
      });
      return { ...updated, gstRate: Number(updated.gstRate) };
    });
  }

  // ── Price lists ──

  @Get('price-lists')
  @RequirePermission('crm.lead.view')
  priceLists(@Query() query: unknown) {
    const q = parse(ByWs, query);
    const ws = this.ws(q.workspaceId);
    return this.db.tenant((tx) => tx.priceList.findMany({ where: { workspaceId: ws, isArchived: q.archived === 'true' }, include: { items: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }));
  }

  @Post('price-lists')
  @RequirePermission('crm.product.manage')
  createPriceList(@Body() body: unknown) {
    const input = parse(PriceListBody, body);
    const ws = this.ws();
    this.assertManage(ws);
    return this.db.tenant(async (tx) => {
      await this.checkItems(tx, ws, input.items);
      if (input.isDefault) await tx.priceList.updateMany({ where: { workspaceId: ws }, data: { isDefault: false } });
      const pl = await tx.priceList.create({
        data: {
          tenantId: tenantId(), workspaceId: ws, name: input.name, isDefault: input.isDefault, validFrom: input.validFrom ?? null, validTo: input.validTo ?? null,
          items: { create: input.items.map((i) => ({ tenantId: tenantId(), packageId: i.packageId, pricePaise: i.pricePaise, minPricePaise: i.minPricePaise ?? null })) },
        },
        include: { items: true },
      });
      await this.db.audit(tx, { workspaceId: ws, entity: 'price_list', entityId: pl.id, action: 'price_list.created', newValue: input });
      return pl;
    });
  }

  @Put('price-lists/:id')
  @RequirePermission('crm.product.manage')
  updatePriceList(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(PriceListPatch, body);
    return this.db.tenant(async (tx) => {
      const pl = await tx.priceList.findUnique({ where: { id }, include: { items: true } });
      if (!pl) throw new NotFoundException({ code: 'PRICE_LIST_NOT_FOUND', message: 'Price list not found' });
      this.assertManage(pl.workspaceId);
      if (input.isDefault) await tx.priceList.updateMany({ where: { workspaceId: pl.workspaceId, id: { not: id } }, data: { isDefault: false } });
      const { items, ...rest } = input;
      await tx.priceList.update({ where: { id }, data: rest });
      if (items) {
        // Prices are configuration: the new list replaces the old one (quotes keep the prices they were made with).
        await this.checkItems(tx, pl.workspaceId, items);
        await tx.priceListItem.deleteMany({ where: { priceListId: id } });
        await tx.priceListItem.createMany({ data: items.map((i) => ({ tenantId: tenantId(), priceListId: id, packageId: i.packageId, pricePaise: i.pricePaise, minPricePaise: i.minPricePaise ?? null })) });
      }
      await this.db.audit(tx, {
        workspaceId: pl.workspaceId, entity: 'price_list', entityId: id, action: input.isArchived ? 'price_list.archived' : 'price_list.updated',
        oldValue: { name: pl.name, items: pl.items.map((i) => ({ packageId: i.packageId, pricePaise: i.pricePaise, minPricePaise: i.minPricePaise })) }, newValue: input,
      });
      return tx.priceList.findUnique({ where: { id }, include: { items: true } });
    });
  }

  @Put('workspaces/:id/quote-settings')
  @RequirePermission('crm.product.manage')
  quoteSettings(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(QuoteSettings, body);
    this.assertManage(id);
    return this.db.tenant(async (tx) => {
      const ws = await tx.workspace.findUnique({ where: { id } });
      if (!ws) throw new NotFoundException({ code: 'WORKSPACE_NOT_FOUND', message: 'Business line not found' });
      await tx.workspace.update({ where: { id }, data: { quoteMaxDiscountPct: input.quoteMaxDiscountPct, quoteTerms: input.quoteTerms ?? null } });
      await this.db.audit(tx, { workspaceId: id, entity: 'workspace', entityId: id, action: 'workspace.quote_settings_changed', oldValue: { quoteMaxDiscountPct: ws.quoteMaxDiscountPct }, newValue: input });
      return { ok: true };
    });
  }

  @Get('workspaces/:id/quote-settings')
  @RequirePermission('crm.lead.view')
  getQuoteSettings(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const ws = await tx.workspace.findUnique({ where: { id }, select: { quoteMaxDiscountPct: true, quoteTerms: true } });
      if (!ws) throw new NotFoundException({ code: 'WORKSPACE_NOT_FOUND', message: 'Business line not found' });
      return { ...ws, canManage: this.canManage(id) };
    });
  }

  // ── Quotes ──

  @Get('leads/:id/quotes')
  @RequirePermission('crm.lead.view')
  leadQuotes(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await this.lead(tx, id, 'crm.lead.view');
      const quotes = await tx.quote.findMany({ where: { leadId: id }, include: { items: { orderBy: { position: 'asc' } } }, orderBy: { createdAt: 'desc' } });
      const approvals = await tx.approvalRequest.findMany({ where: { entityId: { in: quotes.map((q) => q.id) } }, orderBy: { createdAt: 'desc' } });
      return quotes.map((q) => ({ ...q, approval: approvals.find((a) => a.entityId === q.id) ?? null }));
    });
  }

  @Get('quotes/:id')
  @RequirePermission('crm.lead.view')
  quote(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const q = await tx.quote.findUnique({ where: { id }, include: { items: { orderBy: { position: 'asc' } } } });
      if (!q) throw new NotFoundException({ code: 'QUOTE_NOT_FOUND', message: 'Quote not found' });
      const lead = await this.lead(tx, q.leadId, 'crm.lead.view');
      const [customer, ws, by, approval] = await Promise.all([
        tx.customer.findUniqueOrThrow({ where: { id: q.customerId }, select: { name: true, code: true, email: true, mobile: true, city: true } }),
        tx.workspace.findUniqueOrThrow({ where: { id: q.workspaceId }, select: { name: true, gstin: true } }),
        tx.user.findUnique({ where: { id: q.createdById }, select: { name: true, email: true } }),
        tx.approvalRequest.findFirst({ where: { entityId: q.id }, orderBy: { createdAt: 'desc' } }),
      ]);
      return { ...q, lead: { id: lead.id }, customer, workspace: ws, organization: ctx().tenant?.name, createdBy: by, approval };
    });
  }

  @Post('leads/:id/quotes')
  @RequirePermission('crm.quote.manage')
  createQuote(@Param('id') leadId: string, @Body() body: unknown) {
    const input = parse(QuoteBody, body);
    return this.db.tenant(async (tx) => {
      const lead = await this.lead(tx, leadId, 'crm.quote.manage');
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: lead.workspaceId } });
      const calc = await this.compute(tx, lead.workspaceId, input, ws.quoteMaxDiscountPct);
      const year = new Date().getFullYear();
      const count = await tx.quote.count({ where: { number: { startsWith: `Q-${year}-` } } });
      const q = await tx.quote.create({
        data: {
          tenantId: tenantId(), workspaceId: lead.workspaceId, leadId, customerId: lead.customerId, number: `Q-${year}-${String(count + 1).padStart(4, '0')}`,
          priceListId: calc.priceListId, validUntil: input.validUntil ?? new Date(Date.now() + 15 * 86_400_000), notes: input.notes ?? null,
          terms: input.terms ?? ws.quoteTerms ?? null, createdById: auth().userId, ...calc.totals, needsApproval: calc.needsApproval,
          items: { create: calc.items.map((i) => ({ tenantId: tenantId(), ...i })) },
        },
        include: { items: true },
      });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'quote', remark: `Quote ${q.number} created: ${rupees(q.totalPaise)}`, data: { quoteId: q.id } }) });
      await this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'quote', entityId: q.id, action: 'quote.created', newValue: { number: q.number, totalPaise: q.totalPaise, discountPaise: q.discountPaise, needsApproval: q.needsApproval } });
      return { ...q, reasons: calc.reasons };
    });
  }

  @Put('quotes/:id')
  @RequirePermission('crm.quote.manage')
  updateQuote(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(QuoteBody, body);
    return this.db.tenant(async (tx) => {
      const q = await this.editableQuote(tx, id);
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: q.workspaceId } });
      const calc = await this.compute(tx, q.workspaceId, input, ws.quoteMaxDiscountPct);
      // Any change after approval needs a fresh approval; a pending request is withdrawn.
      if (q.approvalId) await tx.approvalRequest.updateMany({ where: { id: q.approvalId, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } });
      await tx.quoteItem.deleteMany({ where: { quoteId: id } });
      const updated = await tx.quote.update({
        where: { id },
        data: {
          status: 'draft', approvalId: null, priceListId: calc.priceListId, validUntil: input.validUntil ?? q.validUntil, notes: input.notes ?? null, terms: input.terms ?? null,
          ...calc.totals, needsApproval: calc.needsApproval, items: { create: calc.items.map((i) => ({ tenantId: tenantId(), ...i })) },
        },
        include: { items: true },
      });
      await this.db.audit(tx, { workspaceId: q.workspaceId, entity: 'quote', entityId: id, action: 'quote.updated', oldValue: { totalPaise: q.totalPaise, status: q.status }, newValue: { totalPaise: updated.totalPaise, needsApproval: updated.needsApproval } });
      return { ...updated, reasons: calc.reasons };
    });
  }

  /** Send to the customer — or, when the discount is beyond the limit, ask a manager first. */
  @Post('quotes/:id/send')
  @RequirePermission('crm.quote.manage')
  send(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Send, body ?? {});
    return this.db.tenant(async (tx) => {
      const q = await this.editableQuote(tx, id);
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: q.leadId } });
      if (q.needsApproval && q.status !== 'approved') {
        if (q.status === 'pending_approval') throw new BadRequestException({ code: 'AWAITING_APPROVAL', message: 'This quote is waiting for approval' });
        const ap = await tx.approvalRequest.create({
          data: {
            tenantId: tenantId(), workspaceId: q.workspaceId, leadId: q.leadId, kind: 'quote_discount', entityId: q.id, requestedById: auth().userId,
            title: `Discount on ${q.number}: ${rupees(q.discountPaise)} off ${rupees(q.subtotalPaise)}`,
            details: { number: q.number, subtotalPaise: q.subtotalPaise, discountPaise: q.discountPaise, totalPaise: q.totalPaise },
          },
        });
        await tx.quote.update({ where: { id }, data: { status: 'pending_approval', approvalId: ap.id } });
        await notify(tx, await this.approvers(tx, q.workspaceId), { type: 'approval', title: `Approval needed: ${ap.title}`, link: '/app/approvals' });
        await this.db.audit(tx, { workspaceId: q.workspaceId, entity: 'quote', entityId: id, action: 'quote.approval_requested', newValue: { approvalId: ap.id } });
        return { status: 'pending_approval', approvalId: ap.id };
      }
      let emailed = false;
      if (input.email) {
        const c = await tx.customer.findUniqueOrThrow({ where: { id: q.customerId } });
        if (!c.email) throw new BadRequestException({ code: 'NO_EMAIL', message: 'This customer has no email address' });
        const items = await tx.quoteItem.findMany({ where: { quoteId: id }, orderBy: { position: 'asc' } });
        const lines = items.map((i) => `• ${i.name} × ${i.qty} — ${rupees(i.pricePaise * i.qty)}`).join('\n');
        await this.mailer.send(c.email, `Quote ${q.number} from ${ctx().tenant?.name ?? 'us'}`,
          `Dear ${c.name},\n\nPlease find our quote ${q.number}:\n\n${lines}\n\nTax: ${rupees(q.taxPaise)}\nTotal: ${rupees(q.totalPaise)}\nValid until: ${q.validUntil?.toDateString() ?? '—'}\n\n${q.terms ?? ''}\n\nRegards,\n${auth().name}`);
        emailed = true;
      }
      await tx.quote.update({ where: { id }, data: { status: 'sent', sentAt: new Date() } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'quote', remark: `Quote ${q.number} sent${emailed ? ' by email' : ''}`, data: { quoteId: id } }) });
      await this.db.audit(tx, { workspaceId: q.workspaceId, entity: 'quote', entityId: id, action: 'quote.sent', newValue: { emailed } });
      return { status: 'sent', emailed };
    });
  }

  /** Customer said yes: optionally marks the lead won, which starts the after-sale process. */
  @Post('quotes/:id/accept')
  @RequirePermission('crm.quote.manage')
  accept(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Accept, body ?? {});
    return this.db.tenant(async (tx) => {
      const q = await this.quoteInScope(tx, id);
      if (!['sent', 'approved'].includes(q.status)) throw new BadRequestException({ code: 'QUOTE_NOT_SENT', message: q.status === 'accepted' ? 'This quote is already accepted' : 'Send the quote before marking it accepted' });
      await tx.quote.update({ where: { id }, data: { status: 'accepted', decidedAt: new Date() } });
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: q.leadId } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'quote', remark: `Quote ${q.number} accepted by the customer`, data: { quoteId: id } }) });
      let won = false;
      if (input.markWon) {
        const stage = await tx.leadStage.findFirst({ where: { pipelineId: lead.pipelineId, isWon: true }, orderBy: { position: 'asc' } });
        if (stage && stage.id !== lead.stageId) {
          const refused = await applyStageChange(tx, lead, stage, auth().userId);
          if (refused) throw new BadRequestException({ code: 'STAGE_RULE', message: refused });
          won = true;
        }
      }
      await this.db.audit(tx, { workspaceId: q.workspaceId, entity: 'quote', entityId: id, action: 'quote.accepted', newValue: { markWon: won } });
      const runs = await tx.processRun.findMany({ where: { leadId: q.leadId, status: 'active' }, select: { id: true } });
      return { status: 'accepted', won, processRunIds: runs.map((r) => r.id) };
    });
  }

  @Post('quotes/:id/reject')
  @RequirePermission('crm.quote.manage')
  reject(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Reason, body);
    return this.db.tenant(async (tx) => {
      const q = await this.quoteInScope(tx, id);
      if (q.status !== 'sent') throw new BadRequestException({ code: 'QUOTE_NOT_SENT', message: 'Only a sent quote can be declined by the customer' });
      await tx.quote.update({ where: { id }, data: { status: 'rejected', decidedAt: new Date(), notes: [q.notes, `Declined: ${input.reason}`].filter(Boolean).join('\n') } });
      await this.db.audit(tx, { workspaceId: q.workspaceId, entity: 'quote', entityId: id, action: 'quote.rejected', newValue: input });
      return { status: 'rejected' };
    });
  }

  // ── helpers ──

  private ws(explicit?: string) {
    const ws = explicit ?? auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    if (!auth().accessibleWorkspaceIds.includes(ws)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You do not work in this business line' });
    return ws;
  }

  private canManage(workspaceId: string) {
    const a = auth();
    const scope = a.permissions['crm.product.manage'];
    return scope === 'ORGANIZATION' || (!!scope && a.workspaceId === workspaceId);
  }

  private assertManage(workspaceId: string) {
    if (!this.canManage(workspaceId)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can change products and prices' });
  }

  private async lead(tx: Tx, id: string, perm: 'crm.lead.view' | 'crm.quote.manage') {
    const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, perm), { id }] } });
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return lead;
  }

  private async quoteInScope(tx: Tx, id: string) {
    const q = await tx.quote.findUnique({ where: { id } });
    if (!q) throw new NotFoundException({ code: 'QUOTE_NOT_FOUND', message: 'Quote not found' });
    await this.lead(tx, q.leadId, 'crm.quote.manage');
    return q;
  }

  private async editableQuote(tx: Tx, id: string) {
    const q = await this.quoteInScope(tx, id);
    if (!['draft', 'pending_approval', 'approved'].includes(q.status)) {
      throw new BadRequestException({ code: 'QUOTE_LOCKED', message: `A ${q.status} quote cannot be changed — create a new quote instead` });
    }
    return q;
  }

  /** People who may approve in this business line (for the notification). */
  private async approvers(tx: Tx, workspaceId: string) {
    const now = new Date();
    const users = await tx.user.findMany({
      where: { isActive: true, roles: { some: { OR: [{ workspaceId }, { workspaceId: null }], AND: [{ OR: [{ validTo: null }, { validTo: { gt: now } }] }], role: { permissions: { some: { isDeny: false, permission: { key: 'process.approve' } } } } } } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async checkItems(tx: Tx, workspaceId: string, items: { packageId: string; pricePaise: number; minPricePaise?: number | null }[]) {
    const ids = [...new Set(items.map((i) => i.packageId))];
    if (ids.length !== items.length) throw new BadRequestException({ code: 'DUPLICATE_ITEM', message: 'Each product can appear once in a price list' });
    const found = await tx.package.count({ where: { id: { in: ids }, workspaceId } });
    if (found !== ids.length) throw new BadRequestException({ code: 'INVALID_PRODUCT', message: 'Choose products of this business line' });
    if (items.some((i) => i.minPricePaise != null && i.minPricePaise > i.pricePaise)) throw new BadRequestException({ code: 'INVALID_MIN_PRICE', message: 'The lowest price cannot be above the list price' });
  }

  /** Prices each line (price list → MRP), totals with GST, and whether a manager must approve the discount. */
  private async compute(tx: Tx, workspaceId: string, input: z.infer<typeof QuoteBody>, maxDiscountPct: number) {
    const now = new Date();
    const pl = input.priceListId
      ? await tx.priceList.findFirst({ where: { id: input.priceListId, workspaceId, isArchived: false }, include: { items: true } })
      : await tx.priceList.findFirst({ where: { workspaceId, isDefault: true, isArchived: false, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validTo: null }, { validTo: { gt: now } }] }] }, include: { items: true } });
    if (input.priceListId && !pl) throw new BadRequestException({ code: 'INVALID_PRICE_LIST', message: 'Choose a price list of this business line' });
    const productIds = input.items.map((i) => i.packageId).filter(Boolean) as string[];
    const products = await tx.package.findMany({ where: { id: { in: productIds }, workspaceId, isArchived: false } });
    const reasons: string[] = [];
    const items = input.items.map((i, position) => {
      if (i.packageId) {
        const p = products.find((x) => x.id === i.packageId);
        if (!p) throw new BadRequestException({ code: 'INVALID_PRODUCT', message: 'Choose active products of this business line' });
        const pi = pl?.items.find((x) => x.packageId === p.id);
        const list = pi?.pricePaise ?? p.mrpPaise;
        const price = i.pricePaise ?? list;
        if (pi?.minPricePaise != null && price < pi.minPricePaise) reasons.push(`${p.name} is below its lowest allowed price (${rupees(pi.minPricePaise)})`);
        return { packageId: p.id, name: i.name ?? p.name, qty: i.qty, listPricePaise: list, pricePaise: price, gstRate: i.gstRate ?? Number(p.gstRate), position };
      }
      if (!i.name || i.pricePaise === undefined) throw new BadRequestException({ code: 'INVALID_ITEM', message: 'A custom line needs a name and a price' });
      return { packageId: null, name: i.name, qty: i.qty, listPricePaise: i.pricePaise, pricePaise: i.pricePaise, gstRate: i.gstRate ?? 0, position };
    });
    const subtotalPaise = items.reduce((s, i) => s + i.listPricePaise * i.qty, 0);
    const netPaise = items.reduce((s, i) => s + i.pricePaise * i.qty, 0);
    const discountPaise = Math.max(0, subtotalPaise - netPaise);
    const taxPaise = Math.round(items.reduce((s, i) => s + (i.pricePaise * i.qty * i.gstRate) / 100, 0));
    const pct = subtotalPaise ? (discountPaise * 100) / subtotalPaise : 0;
    if (pct > maxDiscountPct) reasons.push(`Discount ${pct.toFixed(1)}% is above the ${maxDiscountPct}% limit`);
    return { items, priceListId: pl?.id ?? null, totals: { subtotalPaise, discountPaise, taxPaise, totalPaise: netPaise + taxPaise }, needsApproval: reasons.length > 0, reasons };
  }
}
