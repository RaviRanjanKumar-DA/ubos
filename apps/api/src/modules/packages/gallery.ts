import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Ip, NotFoundException, Param, Patch, Post, Put, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { normalizeMobile } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { DbService } from '../../common/db.service';
import { RequireFeature, RequirePermission } from '../../common/auth.guard';
import { auth, ctx, tenantId } from '../../common/context';
import { parse } from '../../common/errors';
import { storage } from '../../common/storage';
import { randomToken } from '../../auth/crypto';
import { asTenant, IntakeService, rateLimit } from '../integration-runtime';
import { webBase } from '../connected/providers';

const MAX_PHOTO = 3 * 1024 * 1024;
const Https = z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Enter a web link');
const Settings = z.object({ title: z.string().trim().min(2).max(120), intro: z.string().trim().max(1000).nullable().optional(), whatsappNumber: z.string().trim().max(20).nullable().optional(), isActive: z.boolean() });
const Item = z.object({ showInGallery: z.boolean().optional(), offerPaise: z.number().int().min(0).max(10_000_000_000).nullable().optional(), brochureUrl: Https.nullable().optional() });
const Enquiry = z.object({ name: z.string().trim().min(2).max(120), mobile: z.string().trim().min(8).max(30), email: z.string().trim().email().max(160).optional().or(z.literal('')), note: z.string().trim().max(1000).optional().or(z.literal('')), itemId: z.string().uuid().nullable().optional(), _hp: z.string().optional() });

/** Only real pictures are accepted, told apart by their first bytes rather than by what the browser claims. */
function photoType(b: Buffer) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

function readPhoto(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    // Too much is read and thrown away rather than cutting the connection, so the sender gets a clear answer.
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_PHOTO) parts.push(c); });
    req.on('end', () => (size > MAX_PHOTO ? reject(new BadRequestException({ code: 'PHOTO_TOO_LARGE', message: 'Choose a photo under 3 MB' })) : resolve(Buffer.concat(parts))));
    req.on('error', reject);
  });
}

const workspace = () => {
  const ws = auth().workspaceId;
  if (!ws) throw new BadRequestException({ code: 'WORKSPACE_REQUIRED', message: 'Choose a business line first' });
  return ws;
};

/** The gallery of a business line: what shows, at what offer, and the link to share. */
@Controller('api/v1')
@RequireFeature('module.crm')
export class GalleryController {
  constructor(private db: DbService) {}

  private link(slug: string) { return `${webBase()}/g/${ctx().tenant!.slug}/${slug}`; }

  @Get('gallery')
  @RequirePermission('crm.lead.view')
  get() {
    const ws = workspace();
    return this.db.tenant(async (tx) => {
      const [g, w, items] = await Promise.all([
        tx.workspaceGallery.findUnique({ where: { workspaceId: ws } }),
        tx.workspace.findUniqueOrThrow({ where: { id: ws }, select: { name: true } }),
        tx.package.findMany({ where: { workspaceId: ws, isArchived: false }, orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, category: true, mrpPaise: true, showInGallery: true, offerPaise: true, brochureUrl: true, photoKey: true, updatedAt: true } }),
      ]);
      return { gallery: g, url: g ? this.link(g.slug) : null, photoBase: g ? `/public/gallery/${ctx().tenant!.slug}/${g.slug}/photo` : null, workspaceName: w.name, items: items.map(({ photoKey, ...i }) => ({ ...i, hasPhoto: !!photoKey })) };
    });
  }

  @Put('gallery')
  @RequirePermission('crm.product.manage')
  save(@Body() body: unknown) {
    const input = parse(Settings, body);
    const ws = workspace();
    if (input.whatsappNumber && !normalizeMobile(input.whatsappNumber)) throw new BadRequestException({ code: 'INVALID_MOBILE', message: 'Enter a valid WhatsApp number' });
    return this.db.tenant(async (tx) => {
      const g = await tx.workspaceGallery.upsert({ where: { workspaceId: ws }, update: input, create: { ...input, tenantId: tenantId(), workspaceId: ws, slug: randomToken(8).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toLowerCase() || randomToken(8) } });
      await this.db.audit(tx, { workspaceId: ws, entity: 'gallery', entityId: g.id, action: 'gallery.saved', newValue: { title: g.title, isActive: g.isActive } });
      return { gallery: g, url: this.link(g.slug) };
    });
  }

  private async item(tx: Tx, id: string) {
    const p = await tx.package.findFirst({ where: { id, workspaceId: workspace() } });
    if (!p) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    return p;
  }

  @Patch('gallery/items/:id')
  @RequirePermission('crm.product.manage')
  updateItem(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(Item, body);
    return this.db.tenant(async (tx) => {
      const p = await this.item(tx, id);
      if (input.offerPaise != null && input.offerPaise >= p.mrpPaise) throw new BadRequestException({ code: 'OFFER_TOO_HIGH', message: 'The offer price must be below the MRP' });
      const r = await tx.package.update({ where: { id }, data: input, select: { id: true, showInGallery: true, offerPaise: true, brochureUrl: true } });
      await this.db.audit(tx, { workspaceId: p.workspaceId, entity: 'product', entityId: id, action: 'gallery.item_updated', newValue: input });
      return r;
    });
  }

  @Post('gallery/items/:id/photo')
  @HttpCode(200)
  @RequirePermission('crm.product.manage')
  async photo(@Param('id') id: string, @Req() req: Request) {
    const data = await readPhoto(req);
    const type = photoType(data);
    if (!type) throw new BadRequestException({ code: 'NOT_A_PHOTO', message: 'Choose a JPG, PNG or WebP photo' });
    const key = `${tenantId()}/gallery/${id}-${randomToken(6).replace(/[^A-Za-z0-9]/g, 'x')}`;
    await this.db.tenant((tx) => this.item(tx, id)); // nothing reaches the disk for someone else's product
    await storage.put(key, data);
    return this.db.tenant(async (tx) => {
      const p = await this.item(tx, id);
      await tx.package.update({ where: { id }, data: { photoKey: key, photoType: type } });
      await this.db.audit(tx, { workspaceId: p.workspaceId, entity: 'product', entityId: id, action: 'gallery.photo_added', newValue: { type, bytes: data.length } });
      return { ok: true };
    });
  }

  /** Takes the photo off the product. The file itself is kept. */
  @Delete('gallery/items/:id/photo')
  @RequirePermission('crm.product.manage')
  removePhoto(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const p = await this.item(tx, id);
      await tx.package.update({ where: { id }, data: { photoKey: null, photoType: null } });
      await this.db.audit(tx, { workspaceId: p.workspaceId, entity: 'product', entityId: id, action: 'gallery.photo_removed', newValue: {} });
      return { ok: true };
    });
  }
}

