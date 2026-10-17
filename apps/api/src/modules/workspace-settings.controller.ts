import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Delete } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { FIELD_TYPE_KEYS, fieldKey } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { eligibleOwners } from '../common/lead-ops';

const Name = z.string().trim().min(2).max(60);
const Stage = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(40),
  isWon: z.boolean().default(false),
  isLost: z.boolean().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  slaDays: z.number().int().min(1).max(365).nullable().optional(),
  requiredFieldKeys: z.array(z.string().max(60)).max(30).optional(),
  setStatus: z.string().max(60).nullable().optional(),
  followUpDays: z.number().int().min(0).max(365).nullable().optional(),
});
const Stages = z.object({ stages: z.array(Stage).min(2, 'A pipeline needs at least 2 stages').max(20) });
const NewPipeline = z.object({ name: Name, stages: z.array(z.string().trim().min(1).max(40)).min(2).max(20).optional() });
const FieldBody = z.object({
  label: z.string().trim().min(1).max(60),
  type: z.enum(FIELD_TYPE_KEYS as [string, ...string[]]),
  options: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  required: z.boolean().default(false),
});
const FieldPatch = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
  required: z.boolean().optional(),
  isArchived: z.boolean().optional(),
});
const Order = z.object({ ids: z.array(z.string().uuid()).max(200) });
const OptionList = z.object({
  options: z.array(z.object({ id: z.string().uuid().optional(), label: z.string().trim().min(1).max(60), connected: z.boolean().optional(), isDefault: z.boolean().optional() })).max(100),
});
const KINDS = ['lead_source', 'lost_reason', 'lead_status', 'call_disposition'] as const;
const Assignment = z.object({
  mode: z.enum(['round_robin', 'creator', 'fixed']),
  userIds: z.array(z.string().uuid()).max(100),
  sticky: z.boolean(),
});
const WorkspacePatch = z.object({ name: Name.optional(), isArchived: z.boolean().optional() });

/** Pipelines & stages, custom lead fields, lead sources and lost reasons of one workspace (business line). */
@Controller('api/v1')
export class WorkspaceSettingsController {
  constructor(private db: DbService) {}

