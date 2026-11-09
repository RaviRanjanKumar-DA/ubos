import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, tenantId } from '../../common/context';
import { parse } from '../../common/errors';

const Fields = { title: z.string().trim().min(3).max(160), body: z.string().trim().min(1).max(50_000), category: z.string().trim().max(60).nullable().optional(), status: z.enum(['draft', 'published']).default('draft') };
const Create = z.object(Fields);
const Update = z.object({ title: Fields.title.optional(), body: Fields.body.optional(), category: Fields.category, status: z.enum(['draft', 'published']).optional(), archived: z.literal(true).optional() });
const ListQuery = z.object({ q: z.string().trim().max(100).optional(), category: z.string().trim().max(60).optional() });

/** Knowledge base of a business line: everyone on the desk reads published answers, managers write them. */
@Controller('api/v1/kb')
@RequireFeature('module.support')
export class KbController {
  constructor(private db: DbService) {}

  @Get()
  @RequirePermission('support.ticket.view')
  list(@Query() query: unknown) {
    const q = parse(ListQuery, query);
    const ws = this.ws();
    return this.db.tenant(async (tx) => {
      const manage = this.canManage(ws);
      const rows = await tx.kbArticle.findMany({
        where: {
          workspaceId: ws, isArchived: false, ...(manage ? {} : { status: 'published' }), ...(q.category ? { category: q.category } : {}),
          ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' as const } }, { body: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
        },
        orderBy: { updatedAt: 'desc' }, take: 200,
      });
      return { canManage: manage, articles: rows.map((a) => ({ id: a.id, title: a.title, category: a.category, status: a.status, updatedAt: a.updatedAt, excerpt: a.body.slice(0, 180) })), categories: [...new Set(rows.map((a) => a.category).filter(Boolean))] };
    });
  }

  @Get(':id')
  @RequirePermission('support.ticket.view')
  one(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.article(tx, id);
      if (a.status !== 'published' && !this.canManage(a.workspaceId)) throw new NotFoundException({ code: 'ARTICLE_NOT_FOUND', message: 'Article not found' });
      return { id: a.id, title: a.title, body: a.body, category: a.category, status: a.status, updatedAt: a.updatedAt };
    });
  }

  @Post()
  @RequirePermission('support.manage')
  create(@Body() body: unknown) {
    const input = parse(Create, body);
    const ws = this.ws();
    this.assertManage(ws);
    return this.db.tenant(async (tx) => {
      const a = await tx.kbArticle.create({ data: { tenantId: tenantId(), workspaceId: ws, title: input.title, body: input.body, category: input.category || null, status: input.status, createdById: auth().userId, updatedById: auth().userId } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'kb_article', entityId: a.id, action: 'kb.created', newValue: { title: a.title, status: a.status } });
      return { id: a.id };
    });
  }

  @Patch(':id')
  @RequirePermission('support.manage')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Update, body);
    return this.db.tenant(async (tx) => {
      const a = await this.article(tx, id);
      this.assertManage(a.workspaceId);
      const { archived, category, ...rest } = input;
      await tx.kbArticle.update({ where: { id }, data: { ...rest, ...(category !== undefined ? { category: category || null } : {}), ...(archived ? { isArchived: true } : {}), updatedById: auth().userId, updatedAt: new Date() } });
      await this.db.audit(tx, { workspaceId: a.workspaceId, entity: 'kb_article', entityId: id, action: archived ? 'kb.archived' : 'kb.updated', oldValue: { title: a.title, status: a.status }, newValue: { title: input.title, status: input.status } });
      return { ok: true };
    });
  }

  private async article(tx: Tx, id: string) {
    const a = await tx.kbArticle.findUnique({ where: { id } });
    if (!a || a.isArchived || !auth().accessibleWorkspaceIds.includes(a.workspaceId)) throw new NotFoundException({ code: 'ARTICLE_NOT_FOUND', message: 'Article not found' });
    return a;
  }
  private ws() {
    const ws = auth().workspaceId;
    if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
    return ws;
  }
  private canManage(ws: string) {
    const s = auth().permissions['support.manage'];
    return s === 'ORGANIZATION' || (!!s && auth().workspaceId === ws);
  }
  private assertManage(ws: string) {
    if (!this.canManage(ws)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Only this business line’s managers can change articles' });
  }
}
