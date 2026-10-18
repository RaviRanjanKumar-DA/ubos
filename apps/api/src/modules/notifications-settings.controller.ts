import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { DASHBOARD_TEMPLATES } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { SchedulerService } from './scheduler.service';

const OrgSettings = z.object({ digestHour: z.number().int().min(0).max(23), reminderMinutes: z.number().int().min(0).max(1440) });
const MySettings = z.object({ digestEnabled: z.boolean() });
const Subscription = z.object({ frequency: z.enum(['daily', 'weekly']).default('daily'), hour: z.number().int().min(0).max(23).default(9) });

/** Reminder & daily-summary settings, "email me this dashboard", and running the scheduler on demand. */
@Controller('api/v1')
export class NotificationsSettingsController {
  constructor(private db: DbService, private scheduler: SchedulerService) {}

  @Get('settings/notifications')
  @RequirePermission('dashboard.view')
  get() {
    return this.db.tenant(async (tx) => {
      const [org, me] = await Promise.all([
        tx.organizationSetting.findUnique({ where: { tenantId: tenantId() }, select: { digestHour: true, reminderMinutes: true } }),
        tx.user.findUnique({ where: { id: auth().userId }, select: { digestEnabled: true, lastDigestAt: true } }),
      ]);
      return { digestHour: org?.digestHour ?? 9, reminderMinutes: org?.reminderMinutes ?? 15, digestEnabled: me?.digestEnabled ?? true, lastDigestAt: me?.lastDigestAt ?? null, canManage: auth().permissions['org.security.manage'] === 'ORGANIZATION' };
    });
  }

  @Put('settings/notifications')
  @RequirePermission('org.security.manage', 'ORGANIZATION')
  saveOrg(@Body() body: unknown) {
    const input = parse(OrgSettings, body);
    return this.db.tenant(async (tx) => {
      await tx.organizationSetting.upsert({ where: { tenantId: tenantId() }, create: { tenantId: tenantId(), ...input }, update: input });
      await this.db.audit(tx, { entity: 'settings', entityId: 'notifications', action: 'settings.notifications_changed', newValue: input });
      return input;
    });
  }

  /** Each person can switch their own daily summary off or on. */
  @Put('me/notifications')
  saveMine(@Body() body: unknown) {
    const { digestEnabled } = parse(MySettings, body);
    return this.db.tenant(async (tx) => {
      await tx.user.update({ where: { id: auth().userId }, data: { digestEnabled } });
      return { digestEnabled };
    });
  }

  @Get('dashboards/:id/subscription')
  @RequirePermission('dashboard.view')
  subscription(@Param('id') id: string) {
    return this.db.tenant((tx) => tx.dashboardSubscription.findUnique({ where: { userId_dashboardId: { userId: auth().userId, dashboardId: id } } }));
  }

  /** "Email me this dashboard" — only for dashboards the person can open; numbers follow their own access. */
  @Put('dashboards/:id/subscription')
  @RequirePermission('dashboard.view')
  subscribe(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Subscription, body);
    return this.db.tenant(async (tx) => {
      if (id.startsWith('tpl:')) {
        if (!DASHBOARD_TEMPLATES.some((t) => `tpl:${t.key}` === id)) throw new BadRequestException({ code: 'DASHBOARD_NOT_FOUND', message: 'Dashboard not found' });
      } else {
        const d = await tx.dashboard.findUnique({ where: { id } });
        const roles = (await tx.role.findMany({ where: { name: { in: auth().assignments.map((x) => x.roleName) } }, select: { id: true } })).map((r) => r.id);
        const me = auth();
        const visible = d && (d.ownerId === me.userId || me.permissions['dashboard.manage'] === 'ORGANIZATION' || d.sharedUserIds.includes(me.userId)
          || d.sharedRoleIds.some((r) => roles.includes(r)) || d.defaultForRoleIds.some((r) => roles.includes(r)) || (!!me.teamId && d.sharedTeamIds.includes(me.teamId))
          || d.sharedWorkspaceIds.some((w) => me.accessibleWorkspaceIds.includes(w)));
        if (!visible) throw new BadRequestException({ code: 'DASHBOARD_NOT_FOUND', message: 'Dashboard not found' });
      }
      return tx.dashboardSubscription.upsert({
        where: { userId_dashboardId: { userId: auth().userId, dashboardId: id } },
        create: { tenantId: tenantId(), userId: auth().userId, dashboardId: id, ...input },
        update: input,
      });
    });
  }

  @Delete('dashboards/:id/subscription')
  @RequirePermission('dashboard.view')
  unsubscribe(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      await tx.dashboardSubscription.deleteMany({ where: { userId: auth().userId, dashboardId: id } });
      return { ok: true };
    });
  }

  /** Sends due reminders, summaries and dashboard emails for this organization now (admins). */
  @Post('automation/run-now')
  @HttpCode(200)
  @RequirePermission('org.security.manage', 'ORGANIZATION')
  async runNow() {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_RUN_NOW !== 'true') throw new ForbiddenException({ code: 'DISABLED', message: 'Not available here' });
    return this.scheduler.tick(tenantId());
  }
}
