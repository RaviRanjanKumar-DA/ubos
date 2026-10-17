import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '@ubos/database';
import type { Tx } from '@ubos/database';
import { FIELD_TYPE_KEYS, fieldKey, FieldDef, validateCustomFields } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { activity } from '../common/lead-ops';

const FormField = z.object({
  key: z.string().max(60).optional(),
  label: z.string().trim().min(1).max(80),
  type: z.enum(FIELD_TYPE_KEYS as [string, ...string[]]),
  options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  required: z.boolean().default(false),
});
const ActionBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  workspaceId: z.string().uuid().nullable(),
  score: z.number().int().min(-100).max(100).default(0),
  fields: z.array(FormField).min(1, 'Add at least one question').max(30),
});
const ListQuery = z.object({ archived: z.enum(['true', 'false']).default('false'), workspaceId: z.string().uuid().optional() });
const RunBody = z.object({ answers: z.record(z.unknown()) });

/**
 * Custom actions: small forms (e.g. "Course Details", "Site visit report") that users run from a lead.
 * Answers are saved on the lead timeline and the action's score is added to the lead score.
 */
@Controller('api/v1')
@RequireFeature('module.crm')
export class CustomActionsController {
  constructor(private db: DbService) {}

  @Get('custom-actions')
  @RequirePermission('crm.lead.view')
  list(@Query() query: unknown) {
    const q = parse(ListQuery, query);
    const a = auth();
    return this.db.tenant(async (tx) => {
      const wsFilter = q.workspaceId ?? a.workspaceId;
      const actions = await tx.customAction.findMany({
        where: {
          isArchived: q.archived === 'true',
          ...(wsFilter ? { OR: [{ workspaceId: null }, { workspaceId: wsFilter }] } : { OR: [{ workspaceId: null }, { workspaceId: { in: a.accessibleWorkspaceIds } }] }),
        },
        orderBy: { code: 'asc' },
      });
      const usage = await tx.leadActionResponse.groupBy({ by: ['actionId'], _count: true, where: { actionId: { in: actions.map((x) => x.id) } } });
      const used = new Map(usage.map((u) => [u.actionId, u._count]));
      return actions.map((x) => ({ ...x, timesUsed: used.get(x.id) ?? 0, canManage: this.canManage(x.workspaceId) }));
    });
  }

  @Post('custom-actions')
  @RequirePermission('org.workspace.view')
  create(@Body() body: unknown) {
    const input = parse(ActionBody, body);
    this.assertManage(input.workspaceId);
    return this.db.tenant(async (tx) => {
      const last = await tx.customAction.findFirst({ orderBy: { code: 'desc' }, select: { code: true } });
      const action = await tx.customAction.create({
        data: {
          tenantId: tenantId(), workspaceId: input.workspaceId, code: (last?.code ?? 1000) + 1, name: input.name,
          description: input.description ?? null, score: input.score, fields: this.normalize(input.fields) as Prisma.InputJsonValue, createdById: auth().userId,
        },
      });
      await this.db.audit(tx, { entity: 'custom_action', entityId: action.id, action: 'custom_action.created', newValue: { name: input.name, code: action.code } });
      return action;
    });
  }

