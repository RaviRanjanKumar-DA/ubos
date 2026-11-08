import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { istText } from '../common/ist';
import { z } from 'zod';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { visibleUserIds } from '../common/people';
import { notify, validMentions } from '../common/notify';
import { activity } from '../common/lead-ops';

const ViewBody = z.object({
  name: z.string().trim().min(2).max(60),
  workspaceId: z.string().uuid().nullable().optional(),
  query: z.record(z.unknown()).refine((q) => JSON.stringify(q).length < 8000, 'Filters are too long'),
  columns: z.array(z.string().max(60)).max(30).default([]),
  layout: z.enum(['list', 'board']).default('list'),
});
const ViewShare = z.object({ sharedRoleIds: z.array(z.string().uuid()).max(50) });
const TaskBody = z.object({
  type: z.enum(['task', 'meeting', 'call']).default('task'),
  title: z.string().trim().min(2).max(140),
  notes: z.string().trim().max(3000).nullable().optional(),
  dueAt: z.coerce.date(),
  durationMin: z.number().int().min(5).max(24 * 60).nullable().optional(),
  location: z.string().trim().max(300).nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  assigneeId: z.string().uuid().optional(),
  mentionIds: z.array(z.string().uuid()).max(20).optional(),
});
const TaskPatch = TaskBody.partial().extend({ done: z.boolean().optional() });
const TaskQuery = z.object({
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), leadId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(), status: z.enum(['open', 'done', 'all']).default('open'),
});
const CalendarQuery = z.object({ from: z.coerce.date(), to: z.coerce.date(), assigneeId: z.string().uuid().optional() });
const ReadBody = z.object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() });

