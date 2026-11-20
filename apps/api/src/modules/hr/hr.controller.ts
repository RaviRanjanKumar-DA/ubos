import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DEFAULT_DOC_TYPES, DEFAULT_EXIT, DEFAULT_ONBOARDING, daysUntil, normalizeMobile, upcomingHrEvents } from '@ubos/shared';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { notify } from '../../common/notify';
import { storage } from '../../common/storage';
import { decrypt, encrypt, randomToken } from '../../auth/crypto';

const VIEW = 'hr.employee.view', WORK = 'hr.employee.manage', SECRET = 'hr.sensitive.view', ASSETS = 'hr.asset.manage';
const MAX_DOC = 5 * 1024 * 1024;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const opt = (max: number) => z.string().trim().max(max).nullable().optional();
const Person = z.object({
  name: z.string().trim().min(2).max(120), mobile: opt(20), workEmail: z.string().trim().email().max(160).nullable().optional().or(z.literal('')), designation: opt(80), departmentId: z.string().uuid().nullable().optional(),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).default('full_time'), workLocation: opt(80), joiningOn: Day, probationEndOn: Day.nullable().optional(), dateOfBirthOn: Day.nullable().optional(),
  personalEmail: z.string().trim().email().max(160).nullable().optional().or(z.literal('')), address: opt(500), emergencyName: opt(120), emergencyPhone: opt(20), noticeDays: z.number().int().min(0).max(180).default(30), userId: z.string().uuid().nullable().optional(),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN').nullable().optional(),
  bank: z.object({ account: z.string().trim().regex(/^\d{6,20}$/, 'Enter the account number in digits'), ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC') }).nullable().optional(),
  ctcPaise: z.number().int().min(0).max(100_000_000_000).nullable().optional(),
});
const Status = z.object({ status: z.enum(['onboarding', 'active', 'notice', 'exited']), exitOn: Day.optional(), exitReason: opt(300) });
const Templates = z.object({ onboardingTasks: z.array(z.string().trim().min(2).max(120)).max(40), exitTasks: z.array(z.string().trim().min(2).max(120)).max(40), docTypes: z.array(z.string().trim().min(2).max(60)).min(1).max(40) });
const AssetBody = z.object({ tag: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(120), category: z.string().trim().min(2).max(40), serialNo: opt(80), costPaise: z.number().int().min(0).max(10_000_000_000).nullable().optional(), purchasedOn: Day.nullable().optional(), warrantyEndOn: Day.nullable().optional(), notes: opt(500) });
const DocQuery = z.object({ docType: z.string().trim().min(2).max(60), fileName: z.string().trim().min(1).max(160), expiresOn: Day.optional() });

const noon = (d: string) => new Date(`${d}T12:00:00+05:30`);
const day = (d?: string | null) => (d ? noon(d) : d === null ? null : undefined);
const blank = (s?: string | null) => (s === '' ? null : s);

/** Only PDF, JPG and PNG files are kept, told apart by their first bytes. */
function docType(b: Buffer) {
  if (b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}
function readBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_DOC) parts.push(c); });
    req.on('end', () => (size > MAX_DOC ? reject(new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'Choose a file under 5 MB' })) : resolve(Buffer.concat(parts))));
    req.on('error', reject);
  });
}

