import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  DEFAULT_ATTENDANCE, DEFAULT_DOC_TYPES, DEFAULT_EXIT, DEFAULT_LEAVE_TYPES, DEFAULT_ONBOARDING, addDays, dayStatus, daysBetween, entitlement, isDay, isWeeklyOff, istClock, istInstant, istToday, leaveDays, leaveYear, monthDays, monthTotals, toCsv,
  type AttendanceSettings, type DayResult,
} from '@ubos/shared';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { notify } from '../../common/notify';
import { reach } from './hr.controller';

const VIEW = 'hr.attendance.view', FIX = 'hr.attendance.manage', APPROVE = 'hr.leave.approve', LEAVE = 'hr.leave.manage';
const Day = z.string().refine(isDay, 'Enter a date');
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 09:30');
const Geo = z.object({ lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() });
const Apply = z.object({ leaveTypeId: z.string().uuid(), fromOn: Day, toOn: Day, halfDay: z.boolean().default(false), reason: z.string().trim().max(500).optional() });
const Correction = z.object({ day: Day, checkIn: Time, checkOut: Time, reason: z.string().trim().min(3).max(300) });
const Decide = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() });
const Settings = z.object({
  workStart: Time, workEnd: Time, graceMinutes: z.number().int().min(0).max(240), halfDayHours: z.number().min(0.5).max(12), fullDayHours: z.number().min(1).max(16),
  weeklyOff: z.array(z.number().int().min(0).max(6)).max(6), saturdayOff: z.enum(['none', '2nd_4th', '1st_3rd', 'alternate']), requireLocation: z.boolean(), leaveYearStartMonth: z.number().int().min(1).max(12),
}).refine((s) => s.halfDayHours < s.fullDayHours, { message: 'Half-day hours must be less than full-day hours' }).refine((s) => s.workStart < s.workEnd, { message: 'The shift must end after it starts' });
const TypeBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Use up to 8 letters or digits'), name: z.string().trim().min(2).max(60), isPaid: z.boolean(), yearlyDays: z.number().min(0).max(366).multipleOf(0.5),
  accrual: z.enum(['yearly', 'monthly']), carryForwardMax: z.number().min(0).max(366).multipleOf(0.5), allowHalfDay: z.boolean(), allowNegative: z.boolean(),
});
const Adjust = z.object({ employeeId: z.string().uuid(), leaveTypeId: z.string().uuid(), days: z.number().min(-366).max(366).multipleOf(0.5).refine((n) => n !== 0, 'Enter the days to add or take away'), reason: z.string().trim().min(3).max(300) });
const DayEdit = z.object({ checkIn: Time.nullable().optional(), checkOut: Time.nullable().optional(), override: z.enum(['present', 'half_day', 'absent', 'on_duty']).nullable().optional(), note: z.string().trim().max(300).nullable().optional() });

const noon = (d: string) => istInstant(d, '12:00');
const ymd = (d: Date) => istClock(d).day;
const bad = (code: string, message: string, extra: object = {}) => new BadRequestException({ code, message, ...extra });
const SETTING_KEYS = Object.keys(DEFAULT_ATTENDANCE) as (keyof AttendanceSettings)[];

async function attendanceSettings(tx: Tx): Promise<AttendanceSettings> {
  const s = (await tx.hrSetting.findUnique({ where: { tenantId: tenantId() } }))?.attendance as Partial<AttendanceSettings> | null;
  return { ...DEFAULT_ATTENDANCE, ...Object.fromEntries(SETTING_KEYS.filter((k) => s?.[k] !== undefined).map((k) => [k, s![k]])) };
}