/** Smart views, tasks & meetings, calendar and in-app notifications. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class ViewsTasksController {
  constructor(private db: DbService) {}

  // ── Smart views ──

  @Get('views')
  @RequirePermission('crm.lead.view')
  views() {
    return this.db.tenant(async (tx) => {
      const roleIds = await this.myRoleIds(tx);
      const rows = await tx.savedView.findMany({ where: { OR: [{ ownerId: auth().userId }, { sharedRoleIds: { hasSome: roleIds } }] }, orderBy: { name: 'asc' } });
      const owners = new Map((await tx.user.findMany({ where: { id: { in: rows.map((r) => r.ownerId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      return rows
        .filter((v) => !v.workspaceId || auth().accessibleWorkspaceIds.includes(v.workspaceId))
        .map((v) => ({ ...v, isMine: v.ownerId === auth().userId, owner: owners.get(v.ownerId) ?? null }));
    });
  }

  @Post('views')
  @RequirePermission('crm.lead.view')
  createView(@Body() body: unknown) {
    const input = parse(ViewBody, body);
    if (input.workspaceId && !auth().accessibleWorkspaceIds.includes(input.workspaceId)) throw new ForbiddenException({ code: 'WORKSPACE_FORBIDDEN', message: 'No access to this business line' });
    return this.db.tenant((tx) => tx.savedView.create({
      data: { tenantId: tenantId(), ownerId: auth().userId, name: input.name, workspaceId: input.workspaceId ?? null, query: input.query as Prisma.InputJsonValue, columns: input.columns, layout: input.layout },
    }));
  }

  @Patch('views/:id')
  @RequirePermission('crm.lead.view')
  updateView(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ViewBody.partial(), body);
    return this.db.tenant(async (tx) => {
      await this.ownView(tx, id);
      const { query, ...rest } = input;
      return tx.savedView.update({ where: { id }, data: { ...rest, ...(query ? { query: query as Prisma.InputJsonValue } : {}) } });
    });
  }

  /** Shares a view with roles (everyone keeps seeing only the leads their own access allows). */
  @Patch('views/:id/sharing')
  @RequirePermission('crm.view.share')
  shareView(@Param('id') id: string, @Body() body: unknown) {
    const { sharedRoleIds } = parse(ViewShare, body);
    return this.db.tenant(async (tx) => {
      await this.ownView(tx, id);
      if ((await tx.role.count({ where: { id: { in: sharedRoleIds } } })) !== new Set(sharedRoleIds).size) throw new BadRequestException({ code: 'INVALID_ROLE', message: 'Unknown role' });
      const v = await tx.savedView.update({ where: { id }, data: { sharedRoleIds } });
      await this.db.audit(tx, { entity: 'saved_view', entityId: id, action: 'saved_view.shared', newValue: { roles: sharedRoleIds } });
      return v;
    });
  }

  /** Views are personal settings: the owner may remove them. */
  @Delete('views/:id')
  @RequirePermission('crm.lead.view')
  deleteView(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await this.ownView(tx, id);
      await tx.savedView.delete({ where: { id } });
      return { ok: true };
    });
  }

  // ── Tasks & meetings ──

  @Get('tasks')
  @RequirePermission('crm.lead.view')
  tasks(@Query() query: unknown) {
    const q = parse(TaskQuery, query);
    return this.db.tenant(async (tx) => this.out(tx, await tx.task.findMany({
      where: {
        AND: [
          await this.taskScope(tx),
          ...(q.leadId ? [{ leadId: q.leadId }] : []),
          ...(q.assigneeId ? [{ assigneeId: q.assigneeId }] : []),
          ...(q.status === 'open' ? [{ doneAt: null }] : q.status === 'done' ? [{ doneAt: { not: null } }] : []),
          ...(q.from || q.to ? [{ dueAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } }] : []),
        ],
      },
      orderBy: { dueAt: 'asc' }, take: 500,
    })));
  }

  @Post('tasks')
  @RequirePermission('crm.lead.view')
  createTask(@Body() body: unknown) {
    const input = parse(TaskBody, body);
    return this.db.tenant(async (tx) => {
      const lead = input.leadId ? await this.leadFor(tx, input.leadId) : null;
      const assigneeId = input.assigneeId ?? lead?.ownerId ?? auth().userId;
      await this.assertAssignee(tx, assigneeId);
      const mentions = await validMentions(tx, input.mentionIds);
      const t = await tx.task.create({
        data: {
          tenantId: tenantId(), workspaceId: lead?.workspaceId ?? auth().workspaceId, leadId: lead?.id ?? null, type: input.type, title: input.title,
          notes: input.notes ?? null, dueAt: input.dueAt, durationMin: input.durationMin ?? null, location: input.location ?? null,
          assigneeId, createdById: auth().userId, mentionIds: mentions,
        },
      });
      if (lead) await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'task', data: { taskId: t.id, kind: t.type, title: t.title, dueAt: t.dueAt.toISOString() } }) });
      const link = lead ? `/app/leads/${lead.id}` : '/app/calendar';
      await notify(tx, [assigneeId], { type: 'assignment', title: `${auth().name} gave you a ${t.type}: ${t.title}`, body: istText(t.dueAt), link });
      await notify(tx, mentions.filter((m) => m !== assigneeId), { type: 'mention', title: `${auth().name} mentioned you in “${t.title}”`, body: t.notes, link });
      return t;
    });
  }

  @Patch('tasks/:id')
  @RequirePermission('crm.lead.view')
  updateTask(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(TaskPatch, body);
    return this.db.tenant(async (tx) => {
      const t = await tx.task.findFirst({ where: { AND: [await this.taskScope(tx), { id }] } });
      if (!t) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
      if (t.assigneeId !== auth().userId && t.createdById !== auth().userId && !auth().permissions['crm.lead.assign']) {
        throw new ForbiddenException({ code: 'NOT_YOURS', message: 'Only the assignee, the creator or a manager can change this' });
      }
      if (input.assigneeId && input.assigneeId !== t.assigneeId) await this.assertAssignee(tx, input.assigneeId);
      const { done, mentionIds: _m, leadId: _l, ...rest } = input;
      const updated = await tx.task.update({
        where: { id },
        data: { ...rest, ...(done !== undefined ? { doneAt: done ? new Date() : null } : {}), ...(input.dueAt && input.dueAt.getTime() !== t.dueAt.getTime() ? { remindedAt: null } : {}) },
      });
      if (input.assigneeId && input.assigneeId !== t.assigneeId) {
        await notify(tx, [input.assigneeId], { type: 'assignment', title: `${auth().name} gave you a ${t.type}: ${updated.title}`, link: t.leadId ? `/app/leads/${t.leadId}` : '/app/calendar' });
      }
      return updated;
    });
  }

  /** Tasks, meetings and lead follow-ups in one calendar. */
  @Get('calendar')
  @RequirePermission('crm.lead.view')
  calendar(@Query() query: unknown) {
    const q = parse(CalendarQuery, query);
    if (q.to.getTime() - q.from.getTime() > 62 * 86_400_000) throw new BadRequestException({ code: 'RANGE_TOO_LONG', message: 'Pick at most two months' });
    return this.db.tenant(async (tx) => {
      const [tasks, followUps] = await Promise.all([
        tx.task.findMany({ where: { AND: [await this.taskScope(tx), { dueAt: { gte: q.from, lt: q.to } }, ...(q.assigneeId ? [{ assigneeId: q.assigneeId }] : [])] }, orderBy: { dueAt: 'asc' }, take: 1000 }),
        tx.followUp.findMany({
          where: { dueAt: { gte: q.from, lt: q.to }, lead: await scopeFilter(tx, 'crm.lead.view'), ...(q.assigneeId ? { userId: q.assigneeId } : {}) },
          include: { lead: { select: { id: true, customer: { select: { name: true } } } } }, orderBy: { dueAt: 'asc' }, take: 1000,
        }),
      ]);
      const names = new Map((await tx.user.findMany({ where: { id: { in: [...tasks.map((t) => t.assigneeId), ...followUps.map((f) => f.userId)] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      return [
        ...(await this.out(tx, tasks)).map((t) => ({ kind: t.type, id: t.id, title: t.title, at: t.dueAt, durationMin: t.durationMin, done: !!t.doneAt, assignee: t.assignee, leadId: t.leadId, leadName: t.leadName, location: t.location })),
        ...followUps.map((f) => ({ kind: 'follow_up', id: f.id, title: f.note || 'Follow-up call', at: f.dueAt, durationMin: null, done: !!f.doneAt, assignee: names.get(f.userId) ?? null, leadId: f.lead.id, leadName: f.lead.customer.name, location: null })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    });
  }

  // ── Notifications ──

  @Get('notifications')
  @RequirePermission('crm.lead.view')
  notifications() {
    return this.db.tenant(async (tx) => {
      const [items, unread] = await Promise.all([
        tx.notification.findMany({ where: { userId: auth().userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
        tx.notification.count({ where: { userId: auth().userId, readAt: null } }),
      ]);
      return { unread, items };
    });
  }

  @Post('notifications/read')
  @HttpCode(200)
  @RequirePermission('crm.lead.view')
  read(@Body() body: unknown) {
    const { ids, all } = parse(ReadBody, body);
    return this.db.tenant(async (tx) => {
      const r = await tx.notification.updateMany({ where: { userId: auth().userId, readAt: null, ...(all ? {} : { id: { in: ids ?? [] } }) }, data: { readAt: new Date() } });
      return { read: r.count };
    });
  }

  // ── helpers ──

  private async myRoleIds(tx: Tx) {
    return (await tx.role.findMany({ where: { name: { in: auth().assignments.map((x) => x.roleName) } }, select: { id: true } })).map((r) => r.id);
  }

  private async ownView(tx: Tx, id: string) {
    const v = await tx.savedView.findUnique({ where: { id } });
    if (!v) throw new NotFoundException({ code: 'VIEW_NOT_FOUND', message: 'View not found' });
    if (v.ownerId !== auth().userId) throw new ForbiddenException({ code: 'NOT_OWNER', message: 'Only the owner can change this view' });
    return v;
  }

  /** Tasks I may see: mine, ones I created, and those of the people my lead access covers. */
  private async taskScope(tx: Tx): Promise<Prisma.TaskWhereInput> {
    const people = await visibleUserIds(tx);
    const me = auth().userId;
    return people === null ? {} : { OR: [{ assigneeId: { in: people } }, { createdById: me }, { mentionIds: { has: me } }] };
  }

  private async leadFor(tx: Tx, id: string) {
    const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.lead.view'), { id }] } });
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
    return lead;
  }

  /** Giving a task to someone else needs the assign permission and that person within my reach. */
  private async assertAssignee(tx: Tx, userId: string) {
    if (userId === auth().userId) return;
    if (!auth().permissions['crm.lead.assign']) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You can only plan tasks for yourself' });
    const people = await visibleUserIds(tx);
    const u = await tx.user.findFirst({ where: { id: userId, isActive: true } });
    if (!u || (people && !people.includes(userId))) throw new BadRequestException({ code: 'INVALID_ASSIGNEE', message: 'That person is not in your team or business line' });
  }

  private async out(tx: Tx, tasks: Prisma.TaskGetPayload<object>[]) {
    const users = new Map((await tx.user.findMany({ where: { id: { in: [...tasks.map((t) => t.assigneeId), ...tasks.map((t) => t.createdById)] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const leads = new Map((await tx.lead.findMany({ where: { id: { in: tasks.map((t) => t.leadId).filter(Boolean) as string[] } }, select: { id: true, customer: { select: { name: true } } } })).map((l) => [l.id, l.customer.name]));
    return tasks.map((t) => ({ ...t, assignee: users.get(t.assigneeId) ?? null, createdBy: users.get(t.createdById) ?? null, leadName: t.leadId ? leads.get(t.leadId) ?? null : null, overdue: !t.doneAt && t.dueAt < new Date() }));
  }
}