/** The public catalogue page. No sign-in; only what was marked to show. */
@Controller('public/gallery')
export class PublicGalleryController {
  constructor(private db: DbService, private intake: IntakeService) {}

  private async active(tx: Tx, slug: string) {
    const g = await tx.workspaceGallery.findFirst({ where: { slug, isActive: true } });
    if (!g) throw new NotFoundException({ code: 'GALLERY_NOT_FOUND', message: 'This gallery is not available' });
    return g;
  }

  @Get(':org/:slug')
  page(@Param('org') org: string, @Param('slug') slug: string) {
    return asTenant(this.db, org, async (t) => this.db.tenant(async (tx) => {
      const g = await this.active(tx, slug);
      const items = await tx.package.findMany({ where: { workspaceId: g.workspaceId, showInGallery: true, isArchived: false }, orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, description: true, category: true, unit: true, mrpPaise: true, offerPaise: true, brochureUrl: true, photoKey: true, updatedAt: true } });
      return { organization: t.name, title: g.title, intro: g.intro, whatsappNumber: g.whatsappNumber, items: items.map(({ photoKey, updatedAt, ...i }) => ({ ...i, photoVersion: photoKey ? updatedAt.getTime() : null })) };
    }));
  }

  @Get(':org/:slug/photo/:id')
  photo(@Param('org') org: string, @Param('slug') slug: string, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return asTenant(this.db, org, async () => {
      const p = await this.db.tenant(async (tx) => {
        const g = await tx.workspaceGallery.findFirst({ where: { slug } });
        return g && tx.package.findFirst({ where: { id, workspaceId: g.workspaceId, photoKey: { not: null } }, select: { photoKey: true, photoType: true } });
      });
      if (!p?.photoKey) throw new NotFoundException({ code: 'PHOTO_NOT_FOUND', message: 'Photo not found' });
      const data = await storage.get(p.photoKey);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      return new StreamableFile(data, { type: p.photoType ?? 'image/jpeg' });
    });
  }

  @Post(':org/:slug/enquiry')
  @HttpCode(200)
  enquiry(@Param('org') org: string, @Param('slug') slug: string, @Body() body: unknown, @Ip() ip: string) {
    const input = parse(Enquiry, body);
    return asTenant(this.db, org, async (t) => {
      rateLimit(`gallery:${t.id}:${ip}`, 10);
      if (input._hp) return { ok: true }; // the hidden field was filled: a bot, so pretend success
      const found = await this.db.tenant(async (tx) => {
        const g = await this.active(tx, slug);
        const item = input.itemId ? await tx.package.findFirst({ where: { id: input.itemId, workspaceId: g.workspaceId, showInGallery: true, isArchived: false }, select: { name: true } }) : null;
        return { g, item };
      });
      const remark = [found.item ? `Interested in ${found.item.name} (from the gallery)` : 'Enquiry from the gallery', input.note || null].filter(Boolean).join('\n');
      const { _hp, ...record } = input;
      const out = await this.intake.process({ tenantId: t.id, integrationKey: `gallery:${slug}`, workspaceId: found.g.workspaceId, mode: 'add_remark', via: 'product gallery', record, externalId: `gallery:${randomToken(12)}`, input: { name: input.name, mobile: input.mobile, email: input.email || null, remark, source: 'gallery' } });
      if (out.outcome === 'rejected') throw new BadRequestException({ code: 'INVALID_DETAILS', message: out.errors[0] ?? 'Please check your details' });
      return { ok: true };
    });
  }
}
