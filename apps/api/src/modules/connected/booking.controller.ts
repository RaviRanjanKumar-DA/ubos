import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Ip, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, ctx, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { istDate, istText } from '../../common/ist';
import { activity, eligibleOwners } from '../../common/lead-ops';
import { notify } from '../../common/notify';
import { Mailer } from '../../auth/mailer';
import { randomToken, sha256 } from '../../auth/crypto';
import { asTenant, IntakeService, rateLimit } from '../integration-runtime';
import { webBase } from './providers';

const IST_MIN = 330;
const Range = z.tuple([z.number().int().min(0).max(1440), z.number().int().min(0).max(1440)]).refine(([a, b]) => a < b, 'A start time must be before its end time');
const Hours = z.record(z.enum(['0', '1', '2', '3', '4', '5', '6']), z.array(Range).max(3));
const LinkBody = z.object({
  title: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).nullable().optional(), hostId: z.string().uuid().optional(),
  durationMin: z.number().int().refine((n) => [15, 30, 45, 60, 90, 120].includes(n), 'Choose a listed duration').default(30), bufferMin: z.number().int().min(0).max(120).default(0),
  noticeHours: z.number().int().min(0).max(720).default(4), horizonDays: z.number().int().min(1).max(90).default(30), hours: Hours, location: z.string().trim().max(300).nullable().optional(),
});
const LinkPatch = LinkBody.partial().extend({ isActive: z.boolean().optional(), isArchived: z.boolean().optional() });
const BookBody = z.object({
  name: z.string().trim().min(2).max(120), mobile: z.string().trim().max(30).optional().or(z.literal('')), email: z.string().trim().email().max(160).optional().or(z.literal('')),
  note: z.string().trim().max(1000).optional().or(z.literal('')), startAt: z.coerce.date(), _hp: z.string().optional(),
});

type Busy = { start: number; end: number };
export interface SlotRules { hours: Record<string, [number, number][]>; durationMin: number; bufferMin: number; noticeHours: number; horizonDays: number }

/** Free start times per IST day: inside the weekly hours, past the notice period, and clear of existing meetings (with the buffer either side). */
export function buildSlots(r: SlotRules, busy: Busy[], now: Date) {
  const [y, m, d] = istDate(now).split('-').map(Number);
  const earliest = now.getTime() + r.noticeHours * 3_600_000;
  const span = r.durationMin * 60_000, gap = r.bufferMin * 60_000;
  const days: { date: string; slots: string[] }[] = [];
  for (let i = 0; i <= r.horizonDays; i++) {
    const midnight = Date.UTC(y, m - 1, d + i);
    const slots: string[] = [];
    for (const [from, to] of r.hours[String(new Date(midnight).getUTCDay())] ?? []) {
      for (let min = from; min + r.durationMin <= to; min += Math.max(15, r.durationMin)) {
        const start = midnight + (min - IST_MIN) * 60_000;
        if (start < earliest) continue;
        if (busy.some((b) => start - gap < b.end && start + span + gap > b.start)) continue;
        slots.push(new Date(start).toISOString());
      }
    }
    if (slots.length) days.push({ date: new Date(midnight).toISOString().slice(0, 10), slots: slots.sort() });
  }
  return days;
}

async function busyFor(tx: Tx, hostId: string, now: Date, horizonDays: number): Promise<Busy[]> {
  const until = new Date(now.getTime() + (horizonDays + 2) * 86_400_000);
  const since = new Date(now.getTime() - 86_400_000);
  const [tasks, bookings] = await Promise.all([
    tx.task.findMany({ where: { assigneeId: hostId, type: 'meeting', doneAt: null, dueAt: { gte: since, lte: until } }, select: { dueAt: true, durationMin: true } }),
    tx.booking.findMany({ where: { hostId, status: 'booked', startAt: { gte: since, lte: until } }, select: { startAt: true, endAt: true } }),
  ]);
  return [
    ...tasks.map((t) => ({ start: t.dueAt.getTime(), end: t.dueAt.getTime() + (t.durationMin ?? 30) * 60_000 })),
    ...bookings.map((b) => ({ start: b.startAt.getTime(), end: b.endAt.getTime() })),
  ];
}

