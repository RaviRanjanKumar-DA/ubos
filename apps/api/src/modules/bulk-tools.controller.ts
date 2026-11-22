import { BadRequestException, Body, Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { istInstant, normalizeMobile, toCsv } from '@ubos/shared';
import type { Prisma, Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { visibleUserIds } from '../common/people';
import { activity } from '../common/lead-ops';

const Ids = z.array(z.string().uuid()).min(1).max(1000);
const TaskRows = z.object({
  dryRun: z.boolean().default(true),
  rows: z.array(z.object({ lead: z.string().max(120).optional(), assignee: z.string().max(160), title: z.string().max(150), type: z.string().max(20).optional(), due: z.string().max(40), durationMin: z.string().max(10).optional(), notes: z.string().max(1000).optional() })).min(1).max(2000),
});
const norm = (s: string) => s.trim().toLowerCase();

/** "2026-11-25 15:30", "25/11/2026 15:30" or a date alone (10:00), always read as India time. */
function istDue(v: string): Date | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  let y: number, mo: number, d: number, h = 10, mi = 0;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; if (m[4]) { h = +m[4]; mi = +m[5]; } }
  else {
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3]; if (m[4]) { h = +m[4]; mi = +m[5]; }
  }
  const day = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return istInstant(day, `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
}

/** Bulk tools: delete and restore leads, the Excel round trip for updating leads, and cancelling or uploading tasks in bulk. */
@Controller('api/v1')
export class BulkToolsController {
  constructor(private db: DbService) {}

  /** Deleted leads are kept: they leave every list, count and report, and can be restored. Open tasks on them are cancelled. */
  @Post('leads/delete')
  @HttpCode(200)
  @RequirePermission('crm.lead.delete')
  remove(@Body() body: unknown) {
    const input = parse(z.object({ leadIds: Ids, reason: z.string().trim().min(3).max(300) }), body);
    return this.db.tenant(async (tx) => {
      const leads = await tx.lead.findMany({ where: { AND: [await scopeFilter(tx, 'crm.lead.view'), { id: { in: input.leadIds } }] }, select: { id: true, tenantId: true, workspaceId: true, pipelineId: true, stageId: true, ownerId: true, customerId: true } });
      if (!leads.length) throw new BadRequestException({ code: 'NOTHING_TO_DELETE', message: 'None of these leads can be deleted by you' });
      const ids = leads.map((l) => l.id), now = new Date(), me = auth().userId;
      await tx.lead.updateMany({ where: { id: { in: ids } }, data: { deletedAt: now, deletedById: me, deleteReason: input.reason } });
      const tasks = await tx.task.updateMany({ where: { leadId: { in: ids }, doneAt: null }, data: { doneAt: now, cancelledAt: now, cancelledById: me } });
      await tx.sequenceEnrollment.updateMany({ where: { leadId: { in: ids }, status: 'active' }, data: { status: 'stopped', stopReason: 'lead deleted' } });
      await tx.automationFlowRun.updateMany({ where: { leadId: { in: ids }, status: { in: ['running', 'waiting'] } }, data: { status: 'stopped', error: 'lead deleted' } });
      await tx.leadActivity.createMany({ data: leads.map((l) => activity(l as never, me, { type: 'remark', remark: `Lead deleted: ${input.reason}`, data: { deleted: true } })) });
      await this.db.audit(tx, { entity: 'lead', entityId: ids.length === 1 ? ids[0] : 'bulk', action: 'lead.deleted', newValue: { count: ids.length, ids: ids.slice(0, 50), reason: input.reason, tasksCancelled: tasks.count } });
      return { deleted: ids.length, skipped: input.leadIds.length - ids.length, tasksCancelled: tasks.count };
    });
  }

  @Post('leads/restore')
  @HttpCode(200)
  @RequirePermission('crm.lead.delete')
  restore(@Body() body: unknown) {
    const input = parse(z.object({ leadIds: Ids }), body);
    return this.db.tenant(async (tx) => {
      const leads = await tx.lead.findMany({ where: { AND: [await scopeFilter(tx, 'crm.lead.view', { deleted: true }), { id: { in: input.leadIds } }] }, select: { id: true, tenantId: true, workspaceId: true, pipelineId: true, stageId: true, ownerId: true, customerId: true } });
      if (!leads.length) throw new BadRequestException({ code: 'NOTHING_TO_RESTORE', message: 'None of these leads are deleted' });
      const ids = leads.map((l) => l.id);
      await tx.lead.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null, deletedById: null, deleteReason: null } });
      await tx.leadActivity.createMany({ data: leads.map((l) => activity(l as never, auth().userId, { type: 'remark', remark: 'Lead restored', data: { restored: true } })) });
      await this.db.audit(tx, { entity: 'lead', entityId: ids.length === 1 ? ids[0] : 'bulk', action: 'lead.restored', newValue: { count: ids.length, ids: ids.slice(0, 50) } });
      return { restored: ids.length };
    });
  }

  /** The business line's leads in the "Update from Excel" format: change cells, upload back on the same page. */
  @Get('leads/update-export')
  @RequirePermission('crm.lead.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async updateExport(@Query('match') match = 'mobile') {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    const key = match === 'email' ? 'email' : match === 'customer_code' ? 'customer_code' : 'mobile';
    return this.db.tenant(async (tx) => {
      const [leads, stages, users, labels, fields, options] = await Promise.all([
        tx.lead.findMany({ where: { AND: [await scopeFilter(tx, 'crm.lead.view'), { workspaceId: ws }] }, orderBy: { createdAt: 'desc' }, take: 5000, include: { customer: { select: { name: true, mobile: true, email: true, code: true } } } }),
        tx.leadStage.findMany({ select: { id: true, name: true } }), tx.user.findMany({ select: { id: true, email: true } }), tx.label.findMany({ select: { id: true, name: true } }),
        tx.leadField.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: { position: "asc" }, select: { key: true } }),
        tx.workspaceOption.findMany({ where: { workspaceId: ws, kind: { in: ['lead_status', 'lead_source'] } }, select: { kind: true, value: true, label: true } }),
      ]);
      const name = (m: { id: string; name: string }[], id: string | null) => m.find((x) => x.id === id)?.name ?? '';
      const opt = (kind: string, v: string | null) => (v ? options.find((o) => o.kind === kind && o.value === v)?.label ?? v : '');
      const keyHead = key === 'email' ? 'Email' : key === 'customer_code' ? 'Customer ID' : 'Mobile';
      await this.db.audit(tx, { workspaceId: ws, entity: 'lead', entityId: 'export', action: 'lead.update_exported', newValue: { rows: leads.length } });
      return '﻿' + toCsv([
        [keyHead, 'Name', 'Stage', 'Status', 'Owner', 'Source', 'Labels', 'Follow up', 'Remark', ...fields.map((f) => `cf:${f.key}`)],
        ...leads.map((l) => [key === 'email' ? l.customer.email ?? '' : key === 'customer_code' ? l.customer.code : l.customer.mobile ?? '', l.customer.name, name(stages, l.stageId), opt('lead_status', l.status), users.find((u) => u.id === l.ownerId)?.email ?? '', opt('lead_source', l.source), l.labelIds.map((id) => name(labels, id)).filter(Boolean).join('; '), '', '', ...fields.map((f) => String(((l.customFields ?? {}) as Record<string, unknown>)[f.key] ?? ''))]),
      ]);
    });
  }

  /** Cancels open tasks the person may manage: their own, ones they set, or on leads they can update. */
  @Post('tasks/cancel')
  @HttpCode(200)
  @RequirePermission('crm.lead.view')
  cancelTasks(@Body() body: unknown) {
    const input = parse(z.object({ taskIds: Ids }), body);
    return this.db.tenant(async (tx) => {
      const me = auth().userId;
      const people = await visibleUserIds(tx);
      const tasks = await tx.task.findMany({ where: { id: { in: input.taskIds }, doneAt: null } });
      const updatable = new Set((await tx.lead.findMany({ where: { AND: [await scopeFilter(tx, 'crm.lead.update'), { id: { in: tasks.map((t) => t.leadId!).filter(Boolean) } }] }, select: { id: true } })).map((l) => l.id));
      const ok = tasks.filter((t) => t.assigneeId === me || t.createdById === me || (t.leadId && updatable.has(t.leadId)) || (!t.leadId && (people === null || people.includes(t.assigneeId))));
      const now = new Date();
      if (ok.length) await tx.task.updateMany({ where: { id: { in: ok.map((t) => t.id) }, doneAt: null }, data: { doneAt: now, cancelledAt: now, cancelledById: me } });
      await this.db.audit(tx, { entity: 'task', entityId: ok.length === 1 ? ok[0].id : 'bulk', action: 'task.bulk_cancelled', newValue: { count: ok.length } });
      return { cancelled: ok.length, skipped: input.taskIds.length - ok.length };
    });
  }

  /** Uploads tasks from a sheet: assignee by email, username or name; lead by mobile or email (optional); due in India time. */
  @Post('tasks/import')
  @HttpCode(200)
  @RequirePermission('crm.lead.import')
  importTasks(@Body() body: unknown) {
    const input = parse(TaskRows, body);
    return this.db.tenant(async (tx) => {
      const users = await tx.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true, username: true } });
      const scope = await scopeFilter(tx, 'crm.lead.view');
      const results: { row: number; status: 'ok' | 'error'; message?: string; title?: string }[] = [];
      const create: Prisma.TaskCreateManyInput[] = [];
      for (const [i, r] of input.rows.entries()) {
        const row = i + 2;
        const fail = (message: string) => results.push({ row, status: 'error', message, title: r.title });
        const who = users.filter((u) => norm(u.email ?? '') === norm(r.assignee) || norm(u.username ?? '') === norm(r.assignee) || norm(u.name) === norm(r.assignee));
        if (who.length !== 1) { fail(who.length ? `"${r.assignee}" matches more than one person; use the email` : `No active user "${r.assignee}"`); continue; }
        if (!r.title.trim()) { fail('Task title is empty'); continue; }
        const type = norm(r.type || 'task');
        if (!['task', 'meeting', 'call'].includes(type)) { fail(`Type must be task, meeting or call`); continue; }
        const due = istDue(r.due);
        if (!due) { fail(`"${r.due}" is not a date (use 2026-11-25 15:30 or 25/11/2026 15:30)`); continue; }
        let leadId: string | null = null, workspaceId = auth().workspaceId ?? null;
        if (r.lead?.trim()) {
          const mob = normalizeMobile(r.lead);
          const lead = await tx.lead.findFirst({ where: { AND: [scope, { customer: mob ? { mobile: mob } : { email: { equals: r.lead.trim(), mode: 'insensitive' } } }] }, orderBy: { createdAt: 'desc' }, select: { id: true, workspaceId: true } });
          if (!lead) { fail(`No lead you can see with "${r.lead}"`); continue; }
          leadId = lead.id; workspaceId = lead.workspaceId;
        }
        const duration = r.durationMin ? Number(r.durationMin) : null;
        if (duration !== null && !(duration > 0 && duration <= 1440)) { fail('Duration must be minutes between 1 and 1440'); continue; }
        create.push({ tenantId: tenantId(), workspaceId, leadId, type, title: r.title.trim(), notes: r.notes?.trim() || null, dueAt: due, durationMin: duration, assigneeId: who[0].id, createdById: auth().userId });
        results.push({ row, status: 'ok', title: r.title });
      }
      if (!input.dryRun && create.length) {
        await tx.task.createMany({ data: create });
        await this.db.audit(tx, { entity: 'task', entityId: 'bulk', action: 'task.bulk_uploaded', newValue: { created: create.length, failed: results.filter((x) => x.status === 'error').length } });
      }
      return { dryRun: input.dryRun, ok: create.length, failed: results.filter((x) => x.status === 'error').length, results };
    });
  }
}