/** Which employees a permission reaches: yourself (OWN), your team and everyone reporting to you (TEAM), your department or branch, or everyone. */
async function reach(tx: Tx, perm: string): Promise<Prisma.EmployeeWhereInput> {
  const a = auth();
  const scope = a.permissions[perm as never] as string | undefined;
  if (!scope) return { id: '__none__' };
  if (scope === 'ORGANIZATION') return {};
  const me = await tx.user.findUnique({ where: { id: a.userId }, include: { team: { include: { department: true } } } });
  const below: string[] = [];
  let level = [a.userId];
  for (let i = 0; i < 10 && level.length; i++) { level = (await tx.user.findMany({ where: { reportsToId: { in: level } }, select: { id: true } })).map((u) => u.id); below.push(...level); }
  if (scope === 'OWN') return { userId: a.userId };
  const team = me?.team;
  const ids = [a.userId, ...below];
  if (team) ids.push(...(await tx.user.findMany({ where: scope === 'TEAM' ? { teamId: team.id } : scope === 'DEPARTMENT' ? { team: { departmentId: team.departmentId } } : { team: { department: { branchId: team.department.branchId } } }, select: { id: true } })).map((u) => u.id));
  const dept: Prisma.EmployeeWhereInput[] = !team || scope === 'TEAM' ? [] : scope === 'DEPARTMENT' ? [{ departmentId: team.departmentId }] : [{ department: { branchId: team.department.branchId } }];
  return { OR: [{ userId: { in: [...new Set(ids)] } }, ...dept] };
}

async function settings(tx: Tx) {
  const s = await tx.hrSetting.findUnique({ where: { tenantId: tenantId() } });
  return { onboardingTasks: (s?.onboardingTasks as string[]) ?? DEFAULT_ONBOARDING, exitTasks: (s?.exitTasks as string[]) ?? DEFAULT_EXIT, docTypes: (s?.docTypes as string[]) ?? DEFAULT_DOC_TYPES };
}

async function nextCode(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('employee-code:' || current_setting('app.tenant_id')))`;
  const rows = await tx.employee.findMany({ select: { employeeCode: true } });
  const n = rows.reduce((m, r) => Math.max(m, Number(r.employeeCode.replace(/\D/g, '')) || 0), 0) + 1;
  return `E${String(n).padStart(4, '0')}`;
}

const SAFE = { id: true, employeeCode: true, name: true, mobile: true, workEmail: true, designation: true, departmentId: true, employmentType: true, workLocation: true, joiningDate: true, probationEnd: true, exitDate: true, exitReason: true, status: true, noticeDays: true, userId: true, dateOfBirth: true, createdAt: true, department: { select: { name: true } }, user: { select: { name: true, isActive: true } } } satisfies Prisma.EmployeeSelect;

/** Daily HR reminders to the people who run HR: birthdays, anniversaries, probation ends and documents running out. Each is sent once. */
@Injectable()
export class HrReminders {
  constructor(private db: DbService) {}
  async run(force: boolean) {
    const now = new Date();
    if (!force && Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false })) < 9) return 0;
    return this.db.tenant(async (tx) => {
      const people = await tx.employee.findMany({ where: { status: { not: 'exited' } }, select: { id: true, name: true, dateOfBirth: true, joiningDate: true, probationEnd: true, status: true, user: { select: { reportsToId: true } } } });
      if (!people.length) return 0;
      const events = upcomingHrEvents(people, now, 7).filter((e) => e.kind === 'probation' || e.daysAway === 0);
      const docs = await tx.employeeDocument.findMany({ where: { isArchived: false, expiresAt: { not: null, lte: new Date(now.getTime() + 31 * 86_400_000) }, employee: { status: { not: 'exited' } } }, include: { employee: { select: { name: true } } } });
      const items = [
        ...events.map((e) => ({ key: `${e.kind}:${e.employeeId}:${e.date}`, employeeId: e.employeeId, title: e.kind === 'birthday' ? `Birthday today: ${e.name}` : e.kind === 'anniversary' ? `${e.name} completes ${e.years} ${e.years === 1 ? 'year' : 'years'} today` : `${e.name}'s probation ends ${e.daysAway === 0 ? 'today' : `in ${e.daysAway} days`}` })),
        ...docs.map((d) => { const left = daysUntil(d.expiresAt!, now); return { key: `doc:${d.id}:${left < 0 ? 'expired' : 'soon'}`, employeeId: d.employeeId, title: left < 0 ? `${d.employee.name}'s ${d.docType} has expired` : `${d.employee.name}'s ${d.docType} expires in ${left} days` }; }),
      ];
      if (!items.length) return 0;
      const fresh = new Set<string>();
      for (const i of items) if ((await tx.reminderMark.createMany({ data: [{ tenantId: tenantId(), key: i.key }], skipDuplicates: true })).count) fresh.add(i.key);
      const hr = (await tx.user.findMany({ where: { isActive: true, roles: { some: { role: { permissions: { some: { isDeny: false, permission: { key: WORK } } } } } } }, select: { id: true } })).map((u) => u.id);
      let sent = 0;
      for (const i of items.filter((x) => fresh.has(x.key))) {
        const manager = people.find((p) => p.id === i.employeeId)?.user?.reportsToId;
        await notify(tx, [...new Set([...hr, ...(manager && !i.key.startsWith('doc:') ? [manager] : [])])], { type: 'reminder', title: i.title, link: `/app/hr/${i.employeeId}` });
        sent++;
      }
      return sent;
    });
  }
}

