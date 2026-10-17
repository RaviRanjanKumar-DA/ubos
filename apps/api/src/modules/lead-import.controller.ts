import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '@ubos/database';
import type { Tx } from '@ubos/database';
import { normalizeMobile, parseDateInput, validateCustomFields } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { findCustomer, nextCustomerCode } from '../common/customers';
import { activity, defaultStatus, eligibleOwners, makeAssigner } from '../common/lead-ops';

const MAX_ROWS = 5000;
const ImportBody = z.object({
  fileName: z.string().trim().max(200).default('upload.csv'),
  pipelineId: z.string().uuid(),
  defaultSource: z.string().max(60),
  assign: z.object({ mode: z.enum(['me', 'users', 'rules']), userIds: z.array(z.string().uuid()).max(50).default([]) }),
  skipDuplicates: z.boolean().default(true),
  rows: z.array(z.record(z.string().max(2000))).min(1).max(MAX_ROWS),
});
type Body = z.infer<typeof ImportBody>;

type RowResult = {
  row: number; status: 'new' | 'linked' | 'duplicate' | 'error'; message?: string; name?: string; mobile?: string;
};
type Prepared = RowResult & {
  data?: {
    name: string; mobile: string | null; email: string | null; city: string | null; source: string; status: string | null; stageId: string;
    remark: string | null; followUpAt: Date | null; ownerId: string | null; customFields: Record<string, unknown>;
    customerId: string | null; customerRm: string | null;
  };
};

/** Bulk lead upload: the browser reads CSV / Excel and sends mapped rows; preview first, then import. */
@Controller('api/v1/leads/import')
@RequireFeature('module.crm')
export class LeadImportController {
  constructor(private db: DbService) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('crm.lead.import')
  preview(@Body() body: unknown) {
    const input = parse(ImportBody, body);
    return this.db.tenant(async (tx) => {
      const rows = await this.prepare(tx, input);
      return { summary: this.summary(rows, input.skipDuplicates), rows: rows.map(({ data: _d, ...r }) => r) };
    }, { timeoutMs: 120_000 });
  }

