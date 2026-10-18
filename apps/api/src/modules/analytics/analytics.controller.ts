import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, Tx } from '@ubos/database';
import { DASHBOARD_TEMPLATES, GROUP_LABELS, METRICS, RANGE_LABELS, WIDGET_LABELS } from '@ubos/shared';
import { DbService } from '../../common/db.service';
import { RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { scopeFilter } from '../../common/scope';
import { AuditAccessError, Ctx, followUpList, forecast, funnel, leaderboard, loadLookups, resolveRange, runMetric } from './engine';

const RangeKey = z.enum(Object.keys(RANGE_LABELS) as [string, ...string[]]);
const GroupKey = z.enum(Object.keys(GROUP_LABELS) as [string, ...string[]]);
const WidgetKey = z.enum(Object.keys(WIDGET_LABELS) as [string, ...string[]]);
const MetricKey = z.enum(Object.keys(METRICS) as [string, ...string[]]);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.array(z.string().uuid()).max(200).optional();

const Widget = z.object({
  id: z.string().trim().min(1).max(40),
  type: WidgetKey,
  title: z.string().trim().max(80).default(''),
  metric: MetricKey.optional(),
  groupBy: GroupKey.optional(),
  range: RangeKey.optional(),
  target: z.number().min(0).max(1e12).optional(),
  w: z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12)]).default(6),
  h: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
});
const Widgets = z.array(Widget).max(30);
const Batch = z.object({
  range: RangeKey.default('this_month'), from: day.optional(), to: day.optional(), compare: z.boolean().default(true),
  filters: z.object({ workspaceIds: ids, ownerIds: ids, teamIds: ids, sources: z.array(z.string().max(60)).max(50).optional(), statuses: z.array(z.string().max(60)).max(50).optional(), stageIds: ids }).default({}),
  widgets: Widgets.min(1),
});
const DashboardBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  range: RangeKey.default('this_month'),
  widgets: Widgets,
});
const Sharing = z.object({
  sharedRoleIds: z.array(z.string().uuid()).max(100).default([]),
  sharedTeamIds: z.array(z.string().uuid()).max(100).default([]),
  sharedWorkspaceIds: z.array(z.string().uuid()).max(100).default([]),
  sharedUserIds: z.array(z.string().uuid()).max(500).default([]),
  defaultForRoleIds: z.array(z.string().uuid()).max(100).default([]),
  isLocked: z.boolean().default(false),
});

type DashboardRow = Prisma.DashboardGetPayload<object>;

/**
 * Dashboards & analytics. Every number is computed inside the viewer's "View dashboards" scope (own / team /
 * business line / organization), so a shared dashboard shows each person only what they may see.
 */
@Controller('api/v1')
export class AnalyticsController {
  constructor(private db: DbService) {}

  /** Runs all widgets of a dashboard in one request. */
  @Post('analytics/batch')
  @HttpCode(200)
  @RequirePermission('dashboard.view')
  batch(@Body() body: unknown) {
    const input = parse(Batch, body);
    return this.db.tenant(async (tx) => {
      const L = await loadLookups(tx, tenantId());
      const { teamIds, ...filters } = input.filters;
      if (teamIds?.length) {
        // A team filter becomes the people in those teams (intersected with any person filter).
        const members = (await tx.user.findMany({ where: { teamId: { in: teamIds } }, select: { id: true } })).map((u) => u.id);
        filters.ownerIds = filters.ownerIds?.length ? filters.ownerIds.filter((id) => members.includes(id)) : members;
        if (!filters.ownerIds.length) filters.ownerIds = ['00000000-0000-0000-0000-000000000000'];
      }
      const c: Ctx = { tx, L, scope: await scopeFilter(tx, 'dashboard.view'), filters, tenantId: tenantId(), auditAllowed: auth().permissions['audit.view'] === 'ORGANIZATION' };
      const out: Record<string, unknown> = {};
      for (const w of input.widgets) {
        const r = resolveRange((w.range ?? input.range) as never, L.tz, input.from, input.to);
        const period = { from: r.from, to: r.to, label: r.label };
        try {
          if (w.type === 'funnel') out[w.id] = { ...period, ...(await funnel(c, r)) };
          else if (w.type === 'leaderboard') out[w.id] = { ...period, rows: await leaderboard(c, r) };
          else if (w.type === 'followups') out[w.id] = { rows: await followUpList(c) };
          else if (w.type === 'forecast') out[w.id] = await forecast(c);
          else {
            if (!w.metric) throw new BadRequestException({ code: 'METRIC_REQUIRED', message: `Choose a metric for "${w.title}"` });
            const group = w.type === 'kpi' || w.type === 'gauge' ? 'none' : (w.groupBy ?? 'none');
            out[w.id] = { ...period, ...(await runMetric(c, w.metric, group as never, r, input.compare)), target: w.target ?? null };
          }
        } catch (e) {
          if (e instanceof BadRequestException) throw e;
          if (e instanceof AuditAccessError) { out[w.id] = { error: 'Visible to people with organization-wide audit access' }; continue; }
          out[w.id] = { error: 'Could not compute this widget' };
        }
      }
      return out;
    }, { timeoutMs: 30_000 });
  }

