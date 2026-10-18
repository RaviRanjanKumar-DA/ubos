import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { FieldDef, normalizeMobile, parseDateInput, toCsv, validateCustomFields } from '@ubos/shared';
import { Prisma } from '@ubos/database';
import type { Tx } from '@ubos/database';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { activity, applyStageChange, eligibleOwners, syncNextFollowUp } from '../common/lead-ops';
import { contact, fieldAccess, lockedFields } from '../common/field-access';

const Match = z.enum(['mobile', 'email', 'customer_code']);
const cell = z.string().max(2000).optional();
const UpdateRows = z.object({
  dryRun: z.boolean().default(true),
  match: Match.default('mobile'),
  rows: z.array(z.object({
    key: z.string().max(120), stage: cell, status: cell, owner: cell, source: cell, labels: cell, followUp: cell, remark: cell,
    fields: z.record(z.string().max(2000)).optional(),
  })).min(1).max(5000),
});
const ActivityRows = z.object({
  dryRun: z.boolean().default(true),
  match: Match.default('mobile'),
  rows: z.array(z.object({
    key: z.string().max(120), type: z.string().max(20), date: z.string().max(40), disposition: cell, remark: cell, durationMin: cell, user: cell,
  })).min(1).max(5000),
});
const ExportQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  types: z.string().max(200).optional(),
});
type RowResult = { row: number; status: 'ok' | 'error'; message?: string; name?: string; changes?: string[] };
const norm = (s: string) => s.trim().toLowerCase();

/**
 * Data tools: bulk-update existing leads from Excel / CSV, import past calls & remarks from another CRM, and export
 * calls / remarks / actions. Every row is checked first (dry run), then applied with the same rules as the screens.
 */
@Controller('api/v1')
@RequireFeature('module.crm')
export class DataToolsController {
  constructor(private db: DbService) {}