/** Employee records with or without a login, checklists, documents and office assets. Nothing is deleted. */
@Controller('api/v1/hr')
@RequireFeature('module.hrms')
export class HrController {
  constructor(private db: DbService) {}

  private async employee(tx: Tx, id: string, perm: string) {
    const e = await tx.employee.findFirst({ where: { AND: [{ id }, await reach(tx, perm)] } });
    if (!e) throw new NotFoundException({ code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found' });
    return e;
  }
  private async canSee(tx: Tx, id: string, perm: string) {
    return !!auth().permissions[perm as never] && !!(await tx.employee.findFirst({ where: { AND: [{ id }, await reach(tx, perm)] }, select: { id: true } }));
  }

  @Get('meta')
  @RequirePermission(VIEW)
  meta() {
    return this.db.tenant(async (tx) => {
      const p = auth().permissions;
      const [departments, users, s] = await Promise.all([
        tx.department.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
        p[WORK as never] ? tx.user.findMany({ where: { isActive: true, employee: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, email: true } }) : [],
        settings(tx),
      ]);
      return { departments, unlinkedUsers: users, ...s, can: { manage: !!p[WORK as never], sensitive: !!p[SECRET as never], assets: !!p[ASSETS as never] } };
    });
  }

  @Put('settings')
  @RequirePermission(WORK, 'ORGANIZATION')
  saveSettings(@Body() body: unknown) {
    const input = parse(Templates, body);
    return this.db.tenant(async (tx) => {
      await tx.hrSetting.upsert({ where: { tenantId: tenantId() }, update: input, create: { tenantId: tenantId(), ...input } });
      await this.db.audit(tx, { entity: 'hr', entityId: tenantId(), action: 'hr.settings_saved', newValue: { onboarding: input.onboardingTasks.length, exit: input.exitTasks.length } });
      return settings(tx);
    });
  }

  @Get('employees')
  @RequirePermission(VIEW)
  list(@Query() query: unknown) {
    const q = parse(z.object({ status: z.enum(['onboarding', 'active', 'notice', 'exited']).optional(), q: z.string().trim().max(80).optional() }), query);
    return this.db.tenant(async (tx) => {
      const where: Prisma.EmployeeWhereInput = { AND: [await reach(tx, VIEW), q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { employeeCode: { contains: q.q, mode: 'insensitive' } }, { mobile: { contains: q.q } }, { designation: { contains: q.q, mode: 'insensitive' } }] } : {}] };
      const rows = await tx.employee.findMany({ where, orderBy: [{ name: 'asc' }], select: SAFE, take: 2000 });
      const counts = { onboarding: 0, active: 0, notice: 0, exited: 0 } as Record<string, number>;
      for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return { rows: q.status ? rows.filter((r) => r.status === q.status) : rows, counts };
    });
  }