  @Patch('custom-actions/:id')
  @RequirePermission('org.workspace.view')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(ActionBody.partial().extend({ isArchived: z.boolean().optional() }), body);
    return this.db.tenant(async (tx) => {
      const x = await this.get(tx, id);
      this.assertManage(x.workspaceId);
      if (input.workspaceId !== undefined) this.assertManage(input.workspaceId);
      const updated = await tx.customAction.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.workspaceId !== undefined && { workspaceId: input.workspaceId }),
          ...(input.score !== undefined && { score: input.score }),
          ...(input.fields !== undefined && { fields: this.normalize(input.fields, x.fields as unknown as FieldDef[]) as Prisma.InputJsonValue }),
          ...(input.isArchived !== undefined && { isArchived: input.isArchived }),
        },
      });
      await this.db.audit(tx, {
        entity: 'custom_action', entityId: id,
        action: input.isArchived === true ? 'custom_action.archived' : input.isArchived === false ? 'custom_action.restored' : 'custom_action.updated',
        oldValue: { name: x.name, score: x.score }, newValue: { name: input.name, score: input.score },
      });
      return updated;
    });
  }

  @Post('custom-actions/:id/duplicate')
  @RequirePermission('org.workspace.view')
  duplicate(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const x = await this.get(tx, id);
      this.assertManage(x.workspaceId);
      const last = await tx.customAction.findFirst({ orderBy: { code: 'desc' }, select: { code: true } });
      const copy = await tx.customAction.create({
        data: {
          tenantId: tenantId(), workspaceId: x.workspaceId, code: (last?.code ?? 1000) + 1, name: `${x.name} (copy)`,
          description: x.description, score: x.score, fields: x.fields as Prisma.InputJsonValue, createdById: auth().userId,
        },
      });
      await this.db.audit(tx, { entity: 'custom_action', entityId: copy.id, action: 'custom_action.duplicated', newValue: { from: x.code, code: copy.code } });
      return copy;
    });
  }

  /** Runs an action on a lead: answers are validated like custom fields, saved, put on the timeline and scored. */
  @Post('leads/:leadId/actions/:id')
  @HttpCode(201)
  @RequirePermission('crm.lead.update')
  run(@Param('leadId') leadId: string, @Param('id') id: string, @Body() body: unknown) {
    const { answers } = parse(RunBody, body);
    return this.db.tenant(async (tx) => {
      const lead = await tx.lead.findFirst({ where: { AND: [await scopeFilter(tx, 'crm.lead.update'), { id: leadId }] } });
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'Lead not found' });
      const x = await this.get(tx, id);
      if (x.isArchived) throw new BadRequestException({ code: 'ACTION_ARCHIVED', message: 'This action is archived' });
      if (x.workspaceId && x.workspaceId !== lead.workspaceId) throw new BadRequestException({ code: 'ACTION_NOT_FOR_WORKSPACE', message: 'This action belongs to another business line' });
      const { values, errors } = validateCustomFields(x.fields as unknown as FieldDef[], answers);
      if (Object.keys(errors).length) throw new BadRequestException({ code: 'INVALID_ANSWERS', message: Object.values(errors)[0], details: errors });
      const r = await tx.leadActionResponse.create({
        data: { tenantId: tenantId(), workspaceId: lead.workspaceId, leadId, actionId: id, answers: values as Prisma.InputJsonValue, score: x.score, userId: auth().userId },
      });
      await tx.leadActivity.create({
        data: activity(lead, auth().userId, { type: 'action', data: { actionId: id, code: x.code, name: x.name, score: x.score, answers: values, labels: Object.fromEntries((x.fields as unknown as FieldDef[]).map((f) => [f.key, f.label])) } as Prisma.InputJsonValue }),
      });
      const updated = await tx.lead.update({ where: { id: leadId }, data: { score: { increment: x.score }, lastActivityAt: new Date() } });
      return { id: r.id, leadScore: updated.score };
    });
  }

  // ── helpers ──

  /** Gives every question a stable key and checks dropdown options. */
  private normalize(fields: z.infer<typeof FormField>[], previous: FieldDef[] = []) {
    const keys: string[] = [];
    return fields.map((f) => {
      if (['dropdown', 'multiselect'].includes(f.type) && !f.options.length) {
        throw new BadRequestException({ code: 'OPTIONS_REQUIRED', message: `"${f.label}" needs options to choose from` });
      }
      const kept = f.key && previous.some((p) => p.key === f.key) ? f.key : null;
      const key = kept ?? fieldKey(f.label, keys);
      keys.push(key);
      return { key, label: f.label, type: f.type, options: [...new Set(f.options)], required: f.required };
    });
  }

  private canManage(workspaceId: string | null) {
    const scope = auth().permissions['org.workspace.manage'];
    return scope === 'ORGANIZATION' || (!!scope && !!workspaceId && auth().workspaceId === workspaceId);
  }

  private assertManage(workspaceId: string | null) {
    if (!this.canManage(workspaceId)) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: workspaceId ? 'You cannot manage actions of this workspace' : 'Only organization admins can create actions for all workspaces' });
    }
  }

  private async get(tx: Tx, id: string) {
    const x = await tx.customAction.findUnique({ where: { id } });
    if (!x) throw new NotFoundException({ code: 'ACTION_NOT_FOUND', message: 'Custom action not found' });
    return x;
  }
}
