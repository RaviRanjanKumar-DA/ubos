import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { istDate } from '../../common/ist';

const WORK = 'finance.expense.manage', PNL = 'finance.pnl.view';
const DEFAULTS = ['Salaries', 'Rent', 'Marketing and ads', 'Software and subscriptions', 'Travel', 'Telephone and internet', 'Professional fees', 'Office expenses', 'Bank charges', 'Other'];
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body_ = z.object({
  categoryId: z.string().uuid(), spentOn: Day, amountPaise: z.number().int().min(1).max(10_000_000_000), gstPaise: z.number().int().min(0).default(0), vendor: z.string().trim().max(120).nullable().optional(), description: z.string().trim().min(2).max(300),
  mode: z.enum(['cash', 'upi', 'card', 'bank', 'cheque', 'online']).default('bank'), reference: z.string().trim().max(80).nullable().optional(), orgWide: z.boolean().default(false),
}).refine((e) => e.gstPaise <= e.amountPaise, { message: 'GST cannot be more than the amount', path: ['gstPaise'] });
const Range = z.object({ from: Day, to: Day });
const List = Range.extend({ categoryId: z.string().uuid().optional(), q: z.string().trim().max(80).optional() });
const Pnl = Range.extend({ basis: z.enum(['invoiced', 'received']).default('invoiced') });
const Reason = z.object({ reason: z.string().trim().min(3).max(300) });

const start = (d: string) => new Date(`${d}T00:00:00+05:30`);
const endExcl = (d: string) => new Date(start(d).getTime() + 86_400_000);
const noon = (d: string) => new Date(`${d}T12:00:00+05:30`);
const rupees = (p: number) => (p / 100).toFixed(2);
const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const checkRange = (from: string, to: string) => {
  if (from > to) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'The start date is after the end date' });
  if (endExcl(to).getTime() - start(from).getTime() > 3 * 366 * 86_400_000) throw new BadRequestException({ code: 'RANGE_TOO_LONG', message: 'Choose up to 3 years' });
};

/** Which business lines this person may see, and whether organization-wide costs are included. */
function reach(perm: string) {
  const a = auth();
  const scope = a.permissions[perm as never] as string | undefined;
  const wide = scope === 'ORGANIZATION';
  if (a.workspaceId) return { workspaces: [a.workspaceId], orgWide: false, wide };
  return { workspaces: a.accessibleWorkspaceIds, orgWide: wide, wide };
}

/** Costs by category and business line, and profit and loss against them. Nothing is deleted: a wrong entry is voided with a reason. */
@Controller('api/v1')
@RequireFeature('module.finance')
export class ExpensesController {
  constructor(private db: DbService) {}

  private where(perm: string): Prisma.ExpenseWhereInput {
    const r = reach(perm);
    return { OR: [{ workspaceId: { in: r.workspaces } }, ...(r.orgWide ? [{ workspaceId: null }] : [])] };
  }

  private async categories(tx: Tx) {
    if (!(await tx.expenseCategory.count())) await tx.expenseCategory.createMany({ data: DEFAULTS.map((name) => ({ tenantId: tenantId(), name })), skipDuplicates: true });
    return tx.expenseCategory.findMany({ where: { isArchived: false }, orderBy: { name: 'asc' } });
  }

  @Get('expense-categories')
  @RequirePermission(WORK)
  listCategories() { return this.db.tenant((tx) => this.categories(tx)); }