  /** Catalogue for the dashboard builder. */
  @Get('analytics/catalog')
  @RequirePermission('dashboard.view')
  catalog() {
    return { metrics: METRICS, groups: GROUP_LABELS, ranges: RANGE_LABELS, widgets: WIDGET_LABELS, templates: DASHBOARD_TEMPLATES };
  }

  // ── Saved dashboards ──

  @Get('dashboards')
  @RequirePermission('dashboard.view')
  list() {
    return this.db.tenant(async (tx) => {
      const me = await this.viewer(tx);
      const all = await tx.dashboard.findMany({ orderBy: { updatedAt: 'desc' } });
      const visible = all.filter((d) => this.canSee(d, me));
      const forMyRole = visible.find((d) => d.defaultForRoleIds.some((r) => me.roleIds.includes(r)));
      return {
        templates: DASHBOARD_TEMPLATES.filter((t) => this.templatesForScope().includes(t.key)).map((t) => ({ key: t.key, name: t.name, description: t.description })),
        mine: visible.filter((d) => d.ownerId === me.userId).map((d) => this.out(d, me)),
        shared: visible.filter((d) => d.ownerId !== me.userId).map((d) => this.out(d, me)),
        defaultId: forMyRole?.id ?? `tpl:${this.defaultTemplate()}`,
        canShare: !!auth().permissions['dashboard.manage'],
      };
    });
  }

  @Get('dashboards/:id')
  @RequirePermission('dashboard.view')
  get(@Param('id') id: string) {
    if (id.startsWith('tpl:')) {
      const t = DASHBOARD_TEMPLATES.find((x) => x.key === id.slice(4));
      if (!t) throw new NotFoundException({ code: 'DASHBOARD_NOT_FOUND', message: 'Dashboard not found' });
      return { id, name: t.name, description: t.description, widgets: t.widgets, range: 'this_month', isTemplate: true, canEdit: false, canShare: false };
    }
    return this.db.tenant(async (tx) => {
      const me = await this.viewer(tx);
      const d = await this.visible(tx, id, me);
      return { ...this.out(d, me), widgets: d.widgets };
    });
  }

  /** Creates a personal dashboard (blank, from a template, or a copy of one you can see). */
  @Post('dashboards')
  @RequirePermission('dashboard.view')
  create(@Body() body: unknown) {
    const input = parse(DashboardBody, body);
    return this.db.tenant(async (tx) => {
      const d = await tx.dashboard.create({
        data: { tenantId: tenantId(), ownerId: auth().userId, name: input.name, description: input.description ?? null, range: input.range, widgets: input.widgets as Prisma.InputJsonValue },
      });
      await this.db.audit(tx, { entity: 'dashboard', entityId: d.id, action: 'dashboard.created', newValue: { name: d.name, widgets: input.widgets.length } });
      return d;
    });
  }

