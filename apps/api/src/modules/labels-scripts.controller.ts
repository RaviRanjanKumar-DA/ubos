import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_ROLE } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { RULE_FIELDS_BUILT_IN } from '../common/field-access';

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const LabelBody = z.object({ name: z.string().trim().min(1).max(40), color: Color.default('#5b3cc4'), workspaceId: z.string().uuid().nullable() });
const LabelPatch = z.object({ name: z.string().trim().min(1).max(40).optional(), color: Color.optional(), isArchived: z.boolean().optional() });
const ScriptBody = z.object({ workspaceId: z.string().uuid(), stageId: z.string().uuid().nullable().optional(), title: z.string().trim().min(2).max(80), body: z.string().trim().min(1).max(5000) });
const ScriptPatch = z.object({ stageId: z.string().uuid().nullable().optional(), title: z.string().trim().min(2).max(80).optional(), body: z.string().trim().min(1).max(5000).optional(), isArchived: z.boolean().optional() });
const Rules = z.object({ rules: z.array(z.object({ field: z.string().max(70), visibility: z.enum(['editable', 'read', 'masked', 'hidden']) })).max(200) });
const ByWorkspace = z.object({ workspaceId: z.string().uuid().optional(), archived: z.enum(['true', 'false']).default('false') });

/** Labels (tags) for leads, call scripts per stage, and field-level security rules per role. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class LabelsScriptsController {
  constructor(private db: DbService) {}

  // ── Labels ──

  @Get('labels')
  @RequirePermission('crm.lead.view')
  labels(@Query() query: unknown) {
    const q = parse(ByWorkspace, query);
    const ws = q.workspaceId ?? auth().workspaceId;
    return this.db.tenant((tx) => tx.label.findMany({
      where: { isArchived: q.archived === 'true', OR: [{ workspaceId: null }, ws ? { workspaceId: ws } : { workspaceId: { in: auth().accessibleWorkspaceIds } }] },
      orderBy: { name: 'asc' },
    }));
  }

  @Post('labels')
  @RequirePermission('org.workspace.view')
  createLabel(@Body() body: unknown) {
    const input = parse(LabelBody, body);
    this.assertManage(input.workspaceId);
    return this.db.tenant(async (tx) => {
      const dup = await tx.label.findFirst({ where: { workspaceId: input.workspaceId, name: { equals: input.name, mode: 'insensitive' }, isArchived: false } });
      if (dup) throw new BadRequestException({ code: 'DUPLICATE_LABEL', message: 'A label with this name already exists' });
      const l = await tx.label.create({ data: { tenantId: tenantId(), ...input } });
      await this.db.audit(tx, { workspaceId: input.workspaceId, entity: 'label', entityId: l.id, action: 'label.created', newValue: input });
      return l;
    });
  }

  @Patch('labels/:id')
  @RequirePermission('org.workspace.view')
  updateLabel(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(LabelPatch, body);
    return this.db.tenant(async (tx) => {
      const l = await tx.label.findUnique({ where: { id } });
      if (!l) throw new NotFoundException({ code: 'LABEL_NOT_FOUND', message: 'Label not found' });
      this.assertManage(l.workspaceId);
      const updated = await tx.label.update({ where: { id }, data: input });
      await this.db.audit(tx, { workspaceId: l.workspaceId, entity: 'label', entityId: id, action: input.isArchived ? 'label.archived' : 'label.updated', oldValue: { name: l.name, color: l.color }, newValue: input });
      return updated;
    });
  }

  // ── Call scripts ──

  @Get('call-scripts')
  @RequirePermission('crm.lead.view')
  scripts(@Query() query: unknown) {
    const q = parse(ByWorkspace, query);
    const ws = q.workspaceId ?? auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Select a business line' });
    if (!auth().accessibleWorkspaceIds.includes(ws)) throw new ForbiddenException({ code: 'WORKSPACE_FORBIDDEN', message: 'No access to this business line' });
    return this.db.tenant((tx) => tx.callScript.findMany({ where: { workspaceId: ws, isArchived: q.archived === 'true' }, orderBy: [{ stageId: 'asc' }, { title: 'asc' }] }));
  }

  @Post('call-scripts')
  @RequirePermission('org.workspace.view')
  createScript(@Body() body: unknown) {
    const input = parse(ScriptBody, body);
    this.assertManage(input.workspaceId);
    return this.db.tenant(async (tx) => {
      if (input.stageId) await this.assertStage(tx, input.stageId, input.workspaceId);
      const s = await tx.callScript.create({ data: { tenantId: tenantId(), workspaceId: input.workspaceId, stageId: input.stageId ?? null, title: input.title, body: input.body } });
      await this.db.audit(tx, { workspaceId: input.workspaceId, entity: 'call_script', entityId: s.id, action: 'call_script.created', newValue: { title: s.title } });
      return s;
    });
  }

  @Patch('call-scripts/:id')
  @RequirePermission('org.workspace.view')
  updateScript(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ScriptPatch, body);
    return this.db.tenant(async (tx) => {
      const s = await tx.callScript.findUnique({ where: { id } });
      if (!s) throw new NotFoundException({ code: 'SCRIPT_NOT_FOUND', message: 'Script not found' });
      this.assertManage(s.workspaceId);
      if (input.stageId) await this.assertStage(tx, input.stageId, s.workspaceId);
      const updated = await tx.callScript.update({ where: { id }, data: input });
      await this.db.audit(tx, { workspaceId: s.workspaceId, entity: 'call_script', entityId: id, action: input.isArchived ? 'call_script.archived' : 'call_script.updated', newValue: { title: updated.title } });
      return updated;
    });
  }

  // ── Field-level security ──

  /** Fields that rules can apply to: contact details and every custom lead field (by business line). */
  @Get('field-rules/fields')
  @RequirePermission('org.role.manage', 'ORGANIZATION')
  ruleFields() {
    return this.db.tenant(async (tx) => {
      const fields = await tx.leadField.findMany({ where: { isArchived: false }, include: { workspace: { select: { name: true } } }, orderBy: [{ workspaceId: 'asc' }, { position: 'asc' }] });
      const byKey = new Map<string, { field: string; label: string; group: string }>();
      for (const f of fields) {
        const k = `cf:${f.key}`;
        const cur = byKey.get(k);
        byKey.set(k, cur ? { ...cur, group: `${cur.group}, ${f.workspace.name}` } : { field: k, label: f.label, group: f.workspace.name });
      }
      return [
        { field: 'mobile', label: 'Mobile numbers', group: 'Contact details' },
        { field: 'email', label: 'Email addresses', group: 'Contact details' },
        ...byKey.values(),
      ];
    });
  }

  @Get('roles/:id/field-rules')
  @RequirePermission('org.role.manage', 'ORGANIZATION')
  rules(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const role = await tx.role.findUnique({ where: { id }, include: { fieldRules: { where: { entity: 'lead' } } } });
      if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
      return role.fieldRules.map((r) => ({ field: r.field, visibility: r.visibility }));
    });
  }

  @Put('roles/:id/field-rules')
  @RequirePermission('org.role.manage', 'ORGANIZATION')
  saveRules(@Param('id') id: string, @Body() body: unknown) {
    const { rules } = parse(Rules, body);
    return this.db.tenant(async (tx) => {
      const role = await tx.role.findUnique({ where: { id }, include: { fieldRules: { where: { entity: 'lead' } } } });
      if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found' });
      if (role.name === ADMIN_ROLE) throw new BadRequestException({ code: 'ADMIN_ROLE_PROTECTED', message: 'The Organization Admin role always sees every field' });
      const keys = new Set([...RULE_FIELDS_BUILT_IN, ...(await tx.leadField.findMany({ select: { key: true } })).map((f) => `cf:${f.key}`)]);
      const bad = rules.filter((r) => !keys.has(r.field));
      if (bad.length) throw new BadRequestException({ code: 'UNKNOWN_FIELD', message: `Unknown field ${bad[0].field}` });
      const restricting = rules.filter((r) => r.visibility !== 'editable');
      await tx.fieldRule.deleteMany({ where: { roleId: id, entity: 'lead' } });
      if (restricting.length) await tx.fieldRule.createMany({ data: restricting.map((r) => ({ roleId: id, entity: 'lead', field: r.field, visibility: r.visibility })) });
      await this.db.audit(tx, {
        entity: 'role', entityId: id, action: 'role.field_rules_changed',
        oldValue: role.fieldRules.map((r) => `${r.field}:${r.visibility}`), newValue: restricting.map((r) => `${r.field}:${r.visibility}`),
      });
      return { ok: true, rules: restricting.length };
    });
  }

  // ── helpers ──

  private assertManage(workspaceId: string | null) {
    const a = auth();
    const scope = a.permissions['org.workspace.manage'];
    if (scope === 'ORGANIZATION') return;
    if (scope && workspaceId && a.workspaceId === workspaceId) return;
    throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: workspaceId ? 'Only this business line’s managers can change this' : 'Only organization admins can change organization-wide settings' });
  }

  private async assertStage(tx: Parameters<Parameters<DbService['tenant']>[0]>[0], stageId: string, workspaceId: string) {
    const st = await tx.leadStage.findFirst({ where: { id: stageId, pipeline: { workspaceId } } });
    if (!st) throw new BadRequestException({ code: 'INVALID_STAGE', message: 'That stage is not in this business line' });
  }
}