/** Leave types, created from the defaults the first time anyone looks. */
async function leaveTypes(tx: Tx, withArchived = false) {
  if (!(await tx.leaveType.count())) {
    await tx.leaveType.createMany({ data: DEFAULT_LEAVE_TYPES.map((t, i) => ({ tenantId: tenantId(), ...t, position: i })), skipDuplicates: true });
  }
  return tx.leaveType.findMany({ where: withArchived ? {} : { isArchived: false }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
}

async function holidays(tx: Tx, from: string, to: string) {
  const rows = await tx.holiday.findMany({ where: { isArchived: false, day: { gte: from, lte: to } }, orderBy: { day: 'asc' } });
  return new Map(rows.map((h) => [h.day, h.name]));
}

type Emp = { id: string; name: string; employeeCode: string; joiningDate: Date; exitDate: Date | null; status: string; userId: string | null };
const EMP = { id: true, name: true, employeeCode: true, joiningDate: true, exitDate: true, status: true, userId: true } satisfies Prisma.EmployeeSelect;

/** Leave balances for the leave year that contains `asOf`. Earned leave carries forward (up to the type's limit) from earlier years. */
async function balances(tx: Tx, emp: Emp, asOf: string, s: AttendanceSettings) {
  const types = await leaveTypes(tx);
  const [reqs, adj] = await Promise.all([
    tx.leaveRequest.findMany({ where: { employeeId: emp.id, status: { in: ['pending', 'approved'] } }, select: { leaveTypeId: true, fromDate: true, days: true, status: true } }),
    tx.leaveAdjustment.findMany({ where: { employeeId: emp.id }, select: { leaveTypeId: true, year: true, days: true } }),
  ]);
  const joining = ymd(emp.joiningDate);
  const yearOf = (d: Date) => leaveYear(ymd(d), s.leaveYearStartMonth).label;
  const rangeOf = (label: number) => leaveYear(`${label}-${String(s.leaveYearStartMonth).padStart(2, '0')}-01`, s.leaveYearStartMonth);
  const sum = (xs: { days: number }[]) => xs.reduce((a, x) => a + x.days, 0);
  const current = leaveYear(asOf, s.leaveYearStartMonth);
  return types.map((t) => {
    const used = (label: number, status = 'approved') => sum(reqs.filter((r) => r.leaveTypeId === t.id && r.status === status && yearOf(r.fromDate) === label));
    const adjusted = (label: number) => sum(adj.filter((a) => a.leaveTypeId === t.id && a.year === label));
    const carry = (label: number, depth: number): number => {
      const range = rangeOf(label);
      if (t.carryForwardMax <= 0 || depth > 5 || joining >= range.from) return 0;
      const prev = rangeOf(label - 1);
      const closing = entitlement(t, prev, joining, prev.to) + carry(label - 1, depth + 1) + adjusted(label - 1) - used(label - 1);
      return Math.min(t.carryForwardMax, Math.max(0, closing));
    };
    const earned = entitlement(t, current, joining, asOf);
    const carried = carry(current.label, 0);
    const taken = used(current.label), pending = used(current.label, 'pending'), adjustment = adjusted(current.label);
    return { leaveTypeId: t.id, code: t.code, name: t.name, isPaid: t.isPaid, allowHalfDay: t.allowHalfDay, unlimited: t.allowNegative, year: current.label, earned, carried, adjustment, taken, pending, available: earned + carried + adjustment - taken - pending };
  });
}

type DayRow = DayResult & { day: string; checkInAt: Date | null; checkOutAt: Date | null; override: string | null; note: string | null; holiday: string | null; leaveCode: string | null; leavePaid?: boolean };

/** Every day of a month for some employees, worked out from check-ins, approved leave, holidays and weekly offs. */
async function monthRows(tx: Tx, emps: Emp[], month: string, s: AttendanceSettings) {
  const days = monthDays(month), from = days[0], to = days[days.length - 1], today = istToday();
  const ids = emps.map((e) => e.id);
  const [hol, records, leaves] = await Promise.all([
    holidays(tx, from, to),
    tx.attendance.findMany({ where: { employeeId: { in: ids }, day: { gte: from, lte: to } } }),
    tx.leaveRequest.findMany({ where: { employeeId: { in: ids }, status: 'approved', fromDate: { lte: noon(to) }, toDate: { gte: noon(from) } }, include: { type: { select: { code: true, isPaid: true } } } }),
  ]);
  const out = new Map<string, DayRow[]>();
  for (const e of emps) {
    const join = ymd(e.joiningDate), exit = e.exitDate ? ymd(e.exitDate) : null;
    const onLeave = new Map<string, { part: 0.5 | 1; paid: boolean; code: string }>();
    for (const l of leaves.filter((x) => x.employeeId === e.id)) {
      for (let d = ymd(l.fromDate); d <= ymd(l.toDate); d = addDays(d, 1)) if (!isWeeklyOff(d, s) && !hol.has(d)) onLeave.set(d, { part: l.halfDay ? 0.5 : 1, paid: l.type?.isPaid ?? true, code: l.type?.code ?? l.leaveType });
    }
    const rec = new Map(records.filter((r) => r.employeeId === e.id).map((r) => [r.day, r]));
    out.set(e.id, days.map((d) => {
      const r = rec.get(d), lv = onLeave.get(d);
      const res = dayStatus({ day: d, today, settings: s, checkInAt: r?.checkInAt, checkOutAt: r?.checkOutAt, override: r?.override, holiday: hol.has(d), leave: lv?.part ?? 0, leavePaid: lv?.paid, employed: d >= join && (!exit || d <= exit) });
      return { ...res, day: d, checkInAt: r?.checkInAt ?? null, checkOutAt: r?.checkOutAt ?? null, override: r?.override ?? null, note: r?.note ?? null, holiday: hol.get(d) ?? null, leaveCode: lv?.code ?? null, leavePaid: lv?.paid };
    }));
  }
  return out;
}

/** Totals only count days up to today, so the current month reads "so far". */
const totals = (rows: DayRow[]) => monthTotals(rows.filter((r) => r.kind !== 'upcoming' && r.kind !== 'not_employed' && r.kind !== 'open' && r.day <= istToday()));

const REQ = { id: true, employeeId: true, leaveType: true, leaveTypeId: true, fromDate: true, toDate: true, halfDay: true, days: true, reason: true, status: true, decisionNote: true, decidedAt: true, createdAt: true, type: { select: { name: true, code: true } }, employee: { select: { name: true, employeeCode: true } } } satisfies Prisma.LeaveRequestSelect;

/** Attendance, leave and approvals. Employees with a UBOS login check in and apply for themselves; HR and managers see what their scope reaches. */
@Controller('api/v1/hr')
@RequireFeature('module.hrms')
export class AttendanceController {
  constructor(private db: DbService) {}

  private async me(tx: Tx) {
    const e = await tx.employee.findFirst({ where: { userId: auth().userId }, select: EMP });
    if (!e) throw new NotFoundException({ code: 'NO_EMPLOYEE_RECORD', message: 'You do not have an employee record yet. Ask HR to add you.' });
    return e;
  }
  private async within(tx: Tx, id: string, perm: string) {
    const e = await tx.employee.findFirst({ where: { AND: [{ id }, await reach(tx, perm)] }, select: EMP });
    if (!e) throw new NotFoundException({ code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found' });
    return e;
  }
  /** People who should hear about a request: the employee's manager, else whoever approves leave for the whole organization. */
  private async approvers(tx: Tx, emp: Emp) {
    const manager = emp.userId ? (await tx.user.findUnique({ where: { id: emp.userId }, select: { reportsToId: true } }))?.reportsToId : null;
    if (manager) return [manager];
    return (await tx.user.findMany({ where: { isActive: true, id: { not: emp.userId ?? undefined }, roles: { some: { role: { permissions: { some: { isDeny: false, scope: 'ORGANIZATION', permission: { key: { in: [APPROVE, LEAVE] } } } } } } } }, select: { id: true } })).map((u) => u.id);
  }

  private async apply(tx: Tx, emp: Emp, input: z.infer<typeof Apply>, byHr: boolean) {
    if (emp.status === 'exited') throw bad('NOT_ACTIVE', 'This person has left');
    const type = await tx.leaveType.findFirst({ where: { id: input.leaveTypeId, isArchived: false } });
    if (!type) throw bad('LEAVE_TYPE_NOT_FOUND', 'Choose a leave type');
    const { fromOn: from, toOn: to } = input;
    if (to < from) throw bad('BAD_DATES', 'The last day must be on or after the first day');
    if (input.halfDay && from !== to) throw bad('HALF_DAY_ONE_DAY', 'A half day can only be for one day');
    if (input.halfDay && !type.allowHalfDay) throw bad('NO_HALF_DAY', `${type.name} cannot be taken as a half day`);
    if (daysBetween(from, to) > 90) throw bad('TOO_LONG', 'One request can cover at most 90 days');
    if (from < ymd(emp.joiningDate)) throw bad('BEFORE_JOINING', 'Leave cannot start before the joining date');
    if (!byHr && from < addDays(istToday(), -30)) throw bad('TOO_OLD', 'Leave older than 30 days has to be recorded by HR');
    const s = await attendanceSettings(tx);
    const days = leaveDays(from, to, input.halfDay, s, new Set((await holidays(tx, from, to)).keys()));
    if (!days) throw bad('NO_WORKING_DAYS', 'Those days are all weekly offs or holidays');
    if (leaveYear(from, s.leaveYearStartMonth).label !== leaveYear(to, s.leaveYearStartMonth).label) throw bad('ACROSS_YEARS', 'Split leave that crosses into the next leave year into two requests');
    const clash = await tx.leaveRequest.findFirst({ where: { employeeId: emp.id, status: { in: ['pending', 'approved'] }, fromDate: { lte: noon(to) }, toDate: { gte: noon(from) } } });
    if (clash) throw new ConflictException({ code: 'LEAVE_OVERLAP', message: 'There is already leave on some of these days' });
    if (!type.allowNegative) {
      const b = (await balances(tx, emp, from, s)).find((x) => x.leaveTypeId === type.id)!;
      if (b.available < days) throw bad('LOW_BALANCE', `Only ${b.available} ${type.name.toLowerCase()} days are left`, { available: b.available });
    }
    const a = auth();
    const approvers = await this.approvers(tx, emp);
    const r = await tx.leaveRequest.create({
      data: {
        tenantId: tenantId(), employeeId: emp.id, leaveTypeId: type.id, leaveType: type.code, fromDate: noon(from), toDate: noon(to), halfDay: input.halfDay, days, reason: input.reason || null,
        status: byHr ? 'approved' : 'pending', approverId: approvers[0] ?? null, createdById: a.userId, ...(byHr ? { decidedById: a.userId, decidedAt: new Date() } : {}),
      },
    });
    await this.db.audit(tx, { entity: 'leave', entityId: r.id, action: byHr ? 'leave.recorded' : 'leave.applied', newValue: { employee: emp.employeeCode, type: type.code, from, to, days } });
    const when = from === to ? from : `${from} to ${to}`;
    if (!byHr) await notify(tx, approvers, { type: 'approval', title: `${emp.name} asked for ${days} ${days === 1 ? 'day' : 'days'} of ${type.name.toLowerCase()}`, body: when, link: '/app/hr/leave' });
    else if (emp.userId) await notify(tx, [emp.userId], { type: 'info', title: `HR recorded ${type.name.toLowerCase()} for you`, body: when, link: '/app/me/attendance' });
    return r;
  }

  // ---------- Self service ----------

  @Get('me')
  mine(@Query('month') month?: string) {
    const m = month && Month.safeParse(month).success ? month : istToday().slice(0, 7);
    return this.db.tenant(async (tx) => {
      const e = await tx.employee.findFirst({ where: { userId: auth().userId }, select: EMP });
      const s = await attendanceSettings(tx);
      const types = (await leaveTypes(tx)).map((t) => ({ id: t.id, code: t.code, name: t.name, allowHalfDay: t.allowHalfDay, unlimited: t.allowNegative }));
      const year = leaveYear(istToday(), s.leaveYearStartMonth);
      const hol = [...(await holidays(tx, year.from, year.to)).entries()].map(([day, name]) => ({ day, name }));
      if (!e) return { employee: null, settings: s, types, holidays: hol };
      const today = istToday();
      const [rows, record, bal, requests, corrections] = await Promise.all([
        monthRows(tx, [e], m, s),
        tx.attendance.findUnique({ where: { tenantId_employeeId_day: { tenantId: tenantId(), employeeId: e.id, day: today } } }),
        balances(tx, e, today, s),
        tx.leaveRequest.findMany({ where: { employeeId: e.id }, select: REQ, orderBy: { fromDate: 'desc' }, take: 30 }),
        tx.attendanceRequest.findMany({ where: { employeeId: e.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      ]);
      const days = rows.get(e.id)!;
      return { employee: e, settings: s, types, holidays: hol, today, record, month: m, days, totals: totals(days), balances: bal, requests, corrections };
    });
  }

  @Post('me/check-in')
  @HttpCode(200)
  checkIn(@Body() body: unknown) {
    const g = parse(Geo, body ?? {});
    return this.db.tenant(async (tx) => {
      const e = await this.me(tx);
      if (e.status === 'exited') throw bad('NOT_ACTIVE', 'This person has left');
      const s = await attendanceSettings(tx);
      if (s.requireLocation && (g.lat === undefined || g.lng === undefined)) throw bad('LOCATION_REQUIRED', 'Allow location to check in');
      const now = new Date(), day = istClock(now).day;
      const r = await tx.attendance.findUnique({ where: { tenantId_employeeId_day: { tenantId: tenantId(), employeeId: e.id, day } } });
      if (r?.checkInAt) throw new ConflictException({ code: 'ALREADY_CHECKED_IN', message: 'You have already checked in today' });
      return tx.attendance.upsert({
        where: { tenantId_employeeId_day: { tenantId: tenantId(), employeeId: e.id, day } },
        create: { tenantId: tenantId(), employeeId: e.id, day, checkInAt: now, inLat: g.lat ?? null, inLng: g.lng ?? null, source: 'web' },
        update: { checkInAt: now, inLat: g.lat ?? null, inLng: g.lng ?? null },
      });
    });
  }

  @Post('me/check-out')
  @HttpCode(200)
  checkOut(@Body() body: unknown) {
    const g = parse(Geo, body ?? {});
    return this.db.tenant(async (tx) => {
      const e = await this.me(tx);
      const s = await attendanceSettings(tx);
      if (s.requireLocation && (g.lat === undefined || g.lng === undefined)) throw bad('LOCATION_REQUIRED', 'Allow location to check out');
      const now = new Date(), day = istClock(now).day;
      const r = await tx.attendance.findUnique({ where: { tenantId_employeeId_day: { tenantId: tenantId(), employeeId: e.id, day } } });
      if (!r?.checkInAt) throw bad('NOT_CHECKED_IN', 'Check in first');
      // Checking out again moves the time to the latest check-out.
      return tx.attendance.update({ where: { id: r.id }, data: { checkOutAt: now, outLat: g.lat ?? null, outLng: g.lng ?? null } });
    });
  }

  @Post('me/leave')
  applyMine(@Body() body: unknown) {
    const input = parse(Apply, body);
    return this.db.tenant(async (tx) => this.apply(tx, await this.me(tx), input, false));
  }

  @Post('me/leave/:id/cancel')
  @HttpCode(200)
  cancelMine(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.me(tx);
      const r = await tx.leaveRequest.findFirst({ where: { id, employeeId: e.id } });
      if (!r) throw new NotFoundException({ code: 'LEAVE_NOT_FOUND', message: 'Leave not found' });
      if (r.status === 'approved' ? ymd(r.fromDate) <= istToday() : r.status !== 'pending') throw bad('CANNOT_CANCEL', r.status === 'approved' ? 'Leave that has started can only be cancelled by HR' : 'This request is already closed');
      await tx.leaveRequest.update({ where: { id }, data: { status: 'cancelled' } });
      await this.db.audit(tx, { entity: 'leave', entityId: id, action: 'leave.cancelled', oldValue: { status: r.status }, newValue: { status: 'cancelled' } });
      if (r.status === 'approved' && r.approverId) await notify(tx, [r.approverId], { type: 'info', title: `${e.name} cancelled approved leave`, body: ymd(r.fromDate), link: '/app/hr/leave' });
      return { ok: true };
    });
  }

  @Post('me/corrections')
  askCorrection(@Body() body: unknown) {
    const input = parse(Correction, body);
    return this.db.tenant(async (tx) => {
      const e = await this.me(tx);
      const today = istToday();
      if (input.day > today) throw bad('FUTURE_DAY', 'You can only correct days that have passed or today');
      if (input.day < addDays(today, -30)) throw bad('TOO_OLD', 'Days older than 30 days are corrected by HR');
      if (input.day < ymd(e.joiningDate)) throw bad('BEFORE_JOINING', 'That is before your joining date');
      if (input.checkOut <= input.checkIn) throw bad('BAD_TIMES', 'Check-out must be after check-in');
      if (await tx.attendanceRequest.findFirst({ where: { employeeId: e.id, day: input.day, status: 'pending' } })) throw new ConflictException({ code: 'CORRECTION_PENDING', message: 'A correction for this day is already waiting' });
      const r = await tx.attendanceRequest.create({ data: { tenantId: tenantId(), employeeId: e.id, day: input.day, checkInAt: istInstant(input.day, input.checkIn), checkOutAt: istInstant(input.day, input.checkOut), reason: input.reason } });
      await notify(tx, await this.approvers(tx, e), { type: 'approval', title: `${e.name} asked to correct attendance`, body: `${input.day}: ${input.checkIn} to ${input.checkOut}`, link: '/app/hr/leave' });
      return r;
    });
  }

  @Post('me/corrections/:id/cancel')
  @HttpCode(200)
  cancelCorrection(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.me(tx);
      const r = await tx.attendanceRequest.updateMany({ where: { id, employeeId: e.id, status: 'pending' }, data: { status: 'cancelled' } });
      if (!r.count) throw bad('CANNOT_CANCEL', 'This request is already closed');
      return { ok: true };
    });
  }

  // ---------- Managers and HR ----------

  @Get('attendance/today')
  @RequirePermission(VIEW)
  today() {
    return this.db.tenant(async (tx) => {
      const day = istToday();
      const emps = await tx.employee.findMany({ where: { AND: [await reach(tx, VIEW), { status: { not: 'exited' } }] }, select: { ...EMP, designation: true }, orderBy: { name: 'asc' } });
      const s = await attendanceSettings(tx);
      const rows = await monthRows(tx, emps, day.slice(0, 7), s);
      const people = emps.map((e) => { const r = rows.get(e.id)!.find((x) => x.day === day)!; return { id: e.id, name: e.name, employeeCode: e.employeeCode, designation: e.designation, kind: r.kind, late: r.late, checkInAt: r.checkInAt, checkOutAt: r.checkOutAt, leaveCode: r.leaveCode, holiday: r.holiday }; });
      const count = (f: (p: (typeof people)[number]) => boolean) => people.filter(f).length;
      return { day, people, counts: { total: people.length, in: count((p) => !!p.checkInAt), late: count((p) => p.late), onLeave: count((p) => p.kind === 'leave' || p.kind === 'half_leave'), notIn: count((p) => !p.checkInAt && (p.kind === 'upcoming' || p.kind === 'absent')) } };
    });
  }

  private async register(tx: Tx, month: string) {
    const s = await attendanceSettings(tx);
    const days = monthDays(month);
    const emps = await tx.employee.findMany({
      where: { AND: [await reach(tx, VIEW), { joiningDate: { lte: noon(days[days.length - 1]) } }, { OR: [{ exitDate: null }, { exitDate: { gte: noon(days[0]) } }] }] },
      select: { ...EMP, designation: true }, orderBy: { employeeCode: 'asc' },
    });
    const rows = await monthRows(tx, emps, month, s);
    return { month, rows: emps.map((e) => ({ id: e.id, name: e.name, employeeCode: e.employeeCode, designation: e.designation, status: e.status, ...totals(rows.get(e.id)!) })) };
  }

  @Get('attendance/register')
  @RequirePermission(VIEW)
  registerJson(@Query('month') month: string) {
    const m = parse(Month, month ?? istToday().slice(0, 7));
    return this.db.tenant((tx) => this.register(tx, m));
  }

  @Get('attendance/register.csv')
  @RequirePermission(VIEW)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="attendance-register.csv"')
  registerCsv(@Query('month') month: string) {
    const m = parse(Month, month ?? istToday().slice(0, 7));
    return this.db.tenant(async (tx) => {
      const r = await this.register(tx, m);
      return toCsv([
        ['Month', 'Code', 'Name', 'Designation', 'Present', 'Half days', 'Absent', 'Late', 'Paid leave', 'Leave without pay', 'Holidays', 'Weekly offs', 'No check-out', 'Payable days', 'Loss of pay days'],
        ...r.rows.map((x) => [m, x.employeeCode, x.name, x.designation ?? '', x.present, x.halfDay, x.absent, x.late, x.paidLeave, x.unpaidLeave, x.holidays, x.weeklyOffs, x.missedCheckout, x.payable, x.lop]),
      ]);
    });
  }

  @Get('attendance/employees/:id')
  employeeMonth(@Param('id') id: string, @Query('month') month?: string) {
    const m = month && Month.safeParse(month).success ? month : istToday().slice(0, 7);
    return this.db.tenant(async (tx) => {
      const a = auth();
      const perm = a.permissions[VIEW as never] ? VIEW : a.permissions['hr.employee.view' as never] ? 'hr.employee.view' : null;
      if (!perm) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `Missing permission ${VIEW}` });
      const e = await this.within(tx, id, perm);
      const s = await attendanceSettings(tx);
      const [rows, bal, requests] = await Promise.all([
        monthRows(tx, [e], m, s), balances(tx, e, istToday(), s),
        tx.leaveRequest.findMany({ where: { employeeId: e.id }, select: REQ, orderBy: { fromDate: 'desc' }, take: 30 }),
      ]);
      const days = rows.get(e.id)!;
      return { employee: e, month: m, days, totals: totals(days), balances: bal, requests, can: { fix: !!a.permissions[FIX as never], leave: !!a.permissions[LEAVE as never] } };
    });
  }

  @Put('attendance/employees/:id/days/:day')
  @RequirePermission(FIX)
  fixDay(@Param('id') id: string, @Param('day') day: string, @Body() body: unknown) {
    if (!isDay(day)) throw bad('BAD_DAY', 'Enter a date');
    const input = parse(DayEdit, body);
    return this.db.tenant(async (tx) => {
      const e = await this.within(tx, id, FIX);
      if (day > istToday()) throw bad('FUTURE_DAY', 'Future days cannot be marked yet');
      const key = { tenantId_employeeId_day: { tenantId: tenantId(), employeeId: e.id, day } };
      const old = await tx.attendance.findUnique({ where: key });
      const at = (t: string | null | undefined, prev: Date | null | undefined) => (t === undefined ? (prev ?? null) : t === null ? null : istInstant(day, t));
      const checkInAt = at(input.checkIn, old?.checkInAt), checkOutAt = at(input.checkOut, old?.checkOutAt);
      if (checkOutAt && !checkInAt) throw bad('BAD_TIMES', 'Add the check-in time too');
      if (checkInAt && checkOutAt && checkOutAt <= checkInAt) throw bad('BAD_TIMES', 'Check-out must be after check-in');
      const data = { checkInAt, checkOutAt, override: input.override === undefined ? (old?.override ?? null) : input.override, note: input.note === undefined ? (old?.note ?? null) : input.note, correctedById: auth().userId, source: old?.source ?? 'manual' };
      const r = await tx.attendance.upsert({ where: key, create: { tenantId: tenantId(), employeeId: e.id, day, ...data }, update: data });
      await this.db.audit(tx, { entity: 'attendance', entityId: r.id, action: 'attendance.corrected', oldValue: old ? { checkInAt: old.checkInAt, checkOutAt: old.checkOutAt, override: old.override } : undefined, newValue: { employee: e.employeeCode, day, checkInAt, checkOutAt, override: data.override, note: data.note } });
      return r;
    });
  }

  @Get('approvals')
  @RequirePermission(APPROVE)
  approvals() {
    return this.db.tenant(async (tx) => {
      const scope = { AND: [await reach(tx, APPROVE), { OR: [{ userId: null }, { userId: { not: auth().userId } }] }] } satisfies Prisma.EmployeeWhereInput;
      const [leave, corrections] = await Promise.all([
        tx.leaveRequest.findMany({ where: { status: 'pending', employee: scope }, select: REQ, orderBy: { fromDate: 'asc' } }),
        tx.attendanceRequest.findMany({ where: { status: 'pending', employee: scope }, include: { employee: { select: { name: true, employeeCode: true } } }, orderBy: { day: 'asc' } }),
      ]);
      const s = await attendanceSettings(tx);
      const withBalance = await Promise.all(leave.map(async (l) => {
        const e = await tx.employee.findUniqueOrThrow({ where: { id: l.employeeId }, select: EMP });
        const b = (await balances(tx, e, ymd(l.fromDate), s)).find((x) => x.leaveTypeId === l.leaveTypeId);
        return { ...l, balance: b ? { available: b.available, unlimited: b.unlimited } : null };
      }));
      return { leave: withBalance, corrections };
    });
  }

  /** The approver must reach the employee and cannot approve their own request. */
  private async decidable(tx: Tx, employeeId: string) {
    const e = await this.within(tx, employeeId, APPROVE).catch(() => { throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' }); });
    if (e.userId && e.userId === auth().userId) throw new ForbiddenException({ code: 'OWN_REQUEST', message: 'Someone else has to approve your own request' });
    return e;
  }

  @Post('leave/:id/decide')
  @HttpCode(200)
  @RequirePermission(APPROVE)
  decideLeave(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Decide, body);
    return this.db.tenant(async (tx) => {
      const r = await tx.leaveRequest.findFirst({ where: { id }, include: { type: true } });
      if (!r) throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' });
      const e = await this.decidable(tx, r.employeeId);
      const done = await tx.leaveRequest.updateMany({ where: { id, status: 'pending' }, data: { status: input.approve ? 'approved' : 'rejected', decidedById: auth().userId, decidedAt: new Date(), decisionNote: input.note || null } });
      if (!done.count) throw new ConflictException({ code: 'ALREADY_DECIDED', message: 'This request was already decided' });
      await this.db.audit(tx, { entity: 'leave', entityId: id, action: input.approve ? 'leave.approved' : 'leave.rejected', newValue: { employee: e.employeeCode, days: r.days, note: input.note ?? null } });
      if (e.userId) await notify(tx, [e.userId], { type: 'info', title: `Your ${r.type?.name.toLowerCase() ?? 'leave'} was ${input.approve ? 'approved' : 'not approved'}`, body: input.note || `${ymd(r.fromDate)}${r.days > 1 ? ` to ${ymd(r.toDate)}` : ''}`, link: '/app/me/attendance' });
      return { ok: true };
    });
  }

  @Post('corrections/:id/decide')
  @HttpCode(200)
  @RequirePermission(APPROVE)
  decideCorrection(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Decide, body);
    return this.db.tenant(async (tx) => {
      const r = await tx.attendanceRequest.findFirst({ where: { id } });
      if (!r) throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' });
      const e = await this.decidable(tx, r.employeeId);
      const done = await tx.attendanceRequest.updateMany({ where: { id, status: 'pending' }, data: { status: input.approve ? 'approved' : 'rejected', decidedById: auth().userId, decidedAt: new Date(), decisionNote: input.note || null } });
      if (!done.count) throw new ConflictException({ code: 'ALREADY_DECIDED', message: 'This request was already decided' });
      if (input.approve) {
        const key = { tenantId_employeeId_day: { tenantId: tenantId(), employeeId: e.id, day: r.day } };
        const data = { checkInAt: r.checkInAt, checkOutAt: r.checkOutAt, correctedById: auth().userId, note: `Corrected on request: ${r.reason}` };
        await tx.attendance.upsert({ where: key, create: { tenantId: tenantId(), employeeId: e.id, day: r.day, source: 'manual', ...data }, update: data });
      }
      await this.db.audit(tx, { entity: 'attendance', entityId: id, action: input.approve ? 'attendance.correction_approved' : 'attendance.correction_rejected', newValue: { employee: e.employeeCode, day: r.day } });
      if (e.userId) await notify(tx, [e.userId], { type: 'info', title: `Your attendance correction for ${r.day} was ${input.approve ? 'approved' : 'not approved'}`, body: input.note || null, link: '/app/me/attendance' });
      return { ok: true };
    });
  }

  @Post('leave')
  @RequirePermission(LEAVE)
  record(@Body() body: unknown) {
    const input = parse(Apply.extend({ employeeId: z.string().uuid() }), body);
    return this.db.tenant(async (tx) => this.apply(tx, await this.within(tx, input.employeeId, LEAVE), input, true));
  }

  @Post('leave/:id/cancel')
  @HttpCode(200)
  @RequirePermission(LEAVE)
  cancelAny(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.leaveRequest.findFirst({ where: { id, status: { in: ['pending', 'approved'] } } });
      if (!r) throw bad('CANNOT_CANCEL', 'This request is already closed');
      const e = await this.within(tx, r.employeeId, LEAVE);
      await tx.leaveRequest.update({ where: { id }, data: { status: 'cancelled' } });
      await this.db.audit(tx, { entity: 'leave', entityId: id, action: 'leave.cancelled', oldValue: { status: r.status }, newValue: { status: 'cancelled', employee: e.employeeCode } });
      if (e.userId && e.userId !== auth().userId) await notify(tx, [e.userId], { type: 'info', title: 'HR cancelled your leave', body: ymd(r.fromDate), link: '/app/me/attendance' });
      return { ok: true };
    });
  }

  @Post('leave/adjust')
  @RequirePermission(LEAVE)
  adjust(@Body() body: unknown) {
    const input = parse(Adjust, body);
    return this.db.tenant(async (tx) => {
      const e = await this.within(tx, input.employeeId, LEAVE);
      const type = await tx.leaveType.findFirst({ where: { id: input.leaveTypeId } });
      if (!type) throw bad('LEAVE_TYPE_NOT_FOUND', 'Choose a leave type');
      const year = leaveYear(istToday(), (await attendanceSettings(tx)).leaveYearStartMonth).label;
      const r = await tx.leaveAdjustment.create({ data: { tenantId: tenantId(), employeeId: e.id, leaveTypeId: type.id, year, days: input.days, reason: input.reason, createdById: auth().userId } });
      await this.db.audit(tx, { entity: 'leave', entityId: r.id, action: 'leave.adjusted', newValue: { employee: e.employeeCode, type: type.code, year, days: input.days, reason: input.reason } });
      return r;
    });
  }

  // ---------- Setup ----------

  @Get('leave/setup')
  setup() {
    return this.db.tenant(async (tx) => {
      const s = await attendanceSettings(tx);
      const year = leaveYear(istToday(), s.leaveYearStartMonth);
      const a = auth();
      const hol = await tx.holiday.findMany({ where: { isArchived: false, day: { gte: year.from, lte: addDays(year.to, 366) } }, orderBy: { day: 'asc' } });
      return { settings: s, year, types: await leaveTypes(tx, true), holidays: hol, can: { fix: !!a.permissions[FIX as never], leave: !!a.permissions[LEAVE as never], approve: !!a.permissions[APPROVE as never], view: !!a.permissions[VIEW as never] } };
    });
  }

  @Put('attendance/settings')
  @RequirePermission(FIX, 'ORGANIZATION')
  saveSettings(@Body() body: unknown) {
    const input = parse(Settings, body);
    return this.db.tenant(async (tx) => {
      const old = await attendanceSettings(tx);
      const json = input as unknown as Prisma.InputJsonValue;
      await tx.hrSetting.upsert({ where: { tenantId: tenantId() }, create: { tenantId: tenantId(), onboardingTasks: DEFAULT_ONBOARDING, exitTasks: DEFAULT_EXIT, docTypes: DEFAULT_DOC_TYPES, attendance: json }, update: { attendance: json } });
      await this.db.audit(tx, { entity: 'hr', entityId: tenantId(), action: 'attendance.settings_saved', oldValue: old, newValue: input });
      return input;
    });
  }

  @Post('leave/types')
  @RequirePermission(LEAVE, 'ORGANIZATION')
  addType(@Body() body: unknown) {
    const input = parse(TypeBody, body);
    return this.db.tenant(async (tx) => {
      const types = await leaveTypes(tx, true);
      if (types.some((t) => t.code === input.code)) throw new ConflictException({ code: 'CODE_TAKEN', message: 'Another leave type uses this code' });
      const t = await tx.leaveType.create({ data: { tenantId: tenantId(), ...input, position: types.length } });
      await this.db.audit(tx, { entity: 'leave_type', entityId: t.id, action: 'leave_type.created', newValue: input });
      return t;
    });
  }

  @Put('leave/types/:id')
  @RequirePermission(LEAVE, 'ORGANIZATION')
  editType(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(TypeBody.partial().extend({ isArchived: z.boolean().optional() }), body);
    return this.db.tenant(async (tx) => {
      const old = await tx.leaveType.findFirst({ where: { id } });
      if (!old) throw new NotFoundException({ code: 'LEAVE_TYPE_NOT_FOUND', message: 'Leave type not found' });
      if (input.code && input.code !== old.code && (await tx.leaveType.findFirst({ where: { code: input.code } }))) throw new ConflictException({ code: 'CODE_TAKEN', message: 'Another leave type uses this code' });
      const t = await tx.leaveType.update({ where: { id }, data: input });
      await this.db.audit(tx, { entity: 'leave_type', entityId: id, action: input.isArchived ? 'leave_type.archived' : 'leave_type.updated', oldValue: { name: old.name, yearlyDays: old.yearlyDays, isArchived: old.isArchived }, newValue: input });
      return t;
    });
  }

  @Post('holidays')
  @RequirePermission(FIX, 'ORGANIZATION')
  addHoliday(@Body() body: unknown) {
    const input = parse(z.object({ day: Day, name: z.string().trim().min(2).max(80) }), body);
    return this.db.tenant(async (tx) => {
      if (await tx.holiday.findFirst({ where: { day: input.day, isArchived: false } })) throw new ConflictException({ code: 'HOLIDAY_EXISTS', message: 'There is already a holiday on this day' });
      const h = await tx.holiday.create({ data: { tenantId: tenantId(), ...input } });
      await this.db.audit(tx, { entity: 'holiday', entityId: h.id, action: 'holiday.added', newValue: input });
      return h;
    });
  }

  @Post('holidays/:id/archive')
  @HttpCode(200)
  @RequirePermission(FIX, 'ORGANIZATION')
  archiveHoliday(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const h = await tx.holiday.findFirst({ where: { id, isArchived: false } });
      if (!h) throw new NotFoundException({ code: 'HOLIDAY_NOT_FOUND', message: 'Holiday not found' });
      await tx.holiday.update({ where: { id }, data: { isArchived: true } });
      await this.db.audit(tx, { entity: 'holiday', entityId: id, action: 'holiday.removed', oldValue: { day: h.day, name: h.name } });
      return { ok: true };
    });
  }
}