  @Post('commit')
  @HttpCode(200)
  @RequirePermission('crm.lead.import')
  commit(@Body() body: unknown) {
    const input = parse(ImportBody, body);
    const a = auth();
    return this.db.tenant(async (tx) => {
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: a.workspaceId! } });
      const rows = await this.prepare(tx, input);
      const byEmail = (await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() } }))?.leadIdentifier === 'email';
      const initialStatus = await defaultStatus(tx, ws.id);
      const eligible = (await eligibleOwners(tx, ws.id)).map((u) => u.id);
      const assigner = makeAssigner(
        input.assign.mode === 'users'
          ? { assignmentMode: 'round_robin', assignmentUserIds: input.assign.userIds, assignmentCursor: 0, stickyOwner: false }
          : ws,
        eligible, a.userId,
      );
      const imp = await tx.leadImport.create({
        data: { tenantId: tenantId(), workspaceId: ws.id, fileName: input.fileName, total: rows.length, created: 0, linked: 0, skipped: 0, failed: 0, errors: [], createdById: a.userId },
      });

      let created = 0, linked = 0, skipped = 0;
      const errors: { row: number; message: string }[] = [];
      const now = new Date();
      for (const r of rows) {
        if (r.status === 'error') { errors.push({ row: r.row, message: r.message! }); continue; }
        // Rows repeated inside the file (no data) are always skipped; open-lead duplicates follow the user's choice.
        if (r.status === 'duplicate' && (input.skipDuplicates || !r.data)) { skipped++; continue; }
        const d = r.data!;
        let customerId = d.customerId;
        if (!customerId) {
          // Re-check inside the loop: an earlier row of this file may have created the customer.
          const again = await findCustomer(tx, { mobile: d.mobile, email: d.email, preferEmail: byEmail });
          customerId = again?.customer.id ?? (await tx.customer.create({
            data: { tenantId: tenantId(), name: d.name, mobile: d.mobile, email: d.email, city: d.city, code: await nextCustomerCode(tx) },
          })).id;
        } else linked++;
        const ownerId = d.ownerId ?? (input.assign.mode === 'me' ? a.userId : assigner.pick(d.customerRm));
        const lead = await tx.lead.create({
          data: {
            tenantId: tenantId(), workspaceId: ws.id, pipelineId: input.pipelineId, stageId: d.stageId, customerId,
            source: d.source, status: d.status ?? initialStatus, ownerId, assignedAt: now, customFields: d.customFields as Prisma.InputJsonObject,
            importId: imp.id, nextFollowUpAt: d.followUpAt,
          },
        });
        await tx.leadActivity.create({ data: activity(lead, a.userId, { type: 'import', remark: d.remark, data: { file: input.fileName, row: r.row } }) });
        if (d.followUpAt) {
          await tx.followUp.create({ data: { tenantId: tenantId(), leadId: lead.id, dueAt: d.followUpAt, userId: ownerId, createdById: a.userId, note: d.remark } });
        }
        await tx.customer.updateMany({ where: { id: customerId, primaryRmId: null }, data: { primaryRmId: ownerId } });
        created++;
      }
      if (input.assign.mode === 'rules') await tx.workspace.update({ where: { id: ws.id }, data: { assignmentCursor: assigner.state.cursor } });
      await tx.leadImport.update({ where: { id: imp.id }, data: { created, linked, skipped, failed: errors.length, errors } });
      await this.db.audit(tx, {
        entity: 'lead_import', entityId: imp.id, action: 'lead.imported',
        newValue: { file: input.fileName, total: rows.length, created, linked, skipped, failed: errors.length },
      });
      return { importId: imp.id, total: rows.length, created, linked, skipped, failed: errors.length, errors };
    }, { timeoutMs: 300_000 });
  }

  @Get('history')
  @RequirePermission('crm.lead.import')
  history() {
    return this.db.tenant(async (tx) => {
      const a = auth();
      const list = await tx.leadImport.findMany({
        where: a.workspaceId ? { workspaceId: a.workspaceId } : { workspaceId: { in: a.accessibleWorkspaceIds } },
        orderBy: { createdAt: 'desc' }, take: 50,
      });
      const users = new Map((await tx.user.findMany({ where: { id: { in: list.map((l) => l.createdById) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      return list.map((l) => ({ ...l, by: users.get(l.createdById) ?? '?' }));
    });
  }

  // ── validation shared by preview and commit ──

  private async prepare(tx: Tx, input: Body): Promise<Prepared[]> {
    const a = auth();
    if (!a.workspaceId) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Select a workspace (business line) first' });
    const pipeline = await tx.pipeline.findFirst({ where: { id: input.pipelineId, workspaceId: a.workspaceId }, include: { stages: { orderBy: { position: 'asc' } } } });
    if (!pipeline) throw new NotFoundException({ code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found in this workspace' });
    const [opts, defs, owners] = await Promise.all([
      tx.workspaceOption.findMany({ where: { workspaceId: a.workspaceId, isArchived: false } }),
      tx.leadField.findMany({ where: { workspaceId: a.workspaceId, isArchived: false } }),
      eligibleOwners(tx, a.workspaceId),
    ]);
    const pick = (kind: string, v: string) => {
      const t = v.trim().toLowerCase();
      return opts.find((o) => o.kind === kind && (o.value.toLowerCase() === t || o.label.toLowerCase() === t))?.value;
    };
    const defaultSource = pick('lead_source', input.defaultSource);
    if (!defaultSource) throw new BadRequestException({ code: 'INVALID_SOURCE', message: 'Choose a default source of this workspace' });
    if (input.assign.mode === 'users') {
      const ok = new Set(owners.map((o) => o.id));
      if (!input.assign.userIds.length || input.assign.userIds.some((id) => !ok.has(id))) {
        throw new BadRequestException({ code: 'INVALID_ASSIGNEES', message: 'Choose people who work in this business line' });
      }
    }
    const ownerByEmail = new Map(owners.map((o) => [o.email.toLowerCase(), o.id]));
    const byEmail = (await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() } }))?.leadIdentifier === 'email';
    const openStageIds = new Set(pipeline.stages.filter((s) => !s.isLost).map((s) => s.id));
    const seen = new Set<string>();
    const out: Prepared[] = [];

    for (const [i, raw] of input.rows.entries()) {
      const row = i + 2; // row 1 is the header in the file
      const fail = (message: string, extra: Partial<RowResult> = {}): Prepared => ({ row, status: 'error', message, ...extra });
      const name = (raw.name ?? '').trim();
      const mobileRaw = (raw.mobile ?? '').trim();
      const mobile = mobileRaw ? normalizeMobile(mobileRaw) : null;
      const email = (raw.email ?? '').trim().toLowerCase() || null;
      const m = mobile ?? undefined;
      // The Lead ID (organization setting) must be present: mobile by default, or email.
      if (!byEmail && !mobileRaw) { out.push(fail('Mobile is missing', { name })); continue; }
      if (byEmail && !email) { out.push(fail('Email is missing (it is your Lead ID)', { name, mobile: m })); continue; }
      if (mobileRaw && !mobile) { out.push(fail(`"${mobileRaw}" is not a valid mobile number`, { name })); continue; }
      if (name.length < 2) { out.push(fail('Name is missing', { mobile: m })); continue; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { out.push(fail(`"${email}" is not a valid email`, { name, mobile: m })); continue; }
      const idKey = byEmail ? `e:${email}` : `m:${mobile}`;
      if (seen.has(idKey)) { out.push({ row, status: 'duplicate', message: `Same ${byEmail ? 'email' : 'mobile'} appears earlier in this file`, name, mobile: m }); continue; }
      seen.add(idKey);
      const source = raw.source?.trim() ? pick('lead_source', raw.source) : defaultSource;
      if (!source) { out.push(fail(`Unknown source "${raw.source}"`, { name, mobile: m })); continue; }
      const status = raw.status?.trim() ? pick('lead_status', raw.status) ?? null : null;
      if (raw.status?.trim() && !status) { out.push(fail(`Unknown status "${raw.status}"`, { name, mobile: m })); continue; }
      let stageId = pipeline.stages[0].id;
      if (raw.stage?.trim()) {
        const st = pipeline.stages.find((s) => s.name.toLowerCase() === raw.stage.trim().toLowerCase());
        if (!st) { out.push(fail(`Unknown stage "${raw.stage}"`, { name, mobile: m })); continue; }
        if (!openStageIds.has(st.id)) { out.push(fail('Lost leads cannot be imported — import them open and use bulk "Change stage"', { name, mobile: m })); continue; }
        stageId = st.id;
      }
      const followUpAt = raw.follow_up?.trim() ? parseDateInput(raw.follow_up) : null;
      if (raw.follow_up?.trim() && !followUpAt) { out.push(fail(`Follow-up date "${raw.follow_up}" not understood (use DD/MM/YYYY)`, { name, mobile: m })); continue; }
      let ownerId: string | null = null;
      if (raw.owner?.trim()) {
        ownerId = ownerByEmail.get(raw.owner.trim().toLowerCase()) ?? null;
        if (!ownerId) { out.push(fail(`Owner "${raw.owner}" is not a user of this business line`, { name, mobile: m })); continue; }
      }

      // Custom fields: accept options case-insensitively; multi-select split by comma or semicolon.
      const cfInput: Record<string, unknown> = {};
      for (const d of defs) {
        const v = raw[`cf:${d.key}`];
        if (v === undefined) continue;
        if (d.type === 'dropdown') cfInput[d.key] = d.options.find((o) => o.toLowerCase() === v.trim().toLowerCase()) ?? v;
        else if (d.type === 'multiselect') cfInput[d.key] = v.split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((x) => d.options.find((o) => o.toLowerCase() === x.toLowerCase()) ?? x);
        else cfInput[d.key] = v;
      }
      const { values, errors } = validateCustomFields(defs, cfInput);
      if (Object.keys(errors).length) { out.push(fail(Object.values(errors)[0], { name, mobile: m })); continue; }

      const match = await findCustomer(tx, { mobile, email, preferEmail: byEmail });
      let status2: RowResult['status'] = match ? 'linked' : 'new';
      let message: string | undefined = match ? `Existing customer ${match.customer.code} (matched by ${match.matchedBy})` : undefined;
      if (match) {
        const open = await tx.lead.findFirst({
          where: { customerId: match.customer.id, workspaceId: a.workspaceId, stageId: { in: pipeline.stages.filter((s) => !s.isWon && !s.isLost).map((s) => s.id) } },
          select: { id: true },
        });
        if (open) { status2 = 'duplicate'; message = `${match.customer.code} already has an open lead in this business line`; }
      }
      out.push({
        row, status: status2, message, name, mobile: m,
        data: {
          name, mobile, email, city: raw.city?.trim() || null, source, status, stageId, remark: raw.remark?.trim() || null,
          followUpAt, ownerId, customFields: values, customerId: match?.customer.id ?? null, customerRm: match?.customer.primaryRmId ?? null,
        },
      });
    }
    return out;
  }

  private summary(rows: RowResult[], skipDuplicates: boolean) {
    const count = (s: RowResult['status']) => rows.filter((r) => r.status === s).length;
    const dup = count('duplicate');
    return {
      total: rows.length, new: count('new'), linked: count('linked'), duplicates: dup, errors: count('error'),
      willImport: count('new') + count('linked') + (skipDuplicates ? 0 : dup),
    };
  }
}