  @Get('workspaces/:id/settings')
  @RequirePermission('org.workspace.view')
  settings(@Param('id') id: string) {
    this.assertAccess(id);
    return this.db.tenant(async (tx) => {
      const ws = await tx.workspace.findUnique({
        where: { id },
        include: {
          pipelines: { orderBy: { position: 'asc' }, include: { stages: { orderBy: { position: 'asc' } } } },
          fields: { orderBy: { position: 'asc' } },
          options: { where: { isArchived: false }, orderBy: { position: 'asc' } },
        },
      });
      if (!ws) throw new NotFoundException({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' });
      const counts = await tx.lead.groupBy({ by: ['stageId'], _count: true, where: { workspaceId: id } });
      const perStage = new Map(counts.map((c) => [c.stageId, c._count]));
      return {
        id: ws.id, name: ws.name, template: ws.template, isArchived: ws.isArchived,
        canManage: this.canManage(id),
        pipelines: ws.pipelines.map((p) => ({
          id: p.id, name: p.name,
          stages: p.stages.map((s) => ({
            id: s.id, name: s.name, isWon: s.isWon, isLost: s.isLost, leadCount: perStage.get(s.id) ?? 0,
            color: s.color, slaDays: s.slaDays, requiredFieldKeys: s.requiredFieldKeys, setStatus: s.setStatus, followUpDays: s.followUpDays,
          })),
        })),
        fields: ws.fields.map((f) => ({ id: f.id, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required, isArchived: f.isArchived, createdAt: f.createdAt, updatedAt: f.updatedAt })),
        sources: ws.options.filter((o) => o.kind === 'lead_source').map((o) => ({ id: o.id, value: o.value, label: o.label })),
        lostReasons: ws.options.filter((o) => o.kind === 'lost_reason').map((o) => ({ id: o.id, value: o.value, label: o.label })),
        statuses: ws.options.filter((o) => o.kind === 'lead_status').map((o) => ({ id: o.id, value: o.value, label: o.label, isDefault: o.isDefault })),
        dispositions: ws.options.filter((o) => o.kind === 'call_disposition').map((o) => ({ id: o.id, value: o.value, label: o.label, connected: o.connected, isDefault: o.isDefault })),
        assignment: { mode: ws.assignmentMode, userIds: ws.assignmentUserIds, sticky: ws.stickyOwner },
        display: { h1: ws.displayH1, h2: ws.displayH2 },
        leadIdentifier: (await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() }, select: { leadIdentifier: true } }))?.leadIdentifier ?? 'mobile',
      };
    });
  }

  @Patch('workspaces/:id')
  @RequirePermission('org.workspace.manage', 'ORGANIZATION')
  updateWorkspace(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(WorkspacePatch, body);
    return this.db.tenant(async (tx) => {
      const ws = await tx.workspace.findUnique({ where: { id } });
      if (!ws) throw new NotFoundException({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' });
      if (input.isArchived === true && (await tx.workspace.count({ where: { isArchived: false } })) <= 1) {
        throw new ForbiddenException({ code: 'LAST_WORKSPACE', message: 'An organization needs at least one active workspace' });
      }
      await tx.workspace.update({ where: { id }, data: input });
      await this.db.audit(tx, {
        entity: 'workspace', entityId: id, action: input.isArchived === undefined ? 'workspace.updated' : input.isArchived ? 'workspace.archived' : 'workspace.restored',
        oldValue: { name: ws.name, isArchived: ws.isArchived }, newValue: input,
      });
      return { id };
    });
  }

  // ── Pipelines & stages ──

  @Post('workspaces/:id/pipelines')
  @RequirePermission('org.workspace.view')
  createPipeline(@Param('id') id: string, @Body() body: unknown) {
    this.assertManage(id);
    const input = parse(NewPipeline, body);
    return this.db.tenant(async (tx) => {
      await this.workspace(tx, id);
      if (await tx.pipeline.findFirst({ where: { workspaceId: id, name: { equals: input.name, mode: 'insensitive' } } })) {
        throw new ConflictException({ code: 'PIPELINE_NAME_TAKEN', message: 'A pipeline with this name already exists here' });
      }
      const position = await tx.pipeline.count({ where: { workspaceId: id } });
      const names = input.stages ?? ['New', 'Contacted', 'Interested', 'Won', 'Lost'];
      const p = await tx.pipeline.create({
        data: {
          tenantId: tenantId(), workspaceId: id, name: input.name, position,
          stages: {
            create: names.map((name, i) => ({
              tenantId: tenantId(), name, position: i, isWon: /^won$/i.test(name), isLost: /^lost$/i.test(name),
            })),
          },
        },
      });
      await this.db.audit(tx, { workspaceId: id, entity: 'pipeline', entityId: p.id, action: 'pipeline.created', newValue: { name: input.name, stages: names } });
      return { id: p.id };
    });
  }

  @Patch('pipelines/:pid')
  @RequirePermission('org.workspace.view')
  renamePipeline(@Param('pid') pid: string, @Body() body: unknown) {
    const { name } = parse(z.object({ name: Name }), body);
    return this.db.tenant(async (tx) => {
      const p = await this.pipeline(tx, pid);
      this.assertManage(p.workspaceId);
      await tx.pipeline.update({ where: { id: pid }, data: { name } });
      await this.db.audit(tx, { workspaceId: p.workspaceId, entity: 'pipeline', entityId: pid, action: 'pipeline.renamed', oldValue: { name: p.name }, newValue: { name } });
      return { id: pid };
    });
  }

  @Delete('pipelines/:pid')
  @RequirePermission('org.workspace.view')
  deletePipeline(@Param('pid') pid: string) {
    return this.db.tenant(async (tx) => {
      const p = await this.pipeline(tx, pid);
      this.assertManage(p.workspaceId);
      const leads = await tx.lead.count({ where: { pipelineId: pid } });
      if (leads) throw new ConflictException({ code: 'PIPELINE_IN_USE', message: `${leads} lead(s) are in this pipeline. Move them first.` });
      if ((await tx.pipeline.count({ where: { workspaceId: p.workspaceId } })) <= 1) {
        throw new ConflictException({ code: 'LAST_PIPELINE', message: 'A workspace needs at least one pipeline' });
      }
      await tx.leadStage.deleteMany({ where: { pipelineId: pid } });
      await tx.pipeline.delete({ where: { id: pid } });
      await this.db.audit(tx, { workspaceId: p.workspaceId, entity: 'pipeline', entityId: pid, action: 'pipeline.deleted', oldValue: { name: p.name } });
      return { ok: true };
    });
  }

  /**
   * Saves the full ordered stage list. Existing stages keep their id (leads stay attached); stages left out are
   * deleted only if no lead uses them. The first stage must be an open stage — new leads start there.
   */
  @Put('pipelines/:pid/stages')
  @RequirePermission('org.workspace.view')
  saveStages(@Param('pid') pid: string, @Body() body: unknown) {
    const { stages } = parse(Stages, body);
    if (stages.some((s) => s.isWon && s.isLost)) throw new BadRequestException({ code: 'INVALID_STAGE', message: 'A stage cannot be both Won and Lost' });
    if (stages[0].isWon || stages[0].isLost) throw new BadRequestException({ code: 'INVALID_STAGE', message: 'The first stage must be an open stage (new leads start there)' });
    const names = stages.map((s) => s.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new BadRequestException({ code: 'DUPLICATE_STAGE', message: 'Stage names must be unique' });

    return this.db.tenant(async (tx) => {
      const p = await this.pipeline(tx, pid);
      this.assertManage(p.workspaceId);
      const existing = await tx.leadStage.findMany({ where: { pipelineId: pid }, orderBy: { position: 'asc' } });
      const fieldKeys = new Set((await tx.leadField.findMany({ where: { workspaceId: p.workspaceId }, select: { key: true } })).map((f) => f.key));
      const statusValues = new Set((await tx.workspaceOption.findMany({ where: { workspaceId: p.workspaceId, kind: 'lead_status', isArchived: false }, select: { value: true } })).map((o) => o.value));
      for (const s of stages) {
        const bad = (s.requiredFieldKeys ?? []).find((k) => !fieldKeys.has(k));
        if (bad) throw new BadRequestException({ code: 'UNKNOWN_FIELD', message: `Stage "${s.name}": field "${bad}" does not exist in this workspace` });
        if (s.setStatus && !statusValues.has(s.setStatus)) throw new BadRequestException({ code: 'UNKNOWN_STATUS', message: `Stage "${s.name}": status "${s.setStatus}" does not exist` });
      }
      const keepIds = new Set(stages.filter((s) => s.id).map((s) => s.id!));
      for (const s of stages) {
        if (s.id && !existing.some((e) => e.id === s.id)) throw new BadRequestException({ code: 'STAGE_NOT_FOUND', message: 'Stage does not belong to this pipeline' });
      }
      for (const removed of existing.filter((e) => !keepIds.has(e.id))) {
        const n = await tx.lead.count({ where: { stageId: removed.id } });
        if (n) throw new ConflictException({ code: 'STAGE_IN_USE', message: `Stage "${removed.name}" has ${n} lead(s). Move them to another stage first.` });
        await tx.leadStage.delete({ where: { id: removed.id } });
      }
      for (const [position, s] of stages.entries()) {
        const data = {
          name: s.name, position, isWon: s.isWon, isLost: s.isLost, color: s.color ?? null, slaDays: s.slaDays ?? null,
          requiredFieldKeys: s.requiredFieldKeys ?? [], setStatus: s.setStatus ?? null, followUpDays: s.followUpDays ?? null,
        };
        if (s.id) await tx.leadStage.update({ where: { id: s.id }, data });
        else await tx.leadStage.create({ data: { ...data, tenantId: tenantId(), pipelineId: pid } });
      }
      await this.db.audit(tx, {
        workspaceId: p.workspaceId, entity: 'pipeline', entityId: pid, action: 'pipeline.stages_changed',
        oldValue: existing.map((e) => e.name), newValue: stages.map((s) => s.name),
      });
      return { ok: true };
    });
  }

  // ── Custom lead fields ──

  @Post('workspaces/:id/fields')
  @RequirePermission('org.workspace.view')
  createField(@Param('id') id: string, @Body() body: unknown) {
    this.assertManage(id);
    const input = parse(FieldBody, body);
    this.assertOptions(input.type, input.options);
    return this.db.tenant(async (tx) => {
      await this.workspace(tx, id);
      const existing = await tx.leadField.findMany({ where: { workspaceId: id }, select: { key: true, label: true } });
      if (existing.some((f) => f.label.toLowerCase() === input.label.toLowerCase())) {
        throw new ConflictException({ code: 'FIELD_NAME_TAKEN', message: 'A field with this name already exists' });
      }
      const f = await tx.leadField.create({
        data: {
          tenantId: tenantId(), workspaceId: id, key: fieldKey(input.label, existing.map((e) => e.key)),
          label: input.label, type: input.type, options: [...new Set(input.options)], required: input.required, position: existing.length,
        },
      });
      await this.db.audit(tx, { workspaceId: id, entity: 'lead_field', entityId: f.id, action: 'field.created', newValue: input });
      return { id: f.id, key: f.key };
    });
  }

  /** Type and key never change after creation (stored values stay valid); options may only grow if values use them. */
  @Patch('fields/:fid')
  @RequirePermission('org.workspace.view')
  updateField(@Param('fid') fid: string, @Body() body: unknown) {
    const input = parse(FieldPatch, body);
    return this.db.tenant(async (tx) => {
      const f = await tx.leadField.findUnique({ where: { id: fid } });
      if (!f) throw new NotFoundException({ code: 'FIELD_NOT_FOUND', message: 'Field not found' });
      this.assertManage(f.workspaceId);
      if (input.options) this.assertOptions(f.type, input.options);
      if (input.options && ['dropdown', 'multiselect'].includes(f.type)) {
        for (const removed of f.options.filter((o) => !input.options!.includes(o))) {
          const used = await tx.lead.count({
            where: {
              workspaceId: f.workspaceId,
              OR: [
                { customFields: { path: [f.key], equals: removed } },
                { customFields: { path: [f.key], array_contains: [removed] } },
              ],
            },
          });
          if (used) throw new ConflictException({ code: 'OPTION_IN_USE', message: `Option "${removed}" is used by ${used} lead(s)` });
        }
      }
      const updated = await tx.leadField.update({ where: { id: fid }, data: input });
      await this.db.audit(tx, {
        workspaceId: f.workspaceId, entity: 'lead_field', entityId: fid,
        action: input.isArchived === true ? 'field.archived' : input.isArchived === false ? 'field.restored' : 'field.updated',
        oldValue: { label: f.label, options: f.options, required: f.required }, newValue: input,
      });
      return { id: updated.id };
    });
  }

  @Put('workspaces/:id/fields/order')
  @RequirePermission('org.workspace.view')
  orderFields(@Param('id') id: string, @Body() body: unknown) {
    this.assertManage(id);
    const { ids } = parse(Order, body);
    return this.db.tenant(async (tx) => {
      const fields = await tx.leadField.findMany({ where: { workspaceId: id }, select: { id: true } });
      if (fields.length !== ids.length || !fields.every((f) => ids.includes(f.id))) {
        throw new BadRequestException({ code: 'INVALID_ORDER', message: 'Send every field of this workspace exactly once' });
      }
      for (const [position, fid] of ids.entries()) await tx.leadField.update({ where: { id: fid }, data: { position } });
      return { ok: true };
    });
  }

  // ── Lead sources & lost reasons ──

  /** Saves the ordered list. Removed entries are archived (old leads keep their value), never deleted. */
  @Put('workspaces/:id/options/:kind')
  @RequirePermission('org.workspace.view')
  saveOptions(@Param('id') id: string, @Param('kind') kind: string, @Body() body: unknown) {
    this.assertManage(id);
    if (!KINDS.includes(kind as (typeof KINDS)[number])) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unknown list' });
    const { options } = parse(OptionList, body);
    if (options.filter((o) => o.isDefault).length > 1) throw new BadRequestException({ code: 'ONE_DEFAULT', message: 'Only one entry can be the default' });
    if (options.some((o) => o.isDefault) && !['lead_status', 'call_disposition'].includes(kind)) throw new BadRequestException({ code: 'NO_DEFAULT', message: 'This list has no default' });
    const labels = options.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) throw new BadRequestException({ code: 'DUPLICATE_OPTION', message: 'Each entry must be unique' });
    return this.db.tenant(async (tx) => {
      await this.workspace(tx, id);
      const existing = await tx.workspaceOption.findMany({ where: { workspaceId: id, kind } });
      const keep = new Set(options.filter((o) => o.id).map((o) => o.id));
      await tx.workspaceOption.updateMany({ where: { workspaceId: id, kind, id: { notIn: [...keep] as string[] } }, data: { isArchived: true } });
      for (const [position, o] of options.entries()) {
        const match = o.id ? existing.find((e) => e.id === o.id) : existing.find((e) => e.label.toLowerCase() === o.label.toLowerCase());
        if (match) {
          await tx.workspaceOption.update({ where: { id: match.id }, data: { label: o.label, position, isArchived: false, isDefault: !!o.isDefault, ...(kind === 'call_disposition' ? { connected: !!o.connected } : {}) } });
        } else {
          // Sources are stored on leads as short codes ("google_ads"); reasons as their text.
          const value = kind === 'lost_reason' ? o.label : fieldKey(o.label, existing.map((e) => e.value));
          await tx.workspaceOption.create({ data: { tenantId: tenantId(), workspaceId: id, kind, value, label: o.label, position, connected: kind === 'call_disposition' && !!o.connected, isDefault: !!o.isDefault } });
        }
      }
      await this.db.audit(tx, {
        workspaceId: id, entity: 'workspace', entityId: id, action: `workspace.${kind}s_changed`,
        oldValue: existing.filter((e) => !e.isArchived).map((e) => e.label), newValue: options.map((o) => o.label),
      });
      return { ok: true };
    });
  }

  // ── Lead assignment ──

  /** People who can own leads in this workspace (for assignment pickers). */
  @Get('workspaces/:id/assignees')
  @RequirePermission('org.workspace.view')
  assignees(@Param('id') id: string) {
    this.assertAccess(id);
    return this.db.tenant((tx) => eligibleOwners(tx, id));
  }

  /** Primary display: which values show as the title (H1) and second line (H2) of a lead in lists and headers. */
  @Put('workspaces/:id/display')
  @RequirePermission('org.workspace.view')
  saveDisplay(@Param('id') id: string, @Body() body: unknown) {
    this.assertManage(id);
    const { h1, h2 } = parse(z.object({ h1: z.string().max(70), h2: z.string().max(70) }), body);
    return this.db.tenant(async (tx) => {
      const fieldKeys = new Set((await tx.leadField.findMany({ where: { workspaceId: id, isArchived: false }, select: { key: true } })).map((f) => `cf:${f.key}`));
      const allowed = (v: string) => ['name', 'mobile', 'email', 'city', 'source', 'customerCode'].includes(v) || fieldKeys.has(v);
      if (!allowed(h1) || !allowed(h2)) throw new BadRequestException({ code: 'INVALID_DISPLAY', message: 'Choose name, mobile, email, city, source, customer ID or a lead field' });
      await tx.workspace.update({ where: { id }, data: { displayH1: h1, displayH2: h2 } });
      await this.db.audit(tx, { workspaceId: id, entity: 'workspace', entityId: id, action: 'workspace.display_changed', newValue: { h1, h2 } });
      return { ok: true };
    });
  }

  /** Lead ID: the identifier that makes a customer unique in the whole organization (mobile or email). */
  @Put('settings/lead-identifier')
  @RequirePermission('org.workspace.manage', 'ORGANIZATION')
  saveLeadIdentifier(@Body() body: unknown) {
    const { leadIdentifier } = parse(z.object({ leadIdentifier: z.enum(['mobile', 'email']) }), body);
    return this.db.tenant(async (tx) => {
      const old = await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() } });
      await tx.organizationSetting.upsert({ where: { tenantId: tenantId() }, create: { tenantId: tenantId(), leadIdentifier }, update: { leadIdentifier } });
      await this.db.audit(tx, {
        entity: 'settings', entityId: 'lead_identifier', action: 'settings.lead_identifier_changed',
        oldValue: { leadIdentifier: old?.leadIdentifier ?? 'mobile' }, newValue: { leadIdentifier },
      });
      return { leadIdentifier };
    });
  }

  /** Who receives new leads from forms, integrations and imports: round-robin pool, fixed owner or creator; sticky RM. */
  @Put('workspaces/:id/assignment')
  @RequirePermission('org.workspace.view')
  saveAssignment(@Param('id') id: string, @Body() body: unknown) {
    this.assertManage(id);
    const input = parse(Assignment, body);
    return this.db.tenant(async (tx) => {
      const ws = await this.workspace(tx, id);
      const eligible = new Set((await eligibleOwners(tx, id)).map((u) => u.id));
      if (input.userIds.some((u) => !eligible.has(u))) {
        throw new BadRequestException({ code: 'INVALID_ASSIGNEES', message: 'Choose people who work in this business line' });
      }
      if (input.mode === 'fixed' && !input.userIds.length) {
        throw new BadRequestException({ code: 'OWNER_REQUIRED', message: 'Choose the person who receives all new leads' });
      }
      await tx.workspace.update({ where: { id }, data: { assignmentMode: input.mode, assignmentUserIds: input.userIds, stickyOwner: input.sticky, assignmentCursor: 0 } });
      await this.db.audit(tx, {
        workspaceId: id, entity: 'workspace', entityId: id, action: 'workspace.assignment_changed',
        oldValue: { mode: ws.assignmentMode, userIds: ws.assignmentUserIds, sticky: ws.stickyOwner }, newValue: input,
      });
      return { ok: true };
    });
  }

  // ── helpers ──

  /** Organization-wide managers manage every workspace; workspace-level managers only the one they are working in. */
  private canManage(workspaceId: string) {
    const a = auth();
    const scope = a.permissions['org.workspace.manage'];
    return scope === 'ORGANIZATION' || (!!scope && a.workspaceId === workspaceId);
  }

  private assertManage(workspaceId: string) {
    this.assertAccess(workspaceId);
    if (!this.canManage(workspaceId)) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You cannot change the settings of this workspace' });
    }
  }

  private assertAccess(workspaceId: string) {
    if (!auth().accessibleWorkspaceIds.includes(workspaceId)) {
      throw new ForbiddenException({ code: 'WORKSPACE_FORBIDDEN', message: 'You do not have access to this workspace' });
    }
  }

  private assertOptions(type: string, options: string[]) {
    if (['dropdown', 'multiselect'].includes(type) && options.length < 1) {
      throw new BadRequestException({ code: 'OPTIONS_REQUIRED', message: 'Add at least one option to choose from' });
    }
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      throw new BadRequestException({ code: 'DUPLICATE_OPTION', message: 'Options must be unique' });
    }
  }

  private async workspace(tx: Tx, id: string) {
    const ws = await tx.workspace.findUnique({ where: { id } });
    if (!ws) throw new NotFoundException({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' });
    return ws;
  }

  private async pipeline(tx: Tx, id: string) {
    const p = await tx.pipeline.findUnique({ where: { id } });
    if (!p) throw new NotFoundException({ code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' });
    return p;
  }
}