  @Patch('dashboards/:id')
  @RequirePermission('dashboard.view')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(DashboardBody.partial(), body);
    return this.db.tenant(async (tx) => {
      const me = await this.viewer(tx);
      const d = await this.visible(tx, id, me);
      if (!this.canEdit(d, me)) throw new ForbiddenException({ code: 'DASHBOARD_LOCKED', message: 'Only its owner can change this dashboard — duplicate it to customise' });
      const updated = await tx.dashboard.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }), ...(input.description !== undefined && { description: input.description }),
          ...(input.range !== undefined && { range: input.range }), ...(input.widgets !== undefined && { widgets: input.widgets as Prisma.InputJsonValue }),
        },
      });
      await this.db.audit(tx, { entity: 'dashboard', entityId: id, action: 'dashboard.updated', newValue: { name: updated.name } });
      return updated;
    });
  }

  /** Publishes a dashboard to roles / teams / business lines / people, sets it as a role's default, locks it. */
  @Put('dashboards/:id/sharing')
  @RequirePermission('dashboard.manage')
  share(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Sharing, body);
    return this.db.tenant(async (tx) => {
      const me = await this.viewer(tx);
      const d = await this.visible(tx, id, me);
      if (d.ownerId !== me.userId && !me.orgManager) throw new ForbiddenException({ code: 'NOT_OWNER', message: 'Only the owner can share this dashboard' });
      if (!me.orgManager) {
        // Business-line managers share inside their own business lines only.
        if (input.sharedRoleIds.length || input.defaultForRoleIds.length || input.sharedTeamIds.length) {
          throw new ForbiddenException({ code: 'ORG_SHARE_ONLY', message: 'Sharing with roles or teams, and default dashboards, need organization-wide dashboard rights' });
        }
        if (input.sharedWorkspaceIds.some((w) => !auth().accessibleWorkspaceIds.includes(w))) throw new ForbiddenException({ code: 'WORKSPACE_DENIED', message: 'You can only share with your own business lines' });
      }
      const [roles, teams, wss, users] = await Promise.all([
        tx.role.count({ where: { id: { in: [...input.sharedRoleIds, ...input.defaultForRoleIds] } } }),
        tx.team.count({ where: { id: { in: input.sharedTeamIds } } }),
        tx.workspace.count({ where: { id: { in: input.sharedWorkspaceIds } } }),
        tx.user.count({ where: { id: { in: input.sharedUserIds } } }),
      ]);
      if (roles !== new Set([...input.sharedRoleIds, ...input.defaultForRoleIds]).size || teams !== input.sharedTeamIds.length || wss !== input.sharedWorkspaceIds.length || users !== input.sharedUserIds.length) {
        throw new BadRequestException({ code: 'INVALID_TARGET', message: 'Some roles, teams, business lines or people were not found' });
      }
      if (input.defaultForRoleIds.length) {
        // One default per role: take the role off other dashboards.
        const others = await tx.dashboard.findMany({ where: { id: { not: id }, defaultForRoleIds: { hasSome: input.defaultForRoleIds } } });
        for (const o of others) await tx.dashboard.update({ where: { id: o.id }, data: { defaultForRoleIds: o.defaultForRoleIds.filter((r) => !input.defaultForRoleIds.includes(r)) } });
      }
      const updated = await tx.dashboard.update({ where: { id }, data: input });
      await this.db.audit(tx, { entity: 'dashboard', entityId: id, action: 'dashboard.shared', oldValue: { roles: d.sharedRoleIds, teams: d.sharedTeamIds, workspaces: d.sharedWorkspaceIds, users: d.sharedUserIds, defaults: d.defaultForRoleIds, locked: d.isLocked }, newValue: input });
      return updated;
    });
  }

  @Delete('dashboards/:id')
  @RequirePermission('dashboard.view')
  remove(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const me = await this.viewer(tx);
      const d = await this.visible(tx, id, me);
      if (d.ownerId !== me.userId && !me.orgManager) throw new ForbiddenException({ code: 'NOT_OWNER', message: 'Only the owner can delete this dashboard' });
      await tx.dashboard.delete({ where: { id } });
      await this.db.audit(tx, { entity: 'dashboard', entityId: id, action: 'dashboard.deleted', oldValue: { name: d.name } });
      return { ok: true };
    });
  }

  // ── helpers ──

  /** Ready dashboards that make sense for the viewer's level (numbers are scoped either way). */
  private templatesForScope() {
    const scope = auth().permissions['dashboard.view'];
    if (scope === 'ORGANIZATION') return ['management', 'company', 'business_line', 'team_audit', 'team', 'marketing', 'my_day'];
    if (scope === 'WORKSPACE') return ['business_line', 'team_audit', 'team', 'marketing', 'my_day'];
    if (scope === 'OWN') return ['my_day'];
    return ['team', 'team_audit', 'my_day'];
  }

  private defaultTemplate() {
    const a = auth();
    const scope = a.permissions['dashboard.view'];
    if (scope === 'ORGANIZATION') return a.workspaceId ? 'business_line' : 'management';
    if (scope === 'WORKSPACE') return 'business_line';
    if (scope === 'OWN') return 'my_day';
    return 'team';
  }

  private async viewer(tx: Tx) {
    const a = auth();
    const roles = await tx.role.findMany({ where: { name: { in: a.assignments.map((x) => x.roleName) } }, select: { id: true } });
    return { userId: a.userId, teamId: a.teamId, roleIds: roles.map((r) => r.id), workspaceIds: a.accessibleWorkspaceIds, orgManager: a.permissions['dashboard.manage'] === 'ORGANIZATION' };
  }

  private canSee(d: DashboardRow, me: Awaited<ReturnType<AnalyticsController['viewer']>>) {
    return d.ownerId === me.userId || me.orgManager || d.sharedUserIds.includes(me.userId) || d.sharedRoleIds.some((r) => me.roleIds.includes(r))
      || d.defaultForRoleIds.some((r) => me.roleIds.includes(r)) || (!!me.teamId && d.sharedTeamIds.includes(me.teamId)) || d.sharedWorkspaceIds.some((w) => me.workspaceIds.includes(w));
  }

  /** Owners can always edit; organization dashboard managers can too unless the owner locked it. */
  private canEdit(d: DashboardRow, me: Awaited<ReturnType<AnalyticsController['viewer']>>) {
    return d.ownerId === me.userId || (me.orgManager && !d.isLocked);
  }

  private async visible(tx: Tx, id: string, me: Awaited<ReturnType<AnalyticsController['viewer']>>) {
    const d = await tx.dashboard.findUnique({ where: { id } });
    if (!d || !this.canSee(d, me)) throw new NotFoundException({ code: 'DASHBOARD_NOT_FOUND', message: 'Dashboard not found' });
    return d;
  }

  private out(d: DashboardRow, me: Awaited<ReturnType<AnalyticsController['viewer']>>) {
    const shared = d.sharedRoleIds.length + d.sharedTeamIds.length + d.sharedWorkspaceIds.length + d.sharedUserIds.length + d.defaultForRoleIds.length > 0;
    return {
      id: d.id, name: d.name, description: d.description, range: d.range, isTemplate: false, ownerId: d.ownerId, isMine: d.ownerId === me.userId,
      isLocked: d.isLocked, isShared: shared, canEdit: this.canEdit(d, me), canShare: d.ownerId === me.userId || me.orgManager,
      sharing: { sharedRoleIds: d.sharedRoleIds, sharedTeamIds: d.sharedTeamIds, sharedWorkspaceIds: d.sharedWorkspaceIds, sharedUserIds: d.sharedUserIds, defaultForRoleIds: d.defaultForRoleIds, isLocked: d.isLocked },
      widgetCount: Array.isArray(d.widgets) ? d.widgets.length : 0, updatedAt: d.updatedAt,
    };
  }
}