  @Post('leads/bulk-update')
  @HttpCode(200)
  @RequirePermission('crm.lead.import')
  bulkUpdate(@Body() body: unknown) {
    const input = parse(UpdateRows, body);
    const ws = this.workspace();
    return this.db.tenant(async (tx) => {
      const ctx = await this.context(tx, ws);
      const fa = await fieldAccess(tx);
      const results: RowResult[] = [];
      let updated = 0;
      for (const [i, r] of input.rows.entries()) {
        const row = i + 2;
        const fail = (message: string, name?: string) => results.push({ row, status: 'error', message, name });
        const lead = await this.findLead(tx, ctx.scope, ws, input.match, r.key);
        if (typeof lead === 'string') { fail(lead); continue; }
        const name = lead.customer.name;
        const changes: string[] = [];
        const data: Prisma.LeadUncheckedUpdateInput = {};
        // stage
        let stage = null;
        if (r.stage?.trim()) {
          stage = ctx.stages.find((s) => s.pipelineId === lead.pipelineId && norm(s.name) === norm(r.stage!));
          if (!stage) { fail(`Stage "${r.stage}" is not in this lead's pipeline`, name); continue; }
          if (stage.id !== lead.stageId) changes.push(`stage → ${stage.name}`); else stage = null;
        }
        if (r.status?.trim()) {
          const st = ctx.statuses.find((o) => norm(o.label) === norm(r.status!) || o.value === norm(r.status!));
          if (!st) { fail(`Unknown status "${r.status}"`, name); continue; }
          if (st.value !== lead.status) { data.status = st.value; changes.push(`status → ${st.label}`); }
        }
        if (r.source?.trim()) {
          const so = ctx.sources.find((o) => norm(o.label) === norm(r.source!) || o.value === norm(r.source!));
          if (!so) { fail(`Unknown source "${r.source}"`, name); continue; }
          if (so.value !== lead.source) { data.source = so.value; changes.push(`source → ${so.label}`); }
        }
        let ownerId: string | null = null;
        if (r.owner?.trim()) {
          if (!auth().permissions['crm.lead.assign']) { fail('You cannot reassign leads', name); continue; }
          const u = ctx.users.find((x) => norm(x.email) === norm(r.owner!) || norm(x.name) === norm(r.owner!));
          if (!u || !ctx.eligible.includes(u.id)) { fail(`"${r.owner}" is not a user of this business line`, name); continue; }
          if (u.id !== lead.ownerId) { ownerId = u.id; changes.push(`owner → ${u.name}`); }
        }
        if (r.labels !== undefined && r.labels.trim()) {
          const names = r.labels.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
          const ids = names.map((n) => ctx.labels.find((l) => norm(l.name) === norm(n))?.id);
          if (ids.some((x) => !x)) { fail(`Unknown label in "${r.labels}"`, name); continue; }
          data.labelIds = [...new Set([...lead.labelIds, ...(ids as string[])])];
          changes.push(`labels + ${names.join(', ')}`);
        }
        let followUp: Date | null = null;
        if (r.followUp?.trim()) {
          followUp = parseDateInput(r.followUp);
          if (!followUp) { fail(`Follow-up date "${r.followUp}" not understood`, name); continue; }
          changes.push(`follow-up ${followUp.toISOString().slice(0, 10)}`);
        }
        let cf: Record<string, unknown> | null = null;
        if (r.fields && Object.keys(r.fields).length) {
          const locked = lockedFields(fa, Object.keys(r.fields).map((k) => `cf:${k}`));
          if (locked.length) { fail(`Your role cannot change ${locked.join(', ').replace(/cf:/g, '')}`, name); continue; }
          const { values, errors } = validateCustomFields(ctx.fields, Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v.trim() !== '')), { partial: true });
          if (Object.keys(errors).length) { fail(Object.values(errors)[0], name); continue; }
          cf = values;
          changes.push(...Object.keys(values).map((k) => `${ctx.fields.find((f) => f.key === k)?.label ?? k} updated`));
          data.customFields = { ...((lead.customFields ?? {}) as object), ...values } as Prisma.InputJsonObject;
        }
        if (stage) {
          // Stage rules are checked before anything on this row is written.
          if (stage.isLost) { fail('Moving to a Lost stage needs a reason — use Bulk actions → Change stage', name); continue; }
          const merged = { ...((lead.customFields ?? {}) as Record<string, unknown>), ...(cf ?? {}) };
          const missing = stage.requiredFieldKeys.filter((k) => merged[k] === undefined || merged[k] === null || merged[k] === '' || (Array.isArray(merged[k]) && !(merged[k] as unknown[]).length));
          if (missing.length) { fail(`Fill ${missing.map((k) => ctx.fields.find((f) => f.key === k)?.label ?? k).join(', ')} before moving to ${stage.name}`, name); continue; }
        }
        if (r.remark?.trim()) changes.push('remark added');
        if (!changes.length) { results.push({ row, status: 'ok', name, changes: ['nothing to change'] }); continue; }
        if (!input.dryRun) {
          if (stage) {
            const refused = await applyStageChange(tx, { ...lead, customFields: cf ? data.customFields : lead.customFields }, stage, auth().userId);
            if (refused) { fail(refused, name); continue; }
          }
          if (Object.keys(data).length) await tx.lead.update({ where: { id: lead.id }, data });
          if (data.status !== undefined) await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'status', data: { from: lead.status, to: data.status as string } }) });
          if (ownerId) {
            await tx.lead.update({ where: { id: lead.id }, data: { ownerId, assignedAt: new Date() } });
            await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'assignment', data: { from: lead.ownerId, to: ownerId } }) });
          }
          if (followUp) {
            await tx.followUp.create({ data: { tenantId: tenantId(), leadId: lead.id, dueAt: followUp, userId: ownerId ?? lead.ownerId ?? auth().userId, createdById: auth().userId } });
            await syncNextFollowUp(tx, lead.id);
          }
          if (r.remark?.trim()) await tx.leadActivity.create({ data: activity(lead, auth().userId, { type: 'remark', remark: r.remark.trim() }) });
          updated++;
        }
        results.push({ row, status: 'ok', name, changes });
      }
      if (!input.dryRun) await this.db.audit(tx, { workspaceId: ws, entity: 'lead', entityId: 'bulk-update', action: 'lead.bulk_updated_from_file', newValue: { rows: input.rows.length, updated } });
      return { dryRun: input.dryRun, ok: results.filter((r) => r.status === 'ok').length, errors: results.filter((r) => r.status === 'error').length, updated, results };
    }, { timeoutMs: 120_000 });
  }

  /** Past calls and remarks from another CRM, with their original dates. */
  @Post('leads/activities-import')
  @HttpCode(200)
  @RequirePermission('crm.lead.import')
  importActivities(@Body() body: unknown) {
    const input = parse(ActivityRows, body);
    const ws = this.workspace();
    return this.db.tenant(async (tx) => {
      const ctx = await this.context(tx, ws);
      const dispositions = await tx.workspaceOption.findMany({ where: { workspaceId: ws, kind: 'call_disposition' } });
      const results: RowResult[] = [];
      let created = 0;
      for (const [i, r] of input.rows.entries()) {
        const row = i + 2;
        const fail = (message: string, name?: string) => results.push({ row, status: 'error', message, name });
        const lead = await this.findLead(tx, ctx.scope, ws, input.match, r.key);
        if (typeof lead === 'string') { fail(lead); continue; }
        const name = lead.customer.name;
        const type = norm(r.type).startsWith('call') ? 'call' : norm(r.type).startsWith('remark') || norm(r.type) === 'note' ? 'remark' : null;
        if (!type) { fail(`Type must be "call" or "remark" (got "${r.type}")`, name); continue; }
        const at = parseDateInput(r.date);
        if (!at || at > new Date()) { fail(`Date "${r.date}" not understood or in the future`, name); continue; }
        let disp = null;
        if (type === 'call') {
          disp = dispositions.find((d) => norm(d.label) === norm(r.disposition ?? '') || d.value === norm(r.disposition ?? ''));
          if (!disp) { fail(`Unknown call outcome "${r.disposition ?? ''}"`, name); continue; }
        } else if (!r.remark?.trim()) { fail('Remark text is missing', name); continue; }
        let userId: string | null = auth().userId;
        if (r.user?.trim()) {
          const u = ctx.users.find((x) => norm(x.email) === norm(r.user!) || norm(x.name) === norm(r.user!));
          if (!u) { fail(`Unknown user "${r.user}"`, name); continue; }
          userId = u.id;
        }
        const minutes = r.durationMin?.trim() ? Number(r.durationMin) : 0;
        if (Number.isNaN(minutes) || minutes < 0) { fail(`Duration "${r.durationMin}" is not a number of minutes`, name); continue; }
        if (!input.dryRun) {
          await tx.leadActivity.create({
            data: {
              ...activity(lead, userId, { type, remark: r.remark?.trim() || null, disposition: disp?.value ?? null, connected: disp?.connected ?? null, durationSec: type === 'call' ? Math.round(minutes * 60) : null, data: { imported: true } }),
              createdAt: at,
            },
          });
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              ...(!lead.lastActivityAt || lead.lastActivityAt < at ? { lastActivityAt: at, ...(disp ? { lastDisposition: disp.value } : {}) } : {}),
              ...(!lead.firstResponseAt || lead.firstResponseAt > at ? { firstResponseAt: at } : {}),
            },
          });
          created++;
        }
        results.push({ row, status: 'ok', name, changes: [`${type} on ${at.toISOString().slice(0, 10)}`] });
      }
      if (!input.dryRun) await this.db.audit(tx, { workspaceId: ws, entity: 'lead', entityId: 'activities-import', action: 'lead.activities_imported', newValue: { rows: input.rows.length, created } });
      return { dryRun: input.dryRun, ok: results.filter((r) => r.status === 'ok').length, errors: results.filter((r) => r.status === 'error').length, created, results };
    }, { timeoutMs: 120_000 });
  }

  /** Calls, remarks, custom actions and other activity as CSV — within the person's lead scope, audited. */
  @Get('activities/export')
  @RequirePermission('crm.lead.export')
  async exportActivities(@Query() query: unknown, @Res() res: Response) {
    const q = parse(ExportQuery, query);
    const from = new Date(`${q.from}T00:00:00`);
    const to = new Date(new Date(`${q.to}T00:00:00`).getTime() + 86_400_000);
    if (to.getTime() - from.getTime() > 367 * 86_400_000) throw new BadRequestException({ code: 'RANGE_TOO_LONG', message: 'Pick at most one year' });
    const types = q.types?.split(',').map((t) => t.trim()).filter(Boolean);
    const rows = await this.db.tenant(async (tx) => {
      const acts = await tx.leadActivity.findMany({
        where: { createdAt: { gte: from, lt: to }, ...(types?.length ? { type: { in: types } } : {}), lead: await scopeFilter(tx, 'crm.lead.export') },
        include: { lead: { include: { customer: true, workspace: { select: { name: true } } } } },
        orderBy: { createdAt: 'asc' }, take: 50_000,
      });
      const users = new Map((await tx.user.findMany({ where: { id: { in: acts.map((a) => a.userId).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const opts = new Map((await tx.workspaceOption.findMany({ where: { kind: 'call_disposition' } })).map((o) => [`${o.workspaceId}:${o.value}`, o.label]));
      const fa = await fieldAccess(tx);
      await this.db.audit(tx, { entity: 'lead', entityId: 'activities-export', action: 'activity.exported', newValue: { rows: acts.length, from: q.from, to: q.to, types } });
      return [
        ['Date', 'Type', 'Customer ID', 'Customer', 'Mobile', 'Business line', 'Call outcome', 'Reached', 'Minutes', 'Remark / details', 'By'],
        ...acts.map((a) => {
          const d = (a.data ?? {}) as Record<string, unknown>;
          return [
            a.createdAt.toISOString(), a.type, a.lead.customer.code, a.lead.customer.name, contact(fa, 'mobile', a.lead.customer.mobile) ?? '', a.lead.workspace.name,
            a.disposition ? opts.get(`${a.workspaceId}:${a.disposition}`) ?? a.disposition : '', a.connected === null ? '' : a.connected ? 'Yes' : 'No',
            a.durationSec ? String(Math.round(a.durationSec / 6) / 10) : '', a.remark ?? (a.type === 'action' ? String(d.name ?? '') : a.type === 'task' ? String(d.title ?? '') : ''),
            a.userId ? users.get(a.userId) ?? '' : 'System',
          ];
        }),
      ];
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="activities-${q.from}-to-${q.to}.csv"`);
    res.send('﻿' + toCsv(rows));
  }

  // ── helpers ──

  private workspace() {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Select a workspace (business line) first' });
    return ws;
  }

  private async context(tx: Tx, ws: string) {
    const [stages, options, users, labels, fields, eligible] = await Promise.all([
      tx.leadStage.findMany({ where: { pipeline: { workspaceId: ws } } }),
      tx.workspaceOption.findMany({ where: { workspaceId: ws, isArchived: false } }),
      tx.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true } }),
      tx.label.findMany({ where: { isArchived: false, OR: [{ workspaceId: null }, { workspaceId: ws }] } }),
      tx.leadField.findMany({ where: { workspaceId: ws, isArchived: false } }),
      eligibleOwners(tx, ws).then((x) => x.map((u: { id: string }) => u.id)),
    ]);
    return {
      scope: await scopeFilter(tx, 'crm.lead.update'), stages, users, labels, eligible,
      statuses: options.filter((o) => o.kind === 'lead_status'), sources: options.filter((o) => o.kind === 'lead_source'),
      fields: fields as unknown as FieldDef[],
    };
  }

  /** The lead of this customer in this business line (open lead first), within the person's edit scope. */
  private async findLead(tx: Tx, scope: Prisma.LeadWhereInput, ws: string, match: z.infer<typeof Match>, key: string) {
    const k = key.trim();
    if (!k) return 'Lead ID is missing';
    let customer: Prisma.CustomerWhereInput;
    if (match === 'mobile') {
      const m = normalizeMobile(k);
      if (!m) return `"${k}" is not a valid mobile number`;
      customer = { OR: [{ mobile: m }, { alternateMobiles: { has: m } }] };
    } else if (match === 'email') customer = { OR: [{ email: { equals: k, mode: 'insensitive' } }, { alternateEmails: { has: k.toLowerCase() } }] };
    else customer = { code: k.toUpperCase() };
    const leads = await tx.lead.findMany({ where: { AND: [scope, { workspaceId: ws, customer: { ...customer, mergedIntoId: null } }] }, include: { customer: true }, orderBy: { createdAt: 'desc' } });
    if (!leads.length) return `No lead for "${k}" in this business line (or it is not yours to change)`;
    const stages = await tx.leadStage.findMany({ where: { id: { in: leads.map((l) => l.stageId) } } });
    return leads.find((l) => { const s = stages.find((x) => x.id === l.stageId); return s && !s.isWon && !s.isLost; }) ?? leads[0];
  }
}
