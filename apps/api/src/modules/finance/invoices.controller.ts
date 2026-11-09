import { BadRequestException, Body, ConflictException, Controller, Get, Header, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { computeInvoice, financialYear, GST_RATES_BP, GST_STATES, validGstin } from '@ubos/shared';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, ctx, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { istDate } from '../../common/ist';
import { activity } from '../../common/lead-ops';
import { recordInvoicePayment } from './invoice-payments';
import { scopeFilter } from '../../common/scope';

const VIEW = 'finance.invoice.view', WORK = 'finance.invoice.manage', ISSUE = 'finance.invoice.issue', SETUP = 'finance.settings';
const Gstin = z.string().trim().toUpperCase().refine(validGstin, 'That GSTIN is not valid');
const State = z.string().refine((s) => !!GST_STATES[s], 'Choose a state');
const Profile = z.object({
  legalName: z.string().trim().min(2).max(160), gstin: Gstin.nullable().optional(), stateCode: State, address: z.string().trim().min(5).max(500), email: z.string().trim().email().max(160).nullable().optional(), phone: z.string().trim().max(30).nullable().optional(),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, 'Use up to 6 letters or digits').default('INV'), terms: z.string().trim().max(2000).nullable().optional(), bankDetails: z.string().trim().max(1000).nullable().optional(),
}).refine((p) => !p.gstin || p.gstin.slice(0, 2) === p.stateCode, { message: 'The GSTIN belongs to a different state', path: ['gstin'] });
const Item = z.object({ description: z.string().trim().min(1).max(300), hsnSac: z.string().trim().regex(/^\d{4,8}$/, 'HSN or SAC is 4 to 8 digits').nullable().optional(), qty: z.number().int().min(1).max(100_000), unitPaise: z.number().int().min(0).max(1_000_000_000), discountPaise: z.number().int().min(0).default(0), gstBp: z.number().int().refine((n) => (GST_RATES_BP as readonly number[]).includes(n), 'Choose a GST rate') })
  .refine((i) => i.discountPaise <= i.qty * i.unitPaise, 'A discount cannot be more than the amount');
const Details = z.object({ items: z.array(Item).min(1).max(100), placeOfSupply: State.nullable().optional(), customerGstin: Gstin.nullable().optional(), customerAddress: z.string().trim().max(500).nullable().optional(), dueAt: z.coerce.date().nullable().optional(), notes: z.string().trim().max(2000).nullable().optional(), terms: z.string().trim().max(2000).nullable().optional() });
const Pay = z.object({ amountPaise: z.number().int().min(1), mode: z.enum(['cash', 'upi', 'card', 'bank', 'cheque', 'online']).default('upi'), reference: z.string().trim().max(80).nullable().optional(), receivedAt: z.coerce.date().optional() });
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });
const ListQ = z.object({ view: z.enum(['all', 'draft', 'unpaid', 'overdue', 'paid', 'cancelled']).default('all'), q: z.string().trim().max(80).optional() });
const RegQ = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

const money = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const rupees = (p: number) => (p / 100).toFixed(2);

/** GST invoices. Once issued an invoice cannot be edited; it can only be cancelled with a reason, and its number is never reused. */
@Controller('api/v1')
@RequireFeature('module.finance')
export class InvoicesController {
  constructor(private db: DbService) {}

  private ws() {
    const w = auth().workspaceId;
    if (!w) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return w;
  }
  private profile(tx: Tx, workspaceId: string) { return tx.billingProfile.findUnique({ where: { workspaceId } }); }
  private async needProfile(tx: Tx, workspaceId: string) {
    const p = await this.profile(tx, workspaceId);
    if (!p) throw new BadRequestException({ code: 'NO_BILLING_PROFILE', message: 'Add your billing details first (Invoices → Billing details)' });
    return p;
  }
  private async find(tx: Tx, id: string, perm: string) {
    const inv = await tx.invoice.findFirst({ where: { AND: [{ id }, { lead: await scopeFilter(tx, perm as never) }] }, include: { items: { orderBy: { position: 'asc' } } } });
    if (!inv) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    return inv;
  }

