import { BadRequestException, Body, ConflictException, Controller, Get, Header, HttpCode, Injectable, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { accessDaysLeft, accessEndOfDate, accessExpiry, accessReminderStage, accessState, renewedExpiry, type AccessState } from '@ubos/shared';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { istDate } from '../../common/ist';
import { activity } from '../../common/lead-ops';
import { intakeLead } from '../../common/lead-intake';
import { notify } from '../../common/notify';
import { scopeFilter } from '../../common/scope';
import { decrypt, encrypt } from '../../auth/crypto';
import { Mailer } from '../../auth/mailer';

const VIEW = 'crm.access.view', WORK = 'crm.access.manage';
const IST_TIME = 'Asia/Kolkata';
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Grant = z.object({
  customerId: z.string().uuid(), packageId: z.string().uuid(), leadId: z.string().uuid().nullable().optional(), startsOn: Day.optional(), validityDays: z.number().int().min(1).max(3660).nullable().optional(), expiresOn: Day.nullable().optional(),
  licenceKey: z.string().trim().min(1).max(500).nullable().optional(), notes: z.string().trim().max(500).nullable().optional(),
});
const Edit = z.object({ expiresOn: Day.nullable().optional(), licenceKey: z.string().trim().min(1).max(500).nullable().optional(), notes: z.string().trim().max(500).nullable().optional() });
const Renew = z.object({ days: z.number().int().min(1).max(3660).optional(), expiresOn: Day.optional() });
const Reason = z.object({ reason: z.string().trim().min(3).max(300) });
const List = z.object({ state: z.enum(['lifetime', 'active', 'expiring', 'expired', 'revoked']).optional(), q: z.string().trim().max(80).optional(), customerId: z.string().uuid().optional() });

const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const longDate = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: IST_TIME, day: 'numeric', month: 'short', year: 'numeric' });
const reach = () => { const a = auth(); return a.workspaceId ? [a.workspaceId] : a.accessibleWorkspaceIds; };
const INCLUDE = { package: { select: { id: true, name: true, accessKind: true, validityDays: true } }, customer: { select: { id: true, code: true, name: true, mobile: true } } } satisfies Prisma.CustomerAccessInclude;
type Row = Prisma.CustomerAccessGetPayload<{ include: typeof INCLUDE }>;

function view(r: Row, now: Date) {
  const { licenceEncrypted, ...rest } = r;
  return { ...rest, hasLicence: !!licenceEncrypted, state: accessState(r, now), daysLeft: r.expiresAt ? accessDaysLeft(r.expiresAt, now) : null };
}

/** Moves each access through its reminder stages once, opening one renewal lead when the renewal window starts. */
@Injectable()
export class AccessReminders {
  constructor(private db: DbService, private mailer: Mailer) {}

  async run(tenantName: string, force: boolean) {
    const now = new Date();
    const hour = Number(now.toLocaleString('en-GB', { timeZone: IST_TIME, hour: '2-digit', hour12: false }));
    if (!force && hour < 9) return 0;
    const rows = await this.db.tenant((tx) => tx.customerAccess.findMany({ where: { status: 'active', expiresAt: { not: null, lte: new Date(now.getTime() + 190 * 86_400_000) }, reminderStage: { lt: 3 } }, include: { package: true, customer: true }, take: 3000 }));
    let done = 0;
    for (const r of rows) {
      const left = accessDaysLeft(r.expiresAt!, now);
      const stage = accessReminderStage(left, r.package.renewBeforeDays);
      if (stage <= r.reminderStage) continue;
      const mail = await this.db.tenant(async (tx) => {
        const claimed = await tx.customerAccess.updateMany({ where: { id: r.id, reminderStage: r.reminderStage }, data: { reminderStage: stage } });
        if (!claimed.count || left < -60) return null; // long lapsed when it was entered: nothing useful to chase
        const end = longDate(r.expiresAt!);
        const what = left < 0 ? `expired on ${end}` : left === 0 ? 'expires today' : `expires on ${end}`;
        let renewalLeadId = r.renewalLeadId;
        if (!renewalLeadId) {
          const out = await intakeLead(tx, tenantId(), r.workspaceId, { name: r.customer.name, mobile: r.customer.mobile, email: r.customer.email, source: 'renewal', remark: `Renewal due: ${r.package.name} ${what}` }, 'add_remark', 'renewal');
          renewalLeadId = out.leadId;
          if (renewalLeadId) await tx.customerAccess.update({ where: { id: r.id }, data: { renewalLeadId } });
        }
        const leads = await tx.lead.findMany({ where: { id: { in: [renewalLeadId, r.leadId].filter(Boolean) as string[] } }, select: { ownerId: true } });
        const ids = [...new Set([...leads.map((l) => l.ownerId), r.createdById].filter(Boolean) as string[])];
        await notify(tx, ids, { type: 'reminder', title: `${r.package.name} ${what}`, body: `${r.customer.name} (${r.customer.code})`, link: renewalLeadId ? `/app/leads/${renewalLeadId}` : '/app/access' });
        if (!r.package.remindCustomer || !r.customer.email || r.customer.emailOptOut) return null;
        return { to: r.customer.email, subject: `Your ${r.package.name} ${what}`, text: [`Hello ${r.customer.name},`, '', `Your ${r.package.name} ${what}. Please contact us to renew it.`, '', 'Thank you,', tenantName].join('\n') };
      });
      done++;
      if (mail) await this.mailer.send(mail.to, mail.subject, mail.text).catch(() => undefined);
    }
    return done;
  }
}