  @Post('expense-categories')
  @RequirePermission(WORK)
  addCategory(@Body() body: unknown) {
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(60) }), body);
    return this.db.tenant(async (tx) => {
      const old = await tx.expenseCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
      if (old && !old.isArchived) throw new BadRequestException({ code: 'DUPLICATE', message: 'That category already exists' });
      if (old) return tx.expenseCategory.update({ where: { id: old.id }, data: { isArchived: false } });
      return tx.expenseCategory.create({ data: { tenantId: tenantId(), name } });
    });
  }

  @Patch('expense-categories/:id')
  @RequirePermission(WORK)
  archiveCategory(@Param('id') id: string, @Body() body: unknown) {
    const { isArchived } = parse(z.object({ isArchived: z.boolean() }), body);
    return this.db.tenant(async (tx) => {
      if (!(await tx.expenseCategory.findUnique({ where: { id } }))) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Category not found' });
      return tx.expenseCategory.update({ where: { id }, data: { isArchived } });
    });
  }

  private target(input: z.infer<typeof Body_>) {
    const a = auth();
    if (input.orgWide) {
      if (a.permissions[WORK as never] !== 'ORGANIZATION') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only organization admins can record organization-wide costs' });
      return null;
    }
    if (!a.workspaceId) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line, or mark this as organization-wide' });
    return a.workspaceId;
  }
  private async category(tx: Tx, id: string) {
    if (!(await tx.expenseCategory.findFirst({ where: { id, isArchived: false } }))) throw new BadRequestException({ code: 'CATEGORY_NOT_FOUND', message: 'Choose a category' });
  }
  private fields(input: z.infer<typeof Body_>) {
    return { categoryId: input.categoryId, spentAt: noon(input.spentOn), amountPaise: input.amountPaise, gstPaise: input.gstPaise, vendor: input.vendor ?? null, description: input.description, mode: input.mode, reference: input.reference ?? null };
  }

  @Post('expenses')
  @RequirePermission(WORK)
  create(@Body() body: unknown) {
    const input = parse(Body_, body);
    const workspaceId = this.target(input);
    return this.db.tenant(async (tx) => {
      await this.category(tx, input.categoryId);
      const e = await tx.expense.create({ data: { ...this.fields(input), tenantId: tenantId(), workspaceId, createdById: auth().userId } });
      await this.db.audit(tx, { workspaceId, entity: 'expense', entityId: e.id, action: 'expense.recorded', newValue: { amountPaise: e.amountPaise, description: e.description } });
      return e;
    });
  }

  private async own(tx: Tx, id: string) {
    const e = await tx.expense.findFirst({ where: { AND: [{ id }, this.where(WORK)] } });
    if (!e) throw new NotFoundException({ code: 'EXPENSE_NOT_FOUND', message: 'Expense not found' });
    return e;
  }

  @Put('expenses/:id')
  @RequirePermission(WORK)
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Body_, body);
    return this.db.tenant(async (tx) => {
      const before = await this.own(tx, id);
      if (before.isVoided) throw new BadRequestException({ code: 'VOIDED', message: 'A voided expense cannot be changed' });
      await this.category(tx, input.categoryId);
      const e = await tx.expense.update({ where: { id }, data: this.fields(input) });
      await this.db.audit(tx, { workspaceId: e.workspaceId, entity: 'expense', entityId: id, action: 'expense.updated', oldValue: { amountPaise: before.amountPaise, description: before.description }, newValue: { amountPaise: e.amountPaise, description: e.description } });
      return e;
    });
  }

  @Post('expenses/:id/void')
  @HttpCode(200)
  @RequirePermission(WORK)
  void(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(Reason, body);
    return this.db.tenant(async (tx) => {
      const e = await this.own(tx, id);
      if (e.isVoided) throw new BadRequestException({ code: 'ALREADY_VOIDED', message: 'This expense is already voided' });
      await tx.expense.update({ where: { id }, data: { isVoided: true, voidReason: reason } });
      await this.db.audit(tx, { workspaceId: e.workspaceId, entity: 'expense', entityId: id, action: 'expense.voided', oldValue: { amountPaise: e.amountPaise }, newValue: { reason } });
      return { ok: true };
    });
  }

  private async rows(tx: Tx, q: z.infer<typeof List>) {
    checkRange(q.from, q.to);
    return tx.expense.findMany({
      where: { AND: [this.where(WORK), { spentAt: { gte: start(q.from), lt: endExcl(q.to) } }, q.categoryId ? { categoryId: q.categoryId } : {}, q.q ? { OR: [{ description: { contains: q.q, mode: 'insensitive' } }, { vendor: { contains: q.q, mode: 'insensitive' } }] } : {}] },
      orderBy: { spentAt: 'desc' }, take: 5000, include: { category: { select: { name: true } } },
    });
  }

  @Get('expenses')
  @RequirePermission(WORK)
  list(@Query() query: unknown) {
    const q = parse(List, query);
    return this.db.tenant(async (tx) => {
      const rows = await this.rows(tx, q);
      const live = rows.filter((r) => !r.isVoided);
      return { rows, totalPaise: live.reduce((s, r) => s + r.amountPaise, 0), gstPaise: live.reduce((s, r) => s + r.gstPaise, 0), canOrgWide: auth().permissions[WORK as never] === 'ORGANIZATION' };
    });
  }

  @Get('expenses.csv')
  @RequirePermission(WORK)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="expenses.csv"')
  csv(@Query() query: unknown) {
    const q = parse(List, query);
    return this.db.tenant(async (tx) => {
      const rows = (await this.rows(tx, q)).filter((r) => !r.isVoided);
      return [['Date (IST)', 'Category', 'Description', 'Vendor', 'Amount', 'GST included', 'Paid by', 'Reference'].join(','), ...rows.map((r) => [istDate(r.spentAt), r.category.name, r.description, r.vendor, rupees(r.amountPaise), rupees(r.gstPaise), r.mode, r.reference].map(cell).join(','))].join('\n');
    });
  }

  /** Costs are counted net of GST that can usually be claimed back. Income is before GST on the invoiced basis. */
  private async pnl(tx: Tx, q: z.infer<typeof Pnl>) {
    checkRange(q.from, q.to);
    const r = reach(PNL);
    const span = { gte: start(q.from), lt: endExcl(q.to) };
    const income: { at: Date; workspaceId: string; paise: number }[] = q.basis === 'invoiced'
      ? (await tx.invoice.findMany({ where: { workspaceId: { in: r.workspaces }, status: 'issued', issuedAt: span }, select: { issuedAt: true, workspaceId: true, taxablePaise: true } })).map((i) => ({ at: i.issuedAt!, workspaceId: i.workspaceId, paise: i.taxablePaise }))
      : (await tx.payment.findMany({ where: { workspaceId: { in: r.workspaces }, isVoided: false, receivedAt: span }, select: { receivedAt: true, workspaceId: true, amountPaise: true } })).map((p) => ({ at: p.receivedAt, workspaceId: p.workspaceId, paise: p.amountPaise }));
    const costs = await tx.expense.findMany({ where: { isVoided: false, spentAt: span, OR: [{ workspaceId: { in: r.workspaces } }, ...(r.orgWide ? [{ workspaceId: null }] : [])] }, include: { category: { select: { name: true } } } });
    const net = (e: { amountPaise: number; gstPaise: number }) => e.amountPaise - e.gstPaise;
    const months = new Map<string, { month: string; incomePaise: number; expensePaise: number }>();
    const m = (d: Date) => { const k = istDate(d).slice(0, 7); if (!months.has(k)) months.set(k, { month: k, incomePaise: 0, expensePaise: 0 }); return months.get(k)!; };
    for (const i of income) m(i.at).incomePaise += i.paise;
    for (const c of costs) m(c.spentAt).expensePaise += net(c);
    const names = new Map((await tx.workspace.findMany({ where: { id: { in: r.workspaces } }, select: { id: true, name: true } })).map((w) => [w.id, w.name]));
    const lines = new Map<string, { id: string | null; name: string; incomePaise: number; expensePaise: number }>();
    const l = (id: string | null) => { const k = id ?? 'org'; if (!lines.has(k)) lines.set(k, { id, name: id ? names.get(id) ?? 'Business line' : 'Organization-wide', incomePaise: 0, expensePaise: 0 }); return lines.get(k)!; };
    for (const i of income) l(i.workspaceId).incomePaise += i.paise;
    for (const c of costs) l(c.workspaceId).expensePaise += net(c);
    const cats = new Map<string, number>();
    for (const c of costs) cats.set(c.category.name, (cats.get(c.category.name) ?? 0) + net(c));
    const incomePaise = income.reduce((s, i) => s + i.paise, 0), expensePaise = costs.reduce((s, c) => s + net(c), 0);
    const withProfit = <T extends { incomePaise: number; expensePaise: number }>(x: T) => ({ ...x, profitPaise: x.incomePaise - x.expensePaise });
    return {
      basis: q.basis, incomePaise, expensePaise, profitPaise: incomePaise - expensePaise, marginPct: incomePaise > 0 ? Math.round(((incomePaise - expensePaise) / incomePaise) * 1000) / 10 : null,
      months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map(withProfit),
      businessLines: [...lines.values()].sort((a, b) => b.incomePaise - a.incomePaise).map(withProfit),
      categories: [...cats.entries()].map(([name, paise]) => ({ name, paise })).sort((a, b) => b.paise - a.paise),
    };
  }

  @Get('pnl')
  @RequirePermission(PNL)
  profit(@Query() query: unknown) {
    const q = parse(Pnl, query);
    return this.db.tenant((tx) => this.pnl(tx, q));
  }

  @Get('pnl.csv')
  @RequirePermission(PNL)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="profit-and-loss.csv"')
  profitCsv(@Query() query: unknown) {
    const q = parse(Pnl, query);
    return this.db.tenant(async (tx) => {
      const p = await this.pnl(tx, q);
      return [['Month', 'Income', 'Expenses', 'Profit'].join(','), ...p.months.map((m) => [m.month, rupees(m.incomePaise), rupees(m.expensePaise), rupees(m.profitPaise)].join(',')), ['Total', rupees(p.incomePaise), rupees(p.expensePaise), rupees(p.profitPaise)].join(',')].join('\n');
    });
  }
}