const KEY = 'crm.booking.manage';
const wide = () => ['WORKSPACE', 'ORGANIZATION'].includes(auth().permissions[KEY] ?? '');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'meeting';

/** Booking links: each person (or a manager for them) publishes when they can be booked. */
@Controller('api/v1/booking-links')
@RequireFeature('module.crm')
export class BookingLinksController {
  constructor(private db: DbService) {}

  private ws() {
    const w = auth().workspaceId;
    if (!w) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return w;
  }
  private async mine(tx: Tx, id: string) {
    const l = await tx.bookingLink.findFirst({ where: { id, workspaceId: this.ws(), isArchived: false, ...(wide() ? {} : { hostId: auth().userId }) } });
    if (!l) throw new NotFoundException({ code: 'LINK_NOT_FOUND', message: 'Booking link not found' });
    return l;
  }
  private async assertHost(tx: Tx, ws: string, hostId: string) {
    if (hostId !== auth().userId && !wide()) throw new BadRequestException({ code: 'HOST_NOT_ALLOWED', message: 'You can only create booking links for yourself' });
    if (!(await eligibleOwners(tx, ws)).some((u) => u.id === hostId)) throw new BadRequestException({ code: 'HOST_NOT_ALLOWED', message: 'This person does not work in this business line' });
  }

  @Get('options')
  @RequirePermission(KEY)
  options() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const people = await eligibleOwners(tx, ws);
      return { canPickHost: wide(), me: auth().userId, hosts: people.filter((u) => wide() || u.id === auth().userId).map((u) => ({ id: u.id, name: u.name })) };
    });
  }

  @Get()
  @RequirePermission(KEY)
  list() {
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const rows = await tx.bookingLink.findMany({ where: { workspaceId: ws, isArchived: false, ...(wide() ? {} : { hostId: auth().userId }) }, orderBy: { createdAt: 'desc' } });
      const names = new Map((await tx.user.findMany({ where: { id: { in: rows.map((r) => r.hostId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const upcoming = await tx.booking.groupBy({ by: ['linkId'], where: { linkId: { in: rows.map((r) => r.id) }, status: 'booked', startAt: { gte: new Date() } }, _count: true });
      const count = new Map(upcoming.map((u) => [u.linkId, u._count]));
      return rows.map((r) => ({ ...r, hostName: names.get(r.hostId) ?? '', upcoming: count.get(r.id) ?? 0, path: `/b/${ctx().tenant!.slug}/${r.slug}` }));
    });
  }

  @Post()
  @RequirePermission(KEY)
  create(@Body() body: unknown) {
    const input = parse(LinkBody, body);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const hostId = input.hostId ?? auth().userId;
      await this.assertHost(tx, ws, hostId);
      const base = slugify(input.title);
      let slug = base;
      for (let n = 2; await tx.bookingLink.findFirst({ where: { slug }, select: { id: true } }); n++) slug = `${base}-${n}`;
      const link = await tx.bookingLink.create({ data: { ...input, hostId, slug, tenantId: tenantId(), workspaceId: ws, createdById: auth().userId, description: input.description ?? null, location: input.location ?? null } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'booking_link', entityId: link.id, action: 'booking_link.created', newValue: { title: link.title, hostId, slug } });
      return link;
    });
  }

  @Patch(':id')
  @RequirePermission(KEY)
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(LinkPatch, body);
    return this.db.tenant(async (tx) => {
      const before = await this.mine(tx, id);
      if (input.hostId && input.hostId !== before.hostId) await this.assertHost(tx, before.workspaceId, input.hostId);
      const link = await tx.bookingLink.update({ where: { id }, data: input });
      await this.db.audit(tx, { workspaceId: before.workspaceId, entity: 'booking_link', entityId: id, action: input.isArchived ? 'booking_link.archived' : 'booking_link.updated', newValue: { title: link.title, isActive: link.isActive } });
      return link;
    });
  }

  @Get(':id/bookings')
  @RequirePermission(KEY)
  bookings(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await this.mine(tx, id);
      return tx.booking.findMany({ where: { linkId: id }, orderBy: { startAt: 'desc' }, take: 100, select: { id: true, name: true, mobile: true, email: true, note: true, startAt: true, endAt: true, status: true, leadId: true } });
    });
  }
}