  @Get('billing-profile')
  @RequirePermission(VIEW)
  getProfile() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => ({ states: GST_STATES, rates: GST_RATES_BP, canEdit: !!auth().permissions[SETUP], profile: await this.profile(tx, ws) }));
  }

  @Put('billing-profile')
  @RequirePermission(SETUP)
  saveProfile(@Body() body: unknown) {
    const input = parse(Profile, body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const data = { legalName: input.legalName, gstin: input.gstin ?? null, stateCode: input.stateCode, address: input.address, email: input.email ?? null, phone: input.phone ?? null, invoicePrefix: input.invoicePrefix, terms: input.terms ?? null, bankDetails: input.bankDetails ?? null };
      const p = await tx.billingProfile.upsert({ where: { workspaceId: ws }, create: { ...data, tenantId: tenantId(), workspaceId: ws }, update: data });
      await this.db.audit(tx, { workspaceId: ws, entity: 'billing_profile', entityId: p.id, action: 'billing_profile.saved', newValue: { legalName: p.legalName, gstin: p.gstin, stateCode: p.stateCode } });
      return p;
    });
  }

  private place(inputPlace: string | null | undefined, gstin: string | null | undefined, customerState: string | null, sellerState: string) {
    return inputPlace || (gstin ? gstin.slice(0, 2) : null) || customerState || sellerState;
  }
  private totals(items: z.infer<typeof Item>[], place: string, seller: { stateCode: string; gstin: string | null }) {
    return computeInvoice(items, { intraState: place === seller.stateCode, registered: !!seller.gstin });
  }
  private itemRows(items: z.infer<typeof Item>[], calc: ReturnType<typeof computeInvoice>) {
    return items.map((i, position) => ({ tenantId: tenantId(), position, description: i.description, hsnSac: i.hsnSac ?? null, qty: i.qty, unitPaise: i.unitPaise, discountPaise: i.discountPaise, gstBp: i.gstBp, ...calc.lines[position] }));
  }
  private head(calc: ReturnType<typeof computeInvoice>) {
    const { lines: _l, ...t } = calc;
    return t;
  }

  private async buildDraft(tx: Tx, lead: { id: string; workspaceId: string; customerId: string }, input: z.infer<typeof Details>, quoteId: string | null) {
    const seller = await this.needProfile(tx, lead.workspaceId);
    const c = await tx.customer.findUniqueOrThrow({ where: { id: lead.customerId } });
    const gstin = input.customerGstin === undefined ? c.gstin : input.customerGstin;
    const placeOfSupply = this.place(input.placeOfSupply, gstin, c.stateCode, seller.stateCode);
    const calc = this.totals(input.items, placeOfSupply, seller);
    const inv = await tx.invoice.create({
      data: { tenantId: tenantId(), workspaceId: lead.workspaceId, leadId: lead.id, customerId: lead.customerId, quoteId, placeOfSupply, customerName: c.name, customerGstin: gstin ?? null, customerAddress: input.customerAddress ?? c.billingAddress, dueAt: input.dueAt ?? null, notes: input.notes ?? null, terms: input.terms ?? seller.terms, createdById: auth().userId, ...this.head(calc), items: { create: this.itemRows(input.items, calc) } },
      include: { items: true },
    });
    await this.db.audit(tx, { workspaceId: lead.workspaceId, entity: 'invoice', entityId: inv.id, action: 'invoice.drafted', newValue: { totalPaise: inv.totalPaise, quoteId } });
    return inv;
  }

  @Post('invoices')
  @RequirePermission(WORK)
  create(@Body() body: unknown) {
    const { leadId, ...rest } = parse(z.object({ leadId: z.string().uuid() }).merge(Details), body);
    return this.db.tenant(async (tx) => {
      const lead = await tx.lead.findFirst({ where: { AND: [{ id: leadId }, await scopeFilter(tx, WORK as never)] } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      return this.buildDraft(tx, lead, rest, null);
    });
  }

  @Post('invoices/from-quote/:quoteId')
  @RequirePermission(WORK)
  fromQuote(@Param('quoteId') quoteId: string) {
    return this.db.tenant(async (tx) => {
      const q = await tx.quote.findUnique({ where: { id: quoteId }, include: { items: { orderBy: { position: 'asc' } } } });
      const lead = q ? await tx.lead.findFirst({ where: { AND: [{ id: q.leadId }, await scopeFilter(tx, WORK as never)] } }) : null;
      if (!q || !lead) throw new NotFoundException({ code: 'QUOTE_NOT_FOUND', message: 'Quote not found' });
      if (!['approved', 'sent', 'accepted'].includes(q.status)) throw new BadRequestException({ code: 'QUOTE_NOT_READY', message: 'Only an approved, sent or accepted quote can become an invoice' });
      const existing = await tx.invoice.findFirst({ where: { quoteId, status: { not: 'cancelled' } }, select: { id: true } });
      if (existing) throw new ConflictException({ code: 'ALREADY_INVOICED', message: 'This quote already has an invoice', id: existing.id } as object);
      const items = q.items.map((i) => ({ description: i.name, hsnSac: null, qty: i.qty, unitPaise: i.pricePaise, discountPaise: 0, gstBp: Math.round(i.gstRate * 100) }));
      return this.buildDraft(tx, lead, { items, notes: q.notes, terms: q.terms } as z.infer<typeof Details>, q.id);
    });
  }

  @Put('invoices/:id')
  @RequirePermission(WORK)
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Details, body);
    return this.db.tenant(async (tx) => {
      const inv = await this.find(tx, id, WORK);
      if (inv.status !== 'draft') throw new BadRequestException({ code: 'NOT_DRAFT', message: 'An issued invoice cannot be changed' });
      const seller = await this.needProfile(tx, inv.workspaceId);
      const c = await tx.customer.findUniqueOrThrow({ where: { id: inv.customerId } });
      const gstin = input.customerGstin === undefined ? inv.customerGstin : input.customerGstin;
      const placeOfSupply = this.place(input.placeOfSupply, gstin, c.stateCode, seller.stateCode);
      const calc = this.totals(input.items, placeOfSupply, seller);
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      return tx.invoice.update({ where: { id }, data: { placeOfSupply, customerGstin: gstin ?? null, customerAddress: input.customerAddress ?? inv.customerAddress, dueAt: input.dueAt ?? null, notes: input.notes ?? null, terms: input.terms ?? null, ...this.head(calc), items: { create: this.itemRows(input.items, calc) } }, include: { items: { orderBy: { position: 'asc' } } } });
    });
  }

  /** Numbers run without gaps per prefix and financial year: taken under a lock, inside the same transaction as the issue. */
  @Post('invoices/:id/issue')
  @HttpCode(200)
  @RequirePermission(ISSUE)
  issue(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const inv = await this.find(tx, id, ISSUE);
      if (inv.status !== 'draft') throw new BadRequestException({ code: 'NOT_DRAFT', message: 'This invoice has already been issued' });
      if (inv.totalPaise <= 0) throw new BadRequestException({ code: 'ZERO_TOTAL', message: 'An invoice needs an amount' });
      const seller = await this.needProfile(tx, inv.workspaceId);
      const now = new Date();
      const fy = financialYear(now);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${tenantId()}:${seller.invoicePrefix}:${fy}`}))`;
      const series = await tx.invoiceSeries.upsert({ where: { tenantId_prefix_fy: { tenantId: tenantId(), prefix: seller.invoicePrefix, fy } }, create: { tenantId: tenantId(), prefix: seller.invoicePrefix, fy, next: 2 }, update: { next: { increment: 1 } } });
      const number = `${seller.invoicePrefix}/${fy}/${String(series.next - 1).padStart(4, '0')}`;
      // The bill is worked out again with today's billing details, then frozen.
      const items = inv.items.map((i) => ({ description: i.description, hsnSac: i.hsnSac, qty: i.qty, unitPaise: i.unitPaise, discountPaise: i.discountPaise, gstBp: i.gstBp }));
      const calc = this.totals(items, inv.placeOfSupply, seller);
      for (const [k, it] of inv.items.entries()) await tx.invoiceItem.update({ where: { id: it.id }, data: calc.lines[k] });
      const sellerSnapshot = { legalName: seller.legalName, gstin: seller.gstin, stateCode: seller.stateCode, address: seller.address, email: seller.email, phone: seller.phone, bankDetails: seller.bankDetails };
      const out = await tx.invoice.update({ where: { id }, data: { status: 'issued', number, fy, issuedAt: now, seller: sellerSnapshot, ...this.head(calc) }, include: { items: { orderBy: { position: 'asc' } } } });
      if (inv.customerGstin || inv.customerAddress) await tx.customer.update({ where: { id: inv.customerId }, data: { gstin: inv.customerGstin, billingAddress: inv.customerAddress, stateCode: inv.placeOfSupply } });
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: inv.leadId } });
      await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'payment', remark: `Invoice ${number} issued: ${money(out.totalPaise)}`, data: { invoiceId: id } }) });
      await this.db.audit(tx, { workspaceId: inv.workspaceId, entity: 'invoice', entityId: id, action: 'invoice.issued', newValue: { number, totalPaise: out.totalPaise, cgst: out.cgstPaise, sgst: out.sgstPaise, igst: out.igstPaise } });
      return out;
    });
  }

  @Post('invoices/:id/cancel')
  @HttpCode(200)
  @RequirePermission(ISSUE)
  cancel(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(Reason, body);
    return this.db.tenant(async (tx) => {
      const inv = await this.find(tx, id, ISSUE);
      if (inv.status === 'cancelled') throw new BadRequestException({ code: 'ALREADY_CANCELLED', message: 'This invoice is already cancelled' });
      if (inv.paidPaise > 0) throw new BadRequestException({ code: 'HAS_PAYMENTS', message: 'Void the payments on this invoice first' });
      if (await tx.paymentLink.count({ where: { invoiceId: id, status: 'created' } })) throw new BadRequestException({ code: 'OPEN_LINK', message: 'Cancel the open payment link first, so the customer cannot pay a cancelled invoice' });
      await tx.invoice.update({ where: { id }, data: { status: 'cancelled', cancelReason: reason, cancelledAt: new Date() } });
      await this.db.audit(tx, { workspaceId: inv.workspaceId, entity: 'invoice', entityId: id, action: 'invoice.cancelled', newValue: { number: inv.number, reason } });
      return { ok: true };
    });
  }

  /** Records money against an issued invoice. It also counts towards any process running on the lead. */
  @Post('invoices/:id/payments')
  @RequirePermission(WORK)
  pay(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Pay, body);
    return this.db.tenant(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-pay:${id}`}))`;
      const inv = await this.find(tx, id, WORK);
      if (inv.status !== 'issued') throw new BadRequestException({ code: 'NOT_ISSUED', message: 'Payments can only be recorded on an issued invoice' });
      const due = inv.totalPaise - inv.paidPaise;
      if (input.amountPaise > due) throw new BadRequestException({ code: 'TOO_MUCH', message: `Only ${money(due)} is due on this invoice` });
      const p = await recordInvoicePayment(tx, inv, { amountPaise: input.amountPaise, mode: input.mode, reference: input.reference ?? null, receivedAt: input.receivedAt ?? new Date(), userId: auth().userId, source: 'invoice' });
      await this.db.audit(tx, { workspaceId: inv.workspaceId, entity: 'payment', entityId: p.id, action: 'payment.recorded', newValue: { invoice: inv.number, amountPaise: p.amountPaise, mode: p.mode, reference: p.reference } });
      return p;
    });
  }

  private filter(view: string): Prisma.InvoiceWhereInput {
    const open = { status: 'issued' };
    if (view === 'draft') return { status: 'draft' };
    if (view === 'cancelled') return { status: 'cancelled' };
    if (view === 'unpaid') return { ...open, NOT: { paidPaise: { equals: this.db.app.invoice.fields.totalPaise } } };
    if (view === 'overdue') return { ...open, dueAt: { lt: new Date() }, NOT: { paidPaise: { equals: this.db.app.invoice.fields.totalPaise } } };
    if (view === 'paid') return { ...open, paidPaise: { equals: this.db.app.invoice.fields.totalPaise } };
    return {};
  }

  @Get('invoices')
  @RequirePermission(VIEW)
  list(@Query() query: unknown) {
    const q = parse(ListQ, query);
    return this.db.tenant(async (tx) => {
      const scope = { lead: await scopeFilter(tx, VIEW as never) };
      const search: Prisma.InvoiceWhereInput = q.q ? { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { customerName: { contains: q.q, mode: 'insensitive' } }] } : {};
      const rows = await tx.invoice.findMany({ where: { AND: [scope, this.filter(q.view), search] }, orderBy: { createdAt: 'desc' }, take: 300, select: { id: true, number: true, status: true, customerName: true, leadId: true, issuedAt: true, dueAt: true, totalPaise: true, paidPaise: true, createdAt: true } });
      const open = await tx.invoice.aggregate({ where: { AND: [scope, { status: 'issued' }] }, _sum: { totalPaise: true, paidPaise: true }, _count: true });
      const overdue = await tx.invoice.aggregate({ where: { AND: [scope, this.filter('overdue')] }, _sum: { totalPaise: true, paidPaise: true }, _count: true });
      return { rows, summary: { billedPaise: open._sum.totalPaise ?? 0, collectedPaise: open._sum.paidPaise ?? 0, overduePaise: (overdue._sum.totalPaise ?? 0) - (overdue._sum.paidPaise ?? 0), overdueCount: overdue._count }, canCreate: !!auth().permissions[WORK], canIssue: !!auth().permissions[ISSUE] };
    });
  }

  @Get('invoices/register.csv')
  @RequirePermission(VIEW)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="sales-register.csv"')
  register(@Query() query: unknown) {
    const q = parse(RegQ, query);
    return this.db.tenant(async (tx) => {
      const from = new Date(`${q.from}T00:00:00+05:30`), to = new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000);
      const rows = await tx.invoice.findMany({ where: { AND: [{ lead: await scopeFilter(tx, VIEW as never) }, { status: { in: ['issued', 'cancelled'] }, issuedAt: { gte: from, lt: to } }] }, orderBy: { issuedAt: 'asc' }, take: 50_000 });
      const head = ['Invoice no', 'Date (IST)', 'Customer', 'Customer GSTIN', 'Place of supply', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Round off', 'Invoice total', 'Status'];
      const lines = rows.map((r) => { const off = r.status === 'cancelled'; const a = (p: number) => rupees(off ? 0 : p); return [r.number, istDate(r.issuedAt!), r.customerName, r.customerGstin, `${r.placeOfSupply}-${GST_STATES[r.placeOfSupply] ?? ''}`, a(r.taxablePaise), a(r.cgstPaise), a(r.sgstPaise), a(r.igstPaise), a(r.roundOffPaise), a(r.totalPaise), off ? 'Cancelled' : 'Issued'].map(cell).join(','); });
      return [head.join(','), ...lines].join('\n');
    });
  }

  @Get('invoices/:id')
  @RequirePermission(VIEW)
  one(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const inv = await this.find(tx, id, VIEW);
      const [draftSeller, payments, c] = await Promise.all([
        this.profile(tx, inv.workspaceId),
        tx.payment.findMany({ where: { invoiceId: id }, orderBy: { receivedAt: 'asc' }, select: { id: true, amountPaise: true, mode: true, reference: true, receivedAt: true, isVoided: true, voidReason: true, receiptNumber: true } }),
        tx.customer.findUniqueOrThrow({ where: { id: inv.customerId }, select: { code: true, mobile: true, email: true, stateCode: true } }),
      ]);
      return { ...inv, sellerNow: inv.seller ?? draftSeller, payments, customer: c, organization: ctx().tenant?.name, states: GST_STATES, rates: GST_RATES_BP, canEdit: !!auth().permissions[WORK], canIssue: !!auth().permissions[ISSUE] };
    });
  }

  @Get('leads/:id/invoices')
  @RequirePermission(VIEW)
  forLead(@Param('id') id: string) {
    return this.db.tenant(async (tx) => tx.invoice.findMany({ where: { AND: [{ leadId: id }, { lead: await scopeFilter(tx, VIEW as never) }] }, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, status: true, totalPaise: true, paidPaise: true, quoteId: true } }));
  }
}