/** Who has which course, software or service, until when. Access is revoked, never deleted. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class AccessController {
  constructor(private db: DbService) {}

  private async where(tx: Tx, perm: string, customerId?: string): Promise<Prisma.CustomerAccessWhereInput> {
    const scope = auth().permissions[perm as never] as string | undefined;
    const narrow = scope === 'OWN' || scope === 'TEAM';
    return { AND: [{ workspaceId: { in: reach() } }, customerId ? { customerId } : {}, narrow ? { customer: { leads: { some: await scopeFilter(tx, perm as never) } } } : {}] };
  }

  private async one(tx: Tx, id: string, perm: string) {
    const r = await tx.customerAccess.findFirst({ where: { AND: [{ id }, await this.where(tx, perm)] }, include: INCLUDE });
    if (!r) throw new NotFoundException({ code: 'ACCESS_NOT_FOUND', message: 'Access record not found' });
    return r;
  }

  private async rows(tx: Tx, q: z.infer<typeof List>) {
    const text = q.q ? { OR: [{ customer: { name: { contains: q.q, mode: 'insensitive' as const } } }, { customer: { mobile: { contains: q.q } } }, { package: { name: { contains: q.q, mode: 'insensitive' as const } } }] } : {};
    return tx.customerAccess.findMany({ where: { AND: [await this.where(tx, VIEW, q.customerId), text] }, orderBy: [{ expiresAt: 'asc' }, { createdAt: 'desc' }], include: INCLUDE, take: 5000 });
  }

  @Get('access')
  @RequirePermission(VIEW)
  list(@Query() query: unknown) {
    const q = parse(List, query);
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const all = (await this.rows(tx, q)).map((r) => view(r, now));
      const counts = { lifetime: 0, active: 0, expiring: 0, expired: 0, revoked: 0 } as Record<AccessState, number>;
      for (const r of all) counts[r.state]++;
      return { rows: q.state ? all.filter((r) => r.state === q.state) : all, counts };
    });
  }

  @Get('access.csv')
  @RequirePermission(VIEW)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="access.csv"')
  csv(@Query() query: unknown) {
    const q = parse(List, query);
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const rows = (await this.rows(tx, q)).map((r) => view(r, now)).filter((r) => !q.state || r.state === q.state);
      return [['Customer', 'Code', 'Mobile', 'Product', 'Starts (IST)', 'Ends (IST)', 'State'].join(','), ...rows.map((r) => [r.customer.name, r.customer.code, r.customer.mobile, r.package.name, istDate(r.startsAt), r.expiresAt ? istDate(r.expiresAt) : 'No end date', r.state].map(cell).join(','))].join('\n');
    });
  }

  @Post('access')
  @RequirePermission(WORK)
  grant(@Body() body: unknown) {
    const input = parse(Grant, body);
    return this.db.tenant(async (tx) => {
      const p = await tx.package.findFirst({ where: { id: input.packageId, workspaceId: { in: reach() }, isArchived: false } });
      if (!p) throw new BadRequestException({ code: 'INVALID_PRODUCT', message: 'Choose a product of this business line' });
      if (p.accessKind === 'none') throw new BadRequestException({ code: 'NOT_AN_ACCESS_PRODUCT', message: 'This product does not give access. Set its access type in Products first' });
      const c = await tx.customer.findFirst({ where: { id: input.customerId, mergedIntoId: null } });
      if (!c) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
      if (input.leadId && !(await tx.lead.findFirst({ where: { id: input.leadId, customerId: c.id } }))) throw new BadRequestException({ code: 'INVALID_LEAD', message: 'That lead belongs to someone else' });
      const now = new Date();
      const current = await tx.customerAccess.findMany({ where: { customerId: c.id, packageId: p.id, status: 'active' } });
      if (current.some((a) => accessState(a, now) !== 'expired')) throw new ConflictException({ code: 'ALREADY_ACTIVE', message: 'This customer already has this access. Renew it instead' });
      const startsAt = input.startsOn ? new Date(`${input.startsOn}T00:00:00+05:30`) : now;
      const days = input.validityDays ?? p.validityDays;
      const expiresAt = input.expiresOn ? accessEndOfDate(input.expiresOn) : days ? accessExpiry(startsAt, days) : null;
      if (expiresAt && expiresAt <= startsAt) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'The end date is before the start date' });
      const key = input.licenceKey ?? null;
      const r = await tx.customerAccess.create({ data: { tenantId: tenantId(), workspaceId: p.workspaceId, customerId: c.id, packageId: p.id, leadId: input.leadId ?? null, startsAt, expiresAt, licenceEncrypted: key ? encrypt(key) : null, licenceLast4: key ? key.slice(-4) : null, notes: input.notes ?? null, createdById: auth().userId }, include: INCLUDE });
      await this.note(tx, r.leadId, `Access given: ${p.name}${expiresAt ? ` until ${longDate(expiresAt)}` : ''}`);
      await this.db.audit(tx, { workspaceId: p.workspaceId, entity: 'access', entityId: r.id, action: 'access.granted', newValue: { customerId: c.id, product: p.name, expiresAt, hasLicence: !!key } });
      return view(r, now);
    });
  }

  private async note(tx: Tx, leadId: string | null, remark: string) {
    if (!leadId) return;
    const lead = await tx.lead.findUnique({ where: { id: leadId } });
    if (lead) await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'note', remark }) });
  }

  @Put('access/:id')
  @RequirePermission(WORK)
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Edit, body);
    return this.db.tenant(async (tx) => {
      const before = await this.one(tx, id, WORK);
      const data: Prisma.CustomerAccessUpdateInput = {};
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.licenceKey !== undefined) { const k = input.licenceKey; data.licenceEncrypted = k ? encrypt(k) : null; data.licenceLast4 = k ? k.slice(-4) : null; }
      if (input.expiresOn !== undefined) {
        const expiresAt = input.expiresOn ? accessEndOfDate(input.expiresOn) : null;
        if (expiresAt && expiresAt <= before.startsAt) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'The end date is before the start date' });
        data.expiresAt = expiresAt;
        if (!before.expiresAt || !expiresAt || expiresAt > before.expiresAt) { data.reminderStage = 0; data.renewalLeadId = null; }
      }
      const r = await tx.customerAccess.update({ where: { id }, data, include: INCLUDE });
      await this.db.audit(tx, { workspaceId: r.workspaceId, entity: 'access', entityId: id, action: 'access.updated', oldValue: { expiresAt: before.expiresAt }, newValue: { expiresAt: r.expiresAt, licenceChanged: input.licenceKey !== undefined } });
      return view(r, new Date());
    });
  }

  @Post('access/:id/renew')
  @HttpCode(200)
  @RequirePermission(WORK)
  renew(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Renew, body);
    return this.db.tenant(async (tx) => {
      const before = await this.one(tx, id, WORK);
      if (before.status === 'revoked') throw new BadRequestException({ code: 'REVOKED', message: 'Restore this access before renewing it' });
      const now = new Date();
      const days = input.days ?? before.package.validityDays;
      if (!input.expiresOn && !days) throw new BadRequestException({ code: 'DAYS_REQUIRED', message: 'Enter how many days to add' });
      const expiresAt = input.expiresOn ? accessEndOfDate(input.expiresOn) : renewedExpiry(before.expiresAt, days!, now);
      if (expiresAt <= now) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'Choose an end date in the future' });
      const r = await tx.customerAccess.update({ where: { id }, data: { expiresAt, renewedAt: now, reminderStage: 0, renewalLeadId: null }, include: INCLUDE });
      await this.note(tx, before.renewalLeadId ?? before.leadId, `Renewed: ${before.package.name} until ${longDate(expiresAt)}`);
      await this.db.audit(tx, { workspaceId: r.workspaceId, entity: 'access', entityId: id, action: 'access.renewed', oldValue: { expiresAt: before.expiresAt }, newValue: { expiresAt } });
      return view(r, now);
    });
  }

  @Post('access/:id/revoke')
  @HttpCode(200)
  @RequirePermission(WORK)
  revoke(@Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(Reason, body);
    return this.db.tenant(async (tx) => {
      const before = await this.one(tx, id, WORK);
      if (before.status === 'revoked') throw new BadRequestException({ code: 'ALREADY_REVOKED', message: 'This access is already revoked' });
      await tx.customerAccess.update({ where: { id }, data: { status: 'revoked', revokeReason: reason } });
      await this.db.audit(tx, { workspaceId: before.workspaceId, entity: 'access', entityId: id, action: 'access.revoked', newValue: { reason } });
      return { ok: true };
    });
  }

  @Post('access/:id/restore')
  @HttpCode(200)
  @RequirePermission(WORK)
  restore(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const before = await this.one(tx, id, WORK);
      if (before.status !== 'revoked') throw new BadRequestException({ code: 'NOT_REVOKED', message: 'This access is not revoked' });
      await tx.customerAccess.update({ where: { id }, data: { status: 'active', revokeReason: null } });
      await this.db.audit(tx, { workspaceId: before.workspaceId, entity: 'access', entityId: id, action: 'access.restored', newValue: {} });
      return { ok: true };
    });
  }

  /** The key itself is never listed or audited; each look at it is recorded. */
  @Post('access/:id/licence')
  @HttpCode(200)
  @RequirePermission(WORK)
  licence(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.one(tx, id, WORK);
      if (!r.licenceEncrypted) throw new NotFoundException({ code: 'NO_LICENCE', message: 'No licence key was saved' });
      await this.db.audit(tx, { workspaceId: r.workspaceId, entity: 'access', entityId: id, action: 'access.licence_viewed', newValue: {} });
      return { licenceKey: decrypt(r.licenceEncrypted) };
    });
  }
}