/** The public booking page: no sign-in. Limited by IP, and a hidden field catches bots. */
@Controller('public/booking')
export class PublicBookingController {
  constructor(private db: DbService, private intake: IntakeService, private mailer: Mailer) {}

  private active(tx: Tx, slug: string) {
    return tx.bookingLink.findFirst({ where: { slug, isActive: true, isArchived: false } });
  }

  @Get(':org/cancel/:token')
  cancelInfo(@Param('org') org: string, @Param('token') token: string) {
    return asTenant(this.db, org, async (t) => {
      const b = await this.db.tenant((tx) => tx.booking.findFirst({ where: { cancelTokenHash: sha256(token) } }));
      if (!b) throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'This booking was not found' });
      return { organization: t.name, name: b.name, startAt: b.startAt, status: b.status, canCancel: b.status === 'booked' && b.startAt > new Date() };
    });
  }

  @Post(':org/cancel/:token')
  @HttpCode(200)
  cancel(@Param('org') org: string, @Param('token') token: string, @Ip() ip: string) {
    return asTenant(this.db, org, async () => {
      rateLimit(`booking-cancel:${ip}`, 20);
      return this.db.tenant(async (tx) => {
        const b = await tx.booking.findFirst({ where: { cancelTokenHash: sha256(token) } });
        if (!b) throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'This booking was not found' });
        if (b.status !== 'booked') return { ok: true, status: b.status };
        if (b.startAt <= new Date()) throw new BadRequestException({ code: 'TOO_LATE', message: 'This meeting has already started' });
        await tx.booking.update({ where: { id: b.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
        if (b.taskId) {
          const task = await tx.task.findUnique({ where: { id: b.taskId } });
          if (task) await tx.task.update({ where: { id: task.id }, data: { title: `Cancelled: ${task.title}`.slice(0, 200), doneAt: new Date() } });
        }
        if (b.leadId) {
          const lead = await tx.lead.findUnique({ where: { id: b.leadId } });
          if (lead) await tx.leadActivity.create({ data: activity(lead, b.hostId, { type: 'task', remark: `${b.name} cancelled the meeting on ${istText(b.startAt)}`, data: { bookingId: b.id, cancelled: true } }) });
        }
        await notify(tx, [b.hostId], { type: 'reminder', title: `${b.name} cancelled the meeting`, body: istText(b.startAt), link: b.leadId ? `/app/leads/${b.leadId}` : '/app/calendar' });
        return { ok: true, status: 'cancelled' };
      });
    });
  }

  @Get(':org/:link')
  page(@Param('org') org: string, @Param('link') slug: string) {
    return asTenant(this.db, org, async (t) => this.db.tenant(async (tx) => {
      const l = await this.active(tx, slug);
      if (!l) throw new NotFoundException({ code: 'LINK_NOT_FOUND', message: 'This booking page is not available' });
      const host = await tx.user.findUnique({ where: { id: l.hostId }, select: { name: true, isActive: true } });
      if (!host?.isActive) throw new NotFoundException({ code: 'LINK_NOT_FOUND', message: 'This booking page is not available' });
      const now = new Date();
      const days = buildSlots(l as unknown as SlotRules, await busyFor(tx, l.hostId, now, l.horizonDays), now);
      return { organization: t.name, title: l.title, description: l.description, durationMin: l.durationMin, location: l.location, host: host.name, days };
    }));
  }

  @Post(':org/:link')
  @HttpCode(200)
  book(@Param('org') org: string, @Param('link') slug: string, @Body() body: unknown, @Ip() ip: string) {
    const input = parse(BookBody, body);
    return asTenant(this.db, org, async (t) => {
      rateLimit(`booking:${t.id}:${ip}`, 10);
      if (input._hp) return { ok: true, startAt: input.startAt }; // the hidden field was filled: a bot, so pretend success
      const token = randomToken(24);
      // The slot is taken first, under a lock per host, so two visitors can never get the same time.
      const held = await this.db.tenant(async (tx) => {
        const l = await this.active(tx, slug);
        if (!l) throw new NotFoundException({ code: 'LINK_NOT_FOUND', message: 'This booking page is not available' });
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${l.hostId}`}))`;
        const now = new Date();
        const free = buildSlots(l as unknown as SlotRules, await busyFor(tx, l.hostId, now, l.horizonDays), now).some((d) => d.slots.includes(input.startAt.toISOString()));
        if (!free) throw new ConflictException({ code: 'SLOT_TAKEN', message: 'That time is no longer free. Please choose another.' });
        const booking = await tx.booking.create({
          data: { tenantId: t.id, linkId: l.id, hostId: l.hostId, name: input.name, mobile: input.mobile || null, email: input.email?.toLowerCase() || null, note: input.note || null, startAt: input.startAt, endAt: new Date(input.startAt.getTime() + l.durationMin * 60_000), cancelTokenHash: sha256(token) },
        });
        return { l, booking };
      });
      const { l, booking } = held;
      const out = await this.intake.process({
        tenantId: t.id, integrationKey: `booking:${l.slug}`, workspaceId: l.workspaceId, mode: 'add_remark', via: `booking link “${l.title}”`, record: { ...input, _hp: undefined }, externalId: `booking:${booking.id}`,
        input: { name: input.name, mobile: input.mobile || null, email: input.email || null, remark: [`Booked a meeting for ${istText(booking.startAt)}`, input.note || null].filter(Boolean).join('\n'), source: 'booking_link' },
      });
      if (out.outcome === 'rejected' || !out.leadId) {
        await this.db.tenant((tx) => tx.booking.update({ where: { id: booking.id }, data: { status: 'failed' } }));
        throw new BadRequestException({ code: 'INVALID', message: out.errors.join('. ') || 'Please check your details' });
      }
      await this.db.tenant(async (tx) => {
        const lead = await tx.lead.findUniqueOrThrow({ where: { id: out.leadId! } });
        const task = await tx.task.create({
          data: { tenantId: t.id, workspaceId: l.workspaceId, leadId: lead.id, type: 'meeting', title: `${l.title}: ${input.name}`.slice(0, 200), notes: input.note || null, dueAt: booking.startAt, durationMin: l.durationMin, location: l.location, assigneeId: l.hostId, createdById: l.hostId },
        });
        await tx.booking.update({ where: { id: booking.id }, data: { leadId: lead.id, taskId: task.id } });
        await tx.bookingLink.update({ where: { id: l.id }, data: { bookings: { increment: 1 } } });
        await tx.leadActivity.create({ data: activity(lead, l.hostId, { type: 'task', data: { taskId: task.id, kind: 'meeting', title: task.title, dueAt: task.dueAt.toISOString() } }) });
        const notifyIds = [...new Set([l.hostId, ...(lead.ownerId ? [lead.ownerId] : [])])];
        await notify(tx, notifyIds, { type: 'assignment', title: `${input.name} booked: ${l.title}`, body: istText(booking.startAt), link: `/app/leads/${lead.id}` });
      });
      if (input.email) {
        const cancelUrl = `${webBase()}/b/${t.slug}/cancel/${token}`;
        await this.mailer.send(input.email, `Your meeting is booked: ${l.title}`, [`Hello ${input.name},`, '', `Your meeting with ${t.name} is booked for ${istText(booking.startAt)} IST (${l.durationMin} minutes).`, l.location ? `Where: ${l.location}` : '', '', `To cancel: ${cancelUrl}`].filter((x, i, a) => x || a[i - 1]).join('\n')).catch(() => undefined);
      }
      return { ok: true, startAt: booking.startAt, cancelToken: token };
    });
  }
}
