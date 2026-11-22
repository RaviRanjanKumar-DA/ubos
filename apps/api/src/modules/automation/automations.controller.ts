import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { API_METHODS, REPORTS, nextRun, reportCell, toCsv } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, contextStore, tenantId, type TenantInfo } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { authFor } from '../../common/auth-for';
import { callApiTemplate } from '../../common/api-templates';
import { encrypt, decrypt } from '../../auth/crypto';
import { Mailer } from '../../auth/mailer';
import { DOWNLOAD, ReportsController } from '../analytics/reports.controller';

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 09:00');
const ScheduleBody = z.object({
  name: z.string().trim().min(2).max(80), reportKey: z.string().max(40), range: z.enum(['today', 'yesterday', 'this_week', 'last_7_days', 'last_30_days', 'this_month', 'last_month', 'this_quarter']).default('yesterday'),
  workspaceId: z.string().uuid().nullable().optional(), ownerFilterId: z.string().uuid().nullable().optional(), source: z.string().max(60).nullable().optional(),
  frequency: z.enum(['daily', 'weekly', 'monthly']), weekday: z.number().int().min(0).max(6).nullable().optional(), monthDay: z.number().int().min(1).max(28).nullable().optional(), time: Time,
  recipientIds: z.array(z.string().uuid()).min(1).max(30),
});
const TemplateBody = z.object({
  name: z.string().trim().min(2).max(80), method: z.enum(API_METHODS), url: z.string().trim().min(8).max(1000).refine((u) => /^https?:\/\//i.test(u), 'Start the address with https://'),
  headers: z.record(z.string().trim().min(1).max(100), z.string().max(2000)).optional(), keepHeaders: z.boolean().optional(), body: z.string().max(10_000).nullable().optional(), workspaceId: z.string().uuid().nullable().optional(),
});

/** Sends scheduled report emails that are due. Runs inside the scheduler, once per organization per minute. */
@Injectable()
export class ReportScheduleRunner {
  private readonly log = new Logger('ReportSchedules');
  constructor(private db: DbService, private mailer: Mailer) {}
  async run(t: TenantInfo) {
    const due = await this.db.tenant((tx) => tx.reportSchedule.findMany({ where: { isActive: true, isArchived: false, nextRunAt: { lte: new Date() } }, take: 20 }));
    let sent = 0;
    for (const s of due) {
      const next = nextRun({ frequency: s.frequency as never, time: s.time, weekday: s.weekday, monthDay: s.monthDay }, new Date());
      let status = 'sent';
      try {
        const authInfo = await authFor(this.db, t, s.createdById, 'schedule');
        const def = REPORTS.find((r) => r.key === s.reportKey);
        if (!authInfo.permissions['dashboard.view' as never]) throw new Error('the creator can no longer view reports');
        if (def?.detail && !authInfo.permissions['crm.lead.export' as never]) throw new Error('the creator can no longer export leads');
        const { csv, rows, label, emails } = await contextStore.run({ traceId: `sched-${s.id}`, ip: null, tenant: t, auth: authInfo }, () => this.db.tenant(async (tx) => {
          const r = await ReportsController.build(tx, s.reportKey, { range: s.range as never, workspaceId: s.workspaceId ?? undefined, ownerId: s.ownerFilterId ?? undefined, source: s.source ?? undefined }, DOWNLOAD);
          const people = await tx.user.findMany({ where: { id: { in: s.recipientIds }, isActive: true }, select: { email: true } });
          return { csv: '﻿' + toCsv([r.columns.map((c) => c.label), ...r.rows.map((row) => r.columns.map((c) => reportCell(row[c.key], c.format)))]), rows: r.rows.length, label: r.period.label, emails: people.map((p) => p.email).filter(Boolean) as string[] };
        }));
        const file = `${s.reportKey}-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.csv`;
        for (const e of emails) await this.mailer.send(e, `${s.name}: ${label}`, `${s.name} for ${label}: ${rows} rows, attached as ${file} (opens in Excel).\n\nSent by UBOS on a schedule set by your team. Change it under Automations → Schedules.`, [{ filename: file, content: csv, contentType: 'text/csv; charset=utf-8' }]);
        sent++;
        status = `sent to ${emails.length} at ${new Date().toISOString()}`;
      } catch (e) {
        status = `failed: ${e instanceof Error ? e.message : e}`.slice(0, 300);
        this.log.warn(`${t.slug} schedule ${s.id}: ${status}`);
      }
      await this.db.tenant(async (tx) => {
        await tx.reportSchedule.update({ where: { id: s.id }, data: { lastRunAt: new Date(), lastStatus: status, nextRunAt: next } });
        await this.db.audit(tx, { entity: 'report_schedule', entityId: s.id, action: status.startsWith('sent') ? 'report_schedule.sent' : 'report_schedule.failed', newValue: { report: s.reportKey, status } });
      });
    }
    return sent;
  }
}

/** Automations: scheduled report emails and API templates. */
@Controller('api/v1/automation')
export class AutomationsController {
  constructor(private db: DbService) {}

  // ---- Schedules ----
  @Get('schedules')
  @RequirePermission('dashboard.view')
  schedules() {
    return this.db.tenant(async (tx) => {
      const rows = await tx.reportSchedule.findMany({ where: { isArchived: false, ...(auth().permissions['dashboard.view' as never] === 'ORGANIZATION' ? {} : { createdById: auth().userId }) }, orderBy: { createdAt: 'desc' } });
      const users = new Map((await tx.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [...r.recipientIds, r.createdById]))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      return rows.map((r) => ({ ...r, createdBy: users.get(r.createdById) ?? '—', recipients: r.recipientIds.map((id) => users.get(id) ?? '—') }));
    });
  }

  private checkSchedule(input: z.infer<typeof ScheduleBody>) {
    const def = REPORTS.find((r) => r.key === input.reportKey && r.ready);
    if (!def) throw new BadRequestException({ code: 'UNKNOWN_REPORT', message: 'Choose a report' });
    if (def.detail && !auth().permissions['crm.lead.export' as never]) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `Emailing ${def.title} needs "Export leads"` });
    if (input.frequency === 'weekly' && (input.weekday === null || input.weekday === undefined)) throw new BadRequestException({ code: 'WEEKDAY_REQUIRED', message: 'Choose the day of the week' });
    if (input.frequency === 'monthly' && !input.monthDay) throw new BadRequestException({ code: 'MONTHDAY_REQUIRED', message: 'Choose the day of the month' });
    return { name: input.name, reportKey: input.reportKey, range: input.range, workspaceId: input.workspaceId ?? null, ownerFilterId: input.ownerFilterId ?? null, source: input.source || null, frequency: input.frequency, weekday: input.frequency === 'weekly' ? input.weekday! : null, monthDay: input.frequency === 'monthly' ? input.monthDay! : null, time: input.time, recipientIds: [...new Set(input.recipientIds)], nextRunAt: nextRun({ frequency: input.frequency, time: input.time, weekday: input.weekday, monthDay: input.monthDay }, new Date()) };
  }
  private async mine(tx: Tx, id: string) {
    const s = await tx.reportSchedule.findFirst({ where: { id, isArchived: false } });
    if (!s || (s.createdById !== auth().userId && auth().permissions['dashboard.view' as never] !== 'ORGANIZATION')) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: 'Schedule not found' });
    return s;
  }
  private async validRecipients(tx: Tx, ids: string[]) {
    if ((await tx.user.count({ where: { id: { in: ids }, isActive: true } })) !== new Set(ids).size) throw new BadRequestException({ code: 'BAD_RECIPIENTS', message: 'Choose active users as recipients' });
  }

  @Post('schedules')
  @RequirePermission('dashboard.view')
  createSchedule(@Body() body: unknown) {
    const data = this.checkSchedule(parse(ScheduleBody, body));
    return this.db.tenant(async (tx) => {
      await this.validRecipients(tx, data.recipientIds);
      const s = await tx.reportSchedule.create({ data: { tenantId: tenantId(), createdById: auth().userId, ...data } });
      await this.db.audit(tx, { entity: 'report_schedule', entityId: s.id, action: 'report_schedule.created', newValue: { name: s.name, report: s.reportKey, frequency: s.frequency, time: s.time, recipients: s.recipientIds.length } });
      return s;
    });
  }

  @Put('schedules/:id')
  @RequirePermission('dashboard.view')
  updateSchedule(@Param('id') id: string, @Body() body: unknown) {
    const data = this.checkSchedule(parse(ScheduleBody, body));
    return this.db.tenant(async (tx) => {
      await this.mine(tx, id);
      await this.validRecipients(tx, data.recipientIds);
      const s = await tx.reportSchedule.update({ where: { id }, data });
      await this.db.audit(tx, { entity: 'report_schedule', entityId: id, action: 'report_schedule.updated', newValue: { name: s.name, frequency: s.frequency, time: s.time } });
      return s;
    });
  }

  @Patch('schedules/:id')
  @RequirePermission('dashboard.view')
  patchSchedule(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ isActive: z.boolean().optional(), isArchived: z.boolean().optional(), runNow: z.boolean().optional() }), body);
    return this.db.tenant(async (tx) => {
      await this.mine(tx, id);
      await tx.reportSchedule.update({ where: { id }, data: { ...(input.isActive !== undefined ? { isActive: input.isActive } : {}), ...(input.isArchived ? { isArchived: true } : {}), ...(input.runNow ? { nextRunAt: new Date() } : {}) } });
      await this.db.audit(tx, { entity: 'report_schedule', entityId: id, action: input.isArchived ? 'report_schedule.archived' : input.runNow ? 'report_schedule.run_now' : input.isActive ? 'report_schedule.resumed' : 'report_schedule.paused' });
      return { ok: true };
    });
  }

  // ---- API templates ----
  private canManage(ws: string | null) {
    const s = auth().permissions['crm.automation.manage' as never] as string | undefined;
    return s === 'ORGANIZATION' || (!!s && !!ws && auth().workspaceId === ws);
  }

  @Get('api-templates')
  @RequireFeature('module.workflows')
  @RequirePermission('crm.lead.view')
  templates() {
    const ws = auth().workspaceId;
    return this.db.tenant(async (tx) => (await tx.apiTemplate.findMany({ where: { isArchived: false, OR: [{ workspaceId: null }, ...(ws ? [{ workspaceId: ws }] : [])] }, orderBy: { name: 'asc' } }))
      .map(({ headersEnc, ...t }) => ({ ...t, headerNames: headersEnc ? Object.keys(JSON.parse(decrypt(headersEnc))) : [] })));
  }

  @Post('api-templates')
  @RequireFeature('module.workflows')
  @RequirePermission('crm.automation.manage')
  createTemplate(@Body() body: unknown) {
    const input = parse(TemplateBody, body);
    const ws = input.workspaceId === undefined ? auth().workspaceId ?? null : input.workspaceId;
    if (!this.canManage(ws)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: ws ? 'Only this business line’s managers can add API templates' : 'Only organization-wide managers can add templates for every business line' });
    return this.db.tenant(async (tx) => {
      const t = await tx.apiTemplate.create({ data: { tenantId: tenantId(), workspaceId: ws, name: input.name, method: input.method, url: input.url, body: input.body ?? null, headersEnc: input.headers && Object.keys(input.headers).length ? encrypt(JSON.stringify(input.headers)) : null, createdById: auth().userId } });
      await this.db.audit(tx, { entity: 'api_template', entityId: t.id, action: 'api_template.created', newValue: { name: t.name, method: t.method, host: new URL(t.url.replace(/\{[^}]*\}/g, 'x')).host, headers: Object.keys(input.headers ?? {}) } });
      const { headersEnc, ...rest } = t;
      return { ...rest, headerNames: Object.keys(input.headers ?? {}) };
    });
  }

  /** Headers are write-only: send keepHeaders to leave the saved ones as they are. */
  @Put('api-templates/:id')
  @RequireFeature('module.workflows')
  @RequirePermission('crm.automation.manage')
  updateTemplate(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(TemplateBody, body);
    return this.db.tenant(async (tx) => {
      const old = await tx.apiTemplate.findFirst({ where: { id, isArchived: false } });
      if (!old) throw new NotFoundException({ code: 'API_TEMPLATE_NOT_FOUND', message: 'API template not found' });
      if (!this.canManage(old.workspaceId)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You cannot change this template' });
      const t = await tx.apiTemplate.update({ where: { id }, data: { name: input.name, method: input.method, url: input.url, body: input.body ?? null, ...(input.keepHeaders ? {} : { headersEnc: input.headers && Object.keys(input.headers).length ? encrypt(JSON.stringify(input.headers)) : null }) } });
      await this.db.audit(tx, { entity: 'api_template', entityId: id, action: 'api_template.updated', newValue: { name: t.name, method: t.method, headersChanged: !input.keepHeaders } });
      const { headersEnc, ...rest } = t;
      return { ...rest, headerNames: headersEnc ? Object.keys(JSON.parse(decrypt(headersEnc))) : [] };
    });
  }

  @Post('api-templates/:id/archive')
  @HttpCode(200)
  @RequireFeature('module.workflows')
  @RequirePermission('crm.automation.manage')
  archiveTemplate(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const t = await tx.apiTemplate.findFirst({ where: { id, isArchived: false } });
      if (!t || !this.canManage(t.workspaceId)) throw new NotFoundException({ code: 'API_TEMPLATE_NOT_FOUND', message: 'API template not found' });
      await tx.apiTemplate.update({ where: { id }, data: { isArchived: true } });
      await this.db.audit(tx, { entity: 'api_template', entityId: id, action: 'api_template.archived' });
      return { ok: true };
    });
  }

  /** Sends the call now, for a lead you can see (or with only the organization's values), and shows the answer. */
  @Post('api-templates/:id/test')
  @HttpCode(200)
  @RequireFeature('module.workflows')
  @RequirePermission('crm.automation.manage')
  test(@Param('id') id: string, @Body() body: unknown) {
    const { leadId } = parse(z.object({ leadId: z.string().uuid().optional() }), body ?? {});
    return this.db.tenant(async (tx) => {
      if (leadId && !(await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.lead.view'), { id: leadId }] }, select: { id: true } }))) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const r = await callApiTemplate(tx, id, leadId ?? null);
      await this.db.audit(tx, { entity: 'api_template', entityId: id, action: 'api_template.tested', newValue: { status: r.status } });
      return r;
    });
  }
}