  @Get('upcoming')
  @RequirePermission(VIEW)
  upcoming() {
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const people = await tx.employee.findMany({ where: { AND: [await reach(tx, VIEW), { status: { not: 'exited' } }] }, select: { id: true, name: true, dateOfBirth: true, joiningDate: true, probationEnd: true, status: true } });
      const docs = auth().permissions[SECRET as never]
        ? await tx.employeeDocument.findMany({ where: { isArchived: false, expiresAt: { not: null, lte: new Date(now.getTime() + 31 * 86_400_000) }, employee: { AND: [await reach(tx, SECRET), { status: { not: 'exited' } }] } }, include: { employee: { select: { name: true } } }, orderBy: { expiresAt: 'asc' } })
        : [];
      return { events: upcomingHrEvents(people, now, 30), documents: docs.map((d) => ({ id: d.id, employeeId: d.employeeId, name: d.employee.name, docType: d.docType, daysAway: daysUntil(d.expiresAt!, now) })) };
    });
  }

  @Get('employees/:id')
  @RequirePermission(VIEW)
  one(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const base = await this.employee(tx, id, VIEW);
      const e = await tx.employee.findUniqueOrThrow({ where: { id }, select: { ...SAFE, personalEmail: true, address: true, emergencyName: true, emergencyPhone: true, panLast4: true, bankLast4: true, ctcPaise: true } });
      const [sensitive, manage] = await Promise.all([this.canSee(tx, id, SECRET), this.canSee(tx, id, WORK)]);
      const tasks = await tx.employeeTask.findMany({ where: { employeeId: id }, orderBy: [{ kind: 'desc' }, { position: 'asc' }] });
      const assets = await tx.assetAssignment.findMany({ where: { employeeId: id }, orderBy: { issuedAt: 'desc' }, include: { asset: { select: { id: true, tag: true, name: true, category: true } } } });
      const { panLast4, bankLast4, ctcPaise, personalEmail, address, emergencyName, emergencyPhone, ...rest } = e;
      const own = base.userId === auth().userId;
      return { ...rest, ...(sensitive || manage || own ? { personalEmail, address, emergencyName, emergencyPhone } : {}), ...(sensitive ? { panLast4, bankLast4, ctcPaise } : {}), tasks, assets, can: { manage, sensitive } };
    });
  }

  private fields(input: Partial<z.infer<typeof Person>>, sensitive: boolean): Prisma.EmployeeUncheckedUpdateInput {
    if (!sensitive && (input.pan !== undefined || input.bank !== undefined || input.ctcPaise !== undefined)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You cannot change PAN, bank or salary details' });
    if (input.mobile && !normalizeMobile(input.mobile)) throw new BadRequestException({ code: 'INVALID_MOBILE', message: 'Enter a valid mobile number' });
    if (input.emergencyPhone && !normalizeMobile(input.emergencyPhone)) throw new BadRequestException({ code: 'INVALID_MOBILE', message: 'Enter a valid emergency phone number' });
    const d: Prisma.EmployeeUncheckedUpdateInput = {};
    for (const k of ['name', 'designation', 'departmentId', 'employmentType', 'workLocation', 'address', 'emergencyName', 'noticeDays', 'ctcPaise'] as const) if (input[k] !== undefined) (d as Record<string, unknown>)[k] = input[k];
    if (input.mobile !== undefined) d.mobile = input.mobile ? normalizeMobile(input.mobile) : null;
    if (input.emergencyPhone !== undefined) d.emergencyPhone = input.emergencyPhone ? normalizeMobile(input.emergencyPhone) : null;
    if (input.workEmail !== undefined) d.workEmail = blank(input.workEmail)?.toLowerCase() ?? null;
    if (input.personalEmail !== undefined) d.personalEmail = blank(input.personalEmail)?.toLowerCase() ?? null;
    if (input.joiningOn !== undefined) d.joiningDate = noon(input.joiningOn);
    if (input.probationEndOn !== undefined) d.probationEnd = day(input.probationEndOn);
    if (input.dateOfBirthOn !== undefined) d.dateOfBirth = day(input.dateOfBirthOn);
    if (input.pan !== undefined) { d.panEncrypted = input.pan ? encrypt(input.pan) : null; d.panLast4 = input.pan ? input.pan.slice(-4) : null; }
    if (input.bank !== undefined) { d.bankEncrypted = input.bank ? encrypt(JSON.stringify(input.bank)) : null; d.bankLast4 = input.bank ? input.bank.account.slice(-4) : null; }
    return d;
  }
  private async checkLinks(tx: Tx, input: Partial<z.infer<typeof Person>>, self?: string) {
    if (input.departmentId && !(await tx.department.findUnique({ where: { id: input.departmentId } }))) throw new BadRequestException({ code: 'INVALID_DEPARTMENT', message: 'Choose a department' });
    if (input.userId) {
      if (!(await tx.user.findUnique({ where: { id: input.userId } }))) throw new BadRequestException({ code: 'INVALID_USER', message: 'Choose a login' });
      const taken = await tx.employee.findFirst({ where: { userId: input.userId, ...(self ? { id: { not: self } } : {}) }, select: { employeeCode: true } });
      if (taken) throw new ConflictException({ code: 'USER_LINKED', message: `That login already belongs to employee ${taken.employeeCode}` });
    }
  }
  private audited = (input: Partial<z.infer<typeof Person>>) => { const { pan, bank, ctcPaise, ...rest } = input; return { ...rest, ...(pan !== undefined ? { panChanged: true } : {}), ...(bank !== undefined ? { bankChanged: true } : {}), ...(ctcPaise !== undefined ? { salaryChanged: true } : {}) }; };

  @Post('employees')
  @RequirePermission(WORK, 'ORGANIZATION')
  create(@Body() body: unknown) {
    const input = parse(Person, body);
    return this.db.tenant(async (tx) => {
      const sensitive = !!auth().permissions[SECRET as never];
      await this.checkLinks(tx, input);
      const e = await tx.employee.create({ data: { ...(this.fields(input, sensitive) as Prisma.EmployeeUncheckedCreateInput), tenantId: tenantId(), employeeCode: await nextCode(tx), name: input.name, joiningDate: noon(input.joiningOn), userId: input.userId ?? null, status: 'onboarding' }, select: { id: true, employeeCode: true, name: true } });
      const s = await settings(tx);
      if (s.onboardingTasks.length) await tx.employeeTask.createMany({ data: s.onboardingTasks.map((title, position) => ({ tenantId: tenantId(), employeeId: e.id, kind: 'onboarding', title, position })) });
      await this.db.audit(tx, { entity: 'employee', entityId: e.id, action: 'employee.created', newValue: { code: e.employeeCode, ...this.audited(input) } });
      return e;
    });
  }

  @Put('employees/:id')
  @RequirePermission(WORK)
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Person.partial(), body);
    return this.db.tenant(async (tx) => {
      await this.employee(tx, id, WORK);
      await this.checkLinks(tx, input, id);
      const data = this.fields(input, await this.canSee(tx, id, SECRET));
      if (input.userId !== undefined) data.userId = input.userId;
      await tx.employee.update({ where: { id }, data });
      await this.db.audit(tx, { entity: 'employee', entityId: id, action: 'employee.updated', newValue: this.audited(input) });
      return { ok: true };
    });
  }

  @Post('employees/:id/status')
  @HttpCode(200)
  @RequirePermission(WORK)
  status(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Status, body);
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, id, WORK);
      if (e.status === input.status) throw new BadRequestException({ code: 'SAME_STATUS', message: 'Nothing to change' });
      const data: Prisma.EmployeeUpdateInput = { status: input.status };
      if (input.status === 'notice' || input.status === 'exited') {
        if (input.status === 'exited') {
          if (!input.exitOn) throw new BadRequestException({ code: 'EXIT_DATE_REQUIRED', message: 'Enter the last working day' });
          const out = await tx.assetAssignment.count({ where: { employeeId: id, returnedAt: null } });
          if (out) throw new ConflictException({ code: 'ASSETS_OUT', message: `${out} ${out === 1 ? 'asset is' : 'assets are'} still with this employee. Take them back first` });
        }
        if (input.exitOn) data.exitDate = noon(input.exitOn);
        if (input.exitReason !== undefined) data.exitReason = input.exitReason;
        if (!(await tx.employeeTask.count({ where: { employeeId: id, kind: 'exit' } }))) {
          const s = await settings(tx);
          if (s.exitTasks.length) await tx.employeeTask.createMany({ data: s.exitTasks.map((title, position) => ({ tenantId: tenantId(), employeeId: id, kind: 'exit', title, position })) });
        }
      }
      if (input.status === 'active' || input.status === 'onboarding') { data.exitDate = null; data.exitReason = null; }
      await tx.employee.update({ where: { id }, data });
      await this.db.audit(tx, { entity: 'employee', entityId: id, action: 'employee.status_changed', oldValue: { status: e.status }, newValue: { status: input.status, exitOn: input.exitOn ?? null } });
      const login = e.userId ? await tx.user.findUnique({ where: { id: e.userId }, select: { isActive: true } }) : null;
      return { ok: true, loginStillActive: input.status === 'exited' && !!login?.isActive };
    });
  }

  /** The full PAN and bank details, for whoever may see them. Each look is recorded; the values never are. */
  @Post('employees/:id/reveal')
  @HttpCode(200)
  @RequirePermission(SECRET)
  reveal(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, id, SECRET);
      await this.db.audit(tx, { entity: 'employee', entityId: id, action: 'employee.sensitive_viewed', newValue: {} });
      return { pan: e.panEncrypted ? decrypt(e.panEncrypted) : null, bank: e.bankEncrypted ? (JSON.parse(decrypt(e.bankEncrypted)) as { account: string; ifsc: string }) : null };
    });
  }

  @Post('employees/:id/tasks')
  @RequirePermission(WORK)
  addTask(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ title: z.string().trim().min(2).max(120), kind: z.enum(['onboarding', 'exit']) }), body);
    return this.db.tenant(async (tx) => {
      await this.employee(tx, id, WORK);
      const position = await tx.employeeTask.count({ where: { employeeId: id, kind: input.kind } });
      return tx.employeeTask.create({ data: { tenantId: tenantId(), employeeId: id, kind: input.kind, title: input.title, position } });
    });
  }

  @Patch('tasks/:id')
  @RequirePermission(WORK)
  tick(@Param('id') id: string, @Body() body: unknown) {
    const { done } = parse(z.object({ done: z.boolean() }), body);
    return this.db.tenant(async (tx) => {
      const t = await tx.employeeTask.findUnique({ where: { id } });
      if (!t) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
      await this.employee(tx, t.employeeId, WORK);
      return tx.employeeTask.update({ where: { id }, data: done ? { doneAt: new Date(), doneById: auth().userId } : { doneAt: null, doneById: null } });
    });
  }

  // ── Documents (stored encrypted) ──

  @Get('employees/:id/documents')
  @RequirePermission(SECRET)
  documents(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await this.employee(tx, id, SECRET);
      return tx.employeeDocument.findMany({ where: { employeeId: id }, orderBy: [{ isArchived: 'asc' }, { createdAt: 'desc' }], select: { id: true, docType: true, fileName: true, mimeType: true, sizeBytes: true, expiresAt: true, isArchived: true, createdAt: true } });
    });
  }

  @Post('employees/:id/documents')
  @RequirePermission(SECRET)
  async upload(@Param('id') id: string, @Query() query: unknown, @Req() req: Request) {
    const q = parse(DocQuery, query);
    const data = await readBody(req);
    const type = docType(data);
    if (!type) throw new BadRequestException({ code: 'UNSUPPORTED_FILE', message: 'Choose a PDF, JPG or PNG file' });
    const allowed = await this.db.tenant(async (tx) => { await this.employee(tx, id, SECRET); return (await settings(tx)).docTypes; });
    if (!allowed.includes(q.docType)) throw new BadRequestException({ code: 'INVALID_DOC_TYPE', message: 'Choose a document type from the list' });
    const key = `${tenantId()}/hr/${id}/${randomToken(9).replace(/[^A-Za-z0-9]/g, 'x')}`;
    await storage.put(key, data);
    return this.db.tenant(async (tx) => {
      const d = await tx.employeeDocument.create({ data: { tenantId: tenantId(), employeeId: id, docType: q.docType, fileName: q.fileName.replace(/[^\w .()-]/g, '_'), fileKey: key, mimeType: type, sizeBytes: data.length, expiresAt: q.expiresOn ? noon(q.expiresOn) : null, uploadedById: auth().userId }, select: { id: true, docType: true, fileName: true } });
      await this.db.audit(tx, { entity: 'employee', entityId: id, action: 'employee.document_added', newValue: { docType: q.docType, fileName: d.fileName } });
      return d;
    });
  }

  @Get('documents/:id/file')
  @RequirePermission(SECRET)
  async file(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const d = await this.db.tenant(async (tx) => {
      const doc = await tx.employeeDocument.findUnique({ where: { id } });
      if (!doc) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
      await this.employee(tx, doc.employeeId, SECRET);
      await this.db.audit(tx, { entity: 'employee', entityId: doc.employeeId, action: 'employee.document_opened', newValue: { docType: doc.docType } });
      return doc;
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(await storage.get(d.fileKey), { type: d.mimeType, disposition: `attachment; filename="${d.fileName.replace(/"/g, '')}"` });
  }

  @Patch('documents/:id')
  @RequirePermission(SECRET)
  archiveDoc(@Param('id') id: string, @Body() body: unknown) {
    const { isArchived } = parse(z.object({ isArchived: z.boolean() }), body);
    return this.db.tenant(async (tx) => {
      const doc = await tx.employeeDocument.findUnique({ where: { id } });
      if (!doc) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' });
      await this.employee(tx, doc.employeeId, SECRET);
      await tx.employeeDocument.update({ where: { id }, data: { isArchived } });
      await this.db.audit(tx, { entity: 'employee', entityId: doc.employeeId, action: isArchived ? 'employee.document_archived' : 'employee.document_restored', newValue: { docType: doc.docType } });
      return { ok: true };
    });
  }

  // ── Assets ──

  @Get('assets')
  @RequirePermission(ASSETS)
  assets(@Query() query: unknown) {
    const q = parse(z.object({ status: z.enum(['available', 'assigned', 'repair', 'retired']).optional(), q: z.string().trim().max(80).optional() }), query);
    return this.db.tenant(async (tx) => {
      const rows = await tx.asset.findMany({ where: { AND: [q.q ? { OR: [{ tag: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }, { serialNo: { contains: q.q, mode: 'insensitive' } }] } : {}] }, orderBy: { tag: 'asc' }, include: { assignments: { where: { returnedAt: null }, include: { employee: { select: { id: true, name: true, employeeCode: true } } } } }, take: 3000 });
      const counts = { available: 0, assigned: 0, repair: 0, retired: 0 } as Record<string, number>;
      for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return { rows: (q.status ? rows.filter((r) => r.status === q.status) : rows).map(({ assignments, ...a }) => ({ ...a, holder: assignments[0]?.employee ?? null })), counts };
    });
  }

  private assetData(input: Partial<z.infer<typeof AssetBody>>) {
    const { purchasedOn, warrantyEndOn, ...rest } = input;
    return { ...rest, ...(purchasedOn !== undefined ? { purchasedAt: day(purchasedOn) } : {}), ...(warrantyEndOn !== undefined ? { warrantyEnd: day(warrantyEndOn) } : {}) };
  }

  @Post('assets')
  @RequirePermission(ASSETS)
  addAsset(@Body() body: unknown) {
    const input = parse(AssetBody, body);
    return this.db.tenant(async (tx) => {
      if (await tx.asset.findFirst({ where: { tag: { equals: input.tag, mode: 'insensitive' } } })) throw new ConflictException({ code: 'DUPLICATE_TAG', message: 'Another asset already has this tag' });
      const a = await tx.asset.create({ data: { ...this.assetData(input), tag: input.tag, name: input.name, category: input.category, tenantId: tenantId() } });
      await this.db.audit(tx, { entity: 'asset', entityId: a.id, action: 'asset.added', newValue: { tag: a.tag, name: a.name } });
      return a;
    });
  }

  @Put('assets/:id')
  @RequirePermission(ASSETS)
  editAsset(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(AssetBody.partial().extend({ status: z.enum(['available', 'repair', 'retired']).optional() }), body);
    return this.db.tenant(async (tx) => {
      const a = await tx.asset.findUnique({ where: { id }, include: { assignments: { where: { returnedAt: null } } } });
      if (!a) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found' });
      if (input.status && a.assignments.length) throw new ConflictException({ code: 'ASSET_ISSUED', message: 'Take this asset back before changing its status' });
      if (input.tag && (await tx.asset.findFirst({ where: { id: { not: id }, tag: { equals: input.tag, mode: 'insensitive' } } }))) throw new ConflictException({ code: 'DUPLICATE_TAG', message: 'Another asset already has this tag' });
      const r = await tx.asset.update({ where: { id }, data: this.assetData(input) });
      await this.db.audit(tx, { entity: 'asset', entityId: id, action: 'asset.updated', newValue: input });
      return r;
    });
  }

  @Post('assets/:id/issue')
  @HttpCode(200)
  @RequirePermission(ASSETS)
  issue(@Param('id') id: string, @Body() body: unknown) {
    const { employeeId } = parse(z.object({ employeeId: z.string().uuid() }), body);
    return this.db.tenant(async (tx) => {
      const claimed = await tx.asset.updateMany({ where: { id, status: 'available' }, data: { status: 'assigned' } });
      if (!claimed.count) throw new ConflictException({ code: 'ASSET_NOT_AVAILABLE', message: 'This asset is not available to issue' });
      const e = await tx.employee.findUnique({ where: { id: employeeId } });
      if (!e || e.status === 'exited') throw new BadRequestException({ code: 'INVALID_EMPLOYEE', message: 'Choose a current employee' });
      await tx.assetAssignment.create({ data: { tenantId: tenantId(), assetId: id, employeeId } });
      await this.db.audit(tx, { entity: 'asset', entityId: id, action: 'asset.issued', newValue: { employeeId, employee: e.name } });
      return { ok: true };
    });
  }

  @Post('assets/:id/return')
  @HttpCode(200)
  @RequirePermission(ASSETS)
  takeBack(@Param('id') id: string, @Body() body: unknown) {
    const { condition } = parse(z.object({ condition: z.enum(['good', 'damaged', 'lost']).default('good') }), body);
    return this.db.tenant(async (tx) => {
      const open = await tx.assetAssignment.findFirst({ where: { assetId: id, returnedAt: null } });
      if (!open) throw new BadRequestException({ code: 'NOT_ISSUED', message: 'This asset is not with anyone' });
      await tx.assetAssignment.update({ where: { id: open.id }, data: { returnedAt: new Date(), returnCondition: condition } });
      await tx.asset.update({ where: { id }, data: { status: condition === 'good' ? 'available' : condition === 'lost' ? 'retired' : 'repair', condition } });
      await this.db.audit(tx, { entity: 'asset', entityId: id, action: 'asset.returned', newValue: { employeeId: open.employeeId, condition } });
      return { ok: true };
    });
  }
}
