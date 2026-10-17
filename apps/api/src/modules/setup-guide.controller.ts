import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../common/db.service';
import { RequirePermission } from '../common/auth.guard';
import { tenantId } from '../common/context';
import { parse } from '../common/errors';
import { setupGuide, STEP_IDS } from '../common/setup-guide';

/** Setup Guide for organization admins: progress is read from real data; a step can be skipped (and un-skipped). */
@Controller('api/v1/setup-guide')
export class SetupGuideController {
  constructor(private db: DbService) {}

  @Get()
  @RequirePermission('org.workspace.manage', 'ORGANIZATION')
  get() {
    return this.db.tenant((tx) => setupGuide(tx, tenantId()));
  }

  @Post('steps/:id/skip')
  @HttpCode(200)
  @RequirePermission('org.workspace.manage', 'ORGANIZATION')
  skip(@Param('id') id: string, @Body() body: unknown) {
    const { skipped } = parse(z.object({ skipped: z.boolean() }), body);
    if (!STEP_IDS.has(id)) throw new BadRequestException({ code: 'UNKNOWN_STEP', message: 'Unknown setup step' });
    return this.db.tenant(async (tx) => {
      const cur = (await tx.organizationSetting.findUnique({ where: { tenantId: tenantId() }, select: { setupSkipped: true } }))?.setupSkipped ?? [];
      const next = skipped ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
      await tx.organizationSetting.upsert({ where: { tenantId: tenantId() }, create: { tenantId: tenantId(), setupSkipped: next }, update: { setupSkipped: next } });
      await this.db.audit(tx, { entity: 'settings', entityId: 'setup_guide', action: skipped ? 'setup.step_skipped' : 'setup.step_unskipped', newValue: { step: id } });
      return { ok: true };
    });
  }
}
