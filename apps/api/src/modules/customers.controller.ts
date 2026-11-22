import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '@ubos/database';
import type { Tx } from '@ubos/database';
import { normalizeMobile } from '@ubos/shared';
import { DbService } from '../common/db.service';
import { RequirePermission, RequireFeature } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { parse } from '../common/errors';
import { scopeFilter } from '../common/scope';
import { maskPan, PAN_PATTERN } from '../common/customers';
import { encrypt, keyedHash } from '../auth/crypto';
import { contact, contacts, fieldAccess } from '../common/field-access';

const ListQuery = z.object({ q: z.string().trim().max(100).optional() });
const UpdateCustomer = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  mobile: z.string().trim().max(20).optional(),
  alternateMobiles: z.array(z.string().trim().max(20)).max(10).optional(),
  alternateEmails: z.array(z.string().trim().toLowerCase().email()).max(10).optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('')),
  city: z.string().trim().max(80).nullable().optional(),
  pan: z.string().trim().toUpperCase().regex(PAN_PATTERN, 'PAN must look like ABCDE1234F').nullable().optional().or(z.literal('')),
});
const MergeBody = z.object({ primaryId: z.string().uuid(), duplicateId: z.string().uuid(), reason: z.string().trim().max(300).optional() });
const DismissBody = z.object({ aId: z.string().uuid(), bId: z.string().uuid() });

type Pair = { a: string; b: string; reason: string };

/** Records that belong to a customer and follow it through a merge (and back on undo). */
const FOLLOWERS = ['invoice', 'quote', 'payment', 'ticket', 'call', 'conversation', 'processRun'] as const;
type Follower = (typeof FOLLOWERS)[number];
type Mover = { findMany(a: { where: object; select: { id: true } }): Promise<{ id: string }[]>; updateMany(a: { where: object; data: { customerId: string } }): Promise<{ count: number }> };
const mover = (tx: Tx, k: Follower) => (tx as unknown as Record<Follower, Mover>)[k];

/** Customer Master: one record per person across all business lines, duplicates, merge and Customer 360°. */
@Controller('api/v1/customers')
@RequireFeature('module.crm')
export class CustomersController {
  constructor(private db: DbService) {}

  @Get()
  @RequirePermission('crm.customer.view')
  list(@Query() query: unknown) {
    const { q } = parse(ListQuery, query);
    return this.db.tenant(async (tx) => {
      const where = await this.visibleWhere(tx);
      const search: Prisma.CustomerWhereInput = q
        ? { OR: [
            { name: { contains: q, mode: 'insensitive' } }, { mobile: { contains: q.replace(/\D/g, '') || q } },
            { email: { contains: q, mode: 'insensitive' } }, { code: { equals: q.toUpperCase() } }, { alternateMobiles: { has: normalizeMobile(q) ?? q } },
          ] }
        : {};
      const leadScope = await scopeFilter(tx, 'crm.customer.view');
      const customers = await tx.customer.findMany({
        where: { AND: [where, search] },
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: {
          leads: { where: leadScope, select: { createdAt: true, workspace: { select: { name: true } }, ownerId: true }, orderBy: { createdAt: 'desc' } },
        },
      });
      const fa = await fieldAccess(tx);
      const rmIds = [...new Set(customers.map((c) => c.primaryRmId).filter(Boolean) as string[])];
      const rms = new Map((await tx.user.findMany({ where: { id: { in: rmIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      return customers.map((c) => ({
        id: c.id, code: c.code, name: c.name, mobile: contact(fa, 'mobile', c.mobile), email: contact(fa, 'email', c.email), city: c.city,
        workspaces: [...new Set(c.leads.map((l) => l.workspace.name))],
        leadCount: c.leads.length,
        lastActivityAt: c.leads[0]?.createdAt ?? c.createdAt,
        primaryRm: c.primaryRmId ? rms.get(c.primaryRmId) ?? null : null,
      }));
    });
  }

  /** Pairs of customers that look like the same person. Exact = same email / PAN / number; possible = similar name. */
  @Get('duplicates')
  @RequirePermission('crm.customer.merge', 'ORGANIZATION')
  duplicates() {
    return this.db.tenant(async (tx) => {
      const exact = await tx.$queryRaw<Pair[]>`
        SELECT a.id AS a, b.id AS b, 'Same email' AS reason FROM "Customer" a JOIN "Customer" b
          ON lower(a.email) = lower(b.email) AND a.id < b.id
          WHERE a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL AND a.email IS NOT NULL
        UNION ALL
        SELECT a.id, b.id, 'Same PAN' FROM "Customer" a JOIN "Customer" b
          ON a."panHash" = b."panHash" AND a.id < b.id
          WHERE a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL
        UNION ALL
        SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'Same mobile number' FROM "Customer" a JOIN "Customer" b
          ON b.mobile = ANY(a."alternateMobiles") AND a.id <> b.id
          WHERE a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL
        LIMIT 500`;
      const possible = await tx.$queryRaw<(Pair & { score: number })[]>`
        SELECT a.id AS a, b.id AS b, 'Similar name' AS reason, similarity(lower(a.name), lower(b.name))::float AS score
        FROM "Customer" a JOIN "Customer" b ON lower(a.name) % lower(b.name) AND a.id < b.id
        WHERE a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL AND similarity(lower(a.name), lower(b.name)) >= 0.6
        ORDER BY score DESC LIMIT 200`;
      const dismissed = new Set((await tx.customerDuplicateDismissal.findMany()).map((d) => `${d.customerAId}:${d.customerBId}`));

      const pairs = new Map<string, { a: string; b: string; reasons: string[]; confidence: 'exact' | 'possible' }>();
      for (const p of [...exact.map((x) => ({ ...x, confidence: 'exact' as const })), ...possible.map((x) => ({ ...x, confidence: 'possible' as const }))]) {
        const k = `${p.a}:${p.b}`;
        if (dismissed.has(k)) continue;
        const cur = pairs.get(k);
        if (cur) {
          if (!cur.reasons.includes(p.reason)) cur.reasons.push(p.reason);
          if (p.confidence === 'exact') cur.confidence = 'exact';
        } else pairs.set(k, { a: p.a, b: p.b, reasons: [p.reason], confidence: p.confidence });
      }
      const ids = [...new Set([...pairs.values()].flatMap((p) => [p.a, p.b]))];
      const rows = await tx.customer.findMany({
        where: { id: { in: ids } },
        include: { leads: { select: { workspace: { select: { name: true } } } } },
      });
      const fa = await fieldAccess(tx);
      const card = new Map(rows.map((c) => [c.id, {
        id: c.id, code: c.code, name: c.name, mobile: contact(fa, 'mobile', c.mobile), alternateMobiles: contacts(fa, 'mobile', c.alternateMobiles),
        email: contact(fa, 'email', c.email), alternateEmails: contacts(fa, 'email', c.alternateEmails), city: c.city,
        pan: maskPan(c.panLast4), leadCount: c.leads.length, workspaces: [...new Set(c.leads.map((l) => l.workspace.name))], createdAt: c.createdAt,
      }]));
      return [...pairs.values()]
        .filter((p) => card.has(p.a) && card.has(p.b))
        .sort((x, y) => (x.confidence === y.confidence ? 0 : x.confidence === 'exact' ? -1 : 1))
        .map((p) => ({ ...p, customerA: card.get(p.a), customerB: card.get(p.b) }));
    });
  }

  @Post('duplicates/dismiss')
  @HttpCode(200)
  @RequirePermission('crm.customer.merge', 'ORGANIZATION')
  dismiss(@Body() body: unknown) {
    const { aId, bId } = parse(DismissBody, body);
    const [a, b] = [aId, bId].sort();
    return this.db.tenant(async (tx) => {
      if ((await tx.customer.count({ where: { id: { in: [a, b] } } })) !== 2) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
      await tx.customerDuplicateDismissal.upsert({
        where: { tenantId_customerAId_customerBId: { tenantId: tenantId(), customerAId: a, customerBId: b } },
        create: { tenantId: tenantId(), customerAId: a, customerBId: b, dismissedById: auth().userId },
        update: {},
      });
      await this.db.audit(tx, { entity: 'customer', entityId: a, action: 'customer.not_duplicate', newValue: { otherCustomerId: b } });
      return { ok: true };
    });
  }

  /** Customer 360°: profile, every lead the user may see across business lines, and the activity timeline. */
  @Get(':id')
  @RequirePermission('crm.customer.view')
  async get(@Param('id') id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.visibleCustomer(tx, id);
      const leadScope = await scopeFilter(tx, 'crm.customer.view');
      const leads = await tx.lead.findMany({
        where: { AND: [leadScope, { customerId: c.id }] },
        orderBy: { createdAt: 'desc' },
        include: { workspace: { select: { id: true, name: true } }, pipeline: { select: { name: true } } },
      });
      const stages = new Map((await tx.leadStage.findMany({ where: { id: { in: leads.map((l) => l.stageId) } } })).map((s) => [s.id, s]));
      const userIds = new Set<string>([...leads.map((l) => l.ownerId), c.primaryRmId].filter(Boolean) as string[]);
      const events = await tx.auditLog.findMany({
        where: { OR: [{ entity: 'customer', entityId: c.id }, { entity: 'lead', entityId: { in: leads.map((l) => l.id) } }] },
        orderBy: { id: 'desc' },
        take: 150,
      });
      events.forEach((e) => e.actorId && userIds.add(e.actorId));
      const users = new Map((await tx.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const merges = await tx.customerMerge.findMany({ where: { primaryId: c.id }, orderBy: { createdAt: 'desc' } });
      const mergedCustomers = new Map((await tx.customer.findMany({ where: { id: { in: merges.map((m) => m.duplicateId) } }, select: { id: true, code: true, name: true } })).map((x) => [x.id, x]));
      const leadName = new Map(leads.map((l) => [l.id, `${l.workspace.name} · ${l.pipeline.name}`]));
      const bySource = [...leads].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
      const fa = await fieldAccess(tx);

      return {
        id: c.id, code: c.code, name: c.name, mobile: contact(fa, 'mobile', c.mobile), alternateMobiles: contacts(fa, 'mobile', c.alternateMobiles),
        email: contact(fa, 'email', c.email), alternateEmails: contacts(fa, 'email', c.alternateEmails), city: c.city,
        pan: maskPan(c.panLast4), hasPan: !!c.panHash, createdAt: c.createdAt,
        primaryRm: c.primaryRmId ? { id: c.primaryRmId, name: users.get(c.primaryRmId) ?? '?' } : null,
        firstSource: bySource[0]?.source ?? null,
        lastSource: bySource[bySource.length - 1]?.source ?? null,
        sources: [...new Set(bySource.map((l) => l.source))],
        canEdit: !!auth().permissions['crm.customer.update'],
        canMerge: auth().permissions['crm.customer.merge'] === 'ORGANIZATION',
        leads: leads.map((l) => ({
          id: l.id, workspace: l.workspace.name, workspaceId: l.workspace.id, pipeline: l.pipeline.name,
          stage: stages.get(l.stageId)?.name, isWon: !!stages.get(l.stageId)?.isWon, isLost: !!stages.get(l.stageId)?.isLost,
          lostReason: l.lostReason, source: l.source, owner: l.ownerId ? users.get(l.ownerId) ?? null : null,
          customFields: l.customFields ?? {}, createdAt: l.createdAt,
        })),
        timeline: events.map((e) => ({
          id: e.id.toString(), at: e.createdAt, action: e.action, actor: e.actorId ? users.get(e.actorId) ?? e.actorType : e.actorType,
          context: e.entity === 'lead' ? leadName.get(e.entityId) ?? null : null, oldValue: e.oldValue, newValue: e.newValue,
        })),
        merges: merges.map((m) => ({
          id: m.id, at: m.createdAt, undoneAt: m.undoneAt, reason: m.reason,
          duplicate: mergedCustomers.get(m.duplicateId) ?? { id: m.duplicateId, code: '?', name: '?' }, leadsMoved: m.movedLeadIds.length,
        })),
      };
    });
  }

  @Patch(':id')
  @RequirePermission('crm.customer.update')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(UpdateCustomer, body);
    return this.db.tenant(async (tx) => {
      const c = await this.visibleCustomer(tx, id);
      const data: Prisma.CustomerUpdateInput = {};
      const changes: Record<string, unknown> = {};
      const old: Record<string, unknown> = {};

      if (input.name !== undefined && input.name !== c.name) { data.name = input.name; changes.name = input.name; old.name = c.name; }
      if (input.city !== undefined && input.city !== c.city) { data.city = input.city || null; changes.city = input.city || null; old.city = c.city; }
      if (input.email !== undefined && (input.email || null) !== c.email) {
        data.email = input.email || null; changes.email = data.email; old.email = c.email;
      }
      if (input.mobile !== undefined) {
        const m = normalizeMobile(input.mobile);
        if (!m) throw new BadRequestException({ code: 'INVALID_MOBILE', message: 'Enter a valid mobile number' });
        if (m !== c.mobile) {
          await this.assertMobileFree(tx, m, id);
          data.mobile = m; changes.mobile = m; old.mobile = c.mobile;
        }
      }
      if (input.alternateMobiles !== undefined) {
        const list = [...new Set(input.alternateMobiles.map((x) => {
          const m = normalizeMobile(x);
          if (!m) throw new BadRequestException({ code: 'INVALID_MOBILE', message: `"${x}" is not a valid mobile number` });
          return m;
        }))].filter((m) => m !== (data.mobile ?? c.mobile));
        for (const m of list) await this.assertMobileFree(tx, m, id);
        data.alternateMobiles = list; changes.alternateMobiles = list; old.alternateMobiles = c.alternateMobiles;
      }
      if (input.alternateEmails !== undefined) {
        const main = ((data.email as string | null | undefined) ?? c.email ?? '').toLowerCase();
        const list = [...new Set(input.alternateEmails)].filter((e) => e !== main);
        const other = list.length ? await tx.customer.findFirst({
          where: { id: { not: id }, mergedIntoId: null, OR: [{ email: { in: list, mode: 'insensitive' } }, { alternateEmails: { hasSome: list } }] }, select: { code: true },
        }) : null;
        if (other) throw new ConflictException({ code: 'EMAIL_BELONGS_TO_OTHER', message: `One of these emails is already on customer ${other.code}. Merge the two records instead.` });
        data.alternateEmails = list; changes.alternateEmails = list; old.alternateEmails = c.alternateEmails;
      }
      if (input.pan !== undefined) {
        if (input.pan) {
          const hash = keyedHash(input.pan);
          const other = await tx.customer.findFirst({ where: { panHash: hash, mergedIntoId: null, id: { not: id } }, select: { code: true } });
          if (other) throw new ConflictException({ code: 'PAN_BELONGS_TO_OTHER', message: `This PAN is already on customer ${other.code}. Merge the two records instead.` });
          data.panEncrypted = encrypt(input.pan); data.panHash = hash; data.panLast4 = input.pan.slice(-4);
          changes.pan = maskPan(input.pan.slice(-4));
        } else {
          data.panEncrypted = null; data.panHash = null; data.panLast4 = null; changes.pan = null;
        }
        old.pan = maskPan(c.panLast4); // audit never contains the full PAN
      }
      if (!Object.keys(changes).length) return { id, changed: false };
      await tx.customer.update({ where: { id }, data });
      await this.db.audit(tx, { entity: 'customer', entityId: id, action: 'customer.updated', oldValue: old, newValue: changes });
      return { id, changed: true };
    });
  }

  /**
   * Merges `duplicateId` into `primaryId`: leads and packages move, empty details are filled from the duplicate,
   * its numbers become alternate numbers. The duplicate is kept (marked merged) so the merge can be undone.
   */
  @Post('merge')
  @HttpCode(200)
  @RequirePermission('crm.customer.merge', 'ORGANIZATION')
  merge(@Body() body: unknown) {
    const { primaryId, duplicateId, reason } = parse(MergeBody, body);
    if (primaryId === duplicateId) throw new BadRequestException({ code: 'SAME_CUSTOMER', message: 'Choose two different customers' });
    return this.db.tenant(async (tx) => {
      const [p, d] = await Promise.all([tx.customer.findUnique({ where: { id: primaryId } }), tx.customer.findUnique({ where: { id: duplicateId } })]);
      if (!p || !d) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
      if (p.mergedIntoId || d.mergedIntoId) throw new ConflictException({ code: 'ALREADY_MERGED', message: 'One of these customers was already merged' });

      const leads = await tx.lead.findMany({ where: { customerId: d.id }, select: { id: true } });
      const packages = await tx.customerPackage.findMany({ where: { customerId: d.id }, select: { id: true } });
      const accessRows = await tx.customerAccess.findMany({ where: { customerId: d.id }, select: { id: true } });
      await tx.customerAccess.updateMany({ where: { customerId: d.id }, data: { customerId: p.id } });
      await tx.lead.updateMany({ where: { customerId: d.id }, data: { customerId: p.id } });
      await tx.customerPackage.updateMany({ where: { customerId: d.id }, data: { customerId: p.id } });
      // Invoices, quotes, payments, tickets, calls, conversations and process runs move too (issued invoices keep their printed name).
      const movedOther: Record<string, string[]> = {};
      for (const k of FOLLOWERS) {
        const rows = await mover(tx, k).findMany({ where: { customerId: d.id }, select: { id: true } });
        if (rows.length) { movedOther[k] = rows.map((r) => r.id); await mover(tx, k).updateMany({ where: { customerId: d.id }, data: { customerId: p.id } }); }
      }

      const filled: Record<string, unknown> = {};
      const pData: Prisma.CustomerUpdateInput = {};
      if (!p.email && d.email) { pData.email = d.email; filled.email = d.email; }
      if (!p.city && d.city) { pData.city = d.city; filled.city = d.city; }
      if (!p.panHash && d.panHash) {
        pData.panEncrypted = d.panEncrypted; pData.panHash = d.panHash; pData.panLast4 = d.panLast4; filled.pan = true;
      }
      if (!p.primaryRmId && d.primaryRmId) { pData.primaryRmId = d.primaryRmId; filled.primaryRmId = d.primaryRmId; } // sticky RM: primary keeps its RM
      const addedNumbers = [d.mobile, ...d.alternateMobiles].filter((m): m is string => !!m && m !== p.mobile && !p.alternateMobiles.includes(m));
      if (addedNumbers.length) { pData.alternateMobiles = [...p.alternateMobiles, ...addedNumbers]; filled.alternateMobiles = addedNumbers; }

      // Mark the duplicate merged first, so its mobile no longer counts as an active customer's number.
      await tx.customer.update({ where: { id: d.id }, data: { mergedIntoId: p.id, mergedAt: new Date() } });
      if (Object.keys(pData).length) await tx.customer.update({ where: { id: p.id }, data: pData });

      const record = await tx.customerMerge.create({
        data: {
          tenantId: tenantId(), primaryId: p.id, duplicateId: d.id, reason: reason ?? null, mergedById: auth().userId,
          movedLeadIds: leads.map((l) => l.id), movedPackageIds: packages.map((x) => x.id), movedAccessIds: accessRows.map((x) => x.id), movedOther: movedOther as Prisma.InputJsonObject, filledFields: filled as Prisma.InputJsonObject,
        },
      });
      await this.db.audit(tx, {
        entity: 'customer', entityId: p.id, action: 'customer.merged',
        oldValue: { duplicate: { id: d.id, code: d.code, name: d.name } },
        newValue: { leadsMoved: leads.length, otherMoved: Object.fromEntries(Object.entries(movedOther).map(([k, v]) => [k, v.length])), filled: Object.keys(filled), reason: reason ?? null },
      });
      return { mergeId: record.id, primaryId: p.id, leadsMoved: leads.length, otherMoved: Object.fromEntries(Object.entries(movedOther).map(([k, v]) => [k, v.length])) };
    });
  }

  /** Reverses a merge: the duplicate comes back with the leads that were moved and copied details are removed. */
  @Post('merges/:mergeId/undo')
  @HttpCode(200)
  @RequirePermission('crm.customer.merge', 'ORGANIZATION')
  undo(@Param('mergeId') mergeId: string) {
    return this.db.tenant(async (tx) => {
      const m = await tx.customerMerge.findUnique({ where: { id: mergeId } });
      if (!m) throw new NotFoundException({ code: 'MERGE_NOT_FOUND', message: 'Merge not found' });
      if (m.undoneAt) throw new ConflictException({ code: 'ALREADY_UNDONE', message: 'This merge was already undone' });
      const later = await tx.customerMerge.findFirst({ where: { primaryId: m.primaryId, createdAt: { gt: m.createdAt }, undoneAt: null } });
      if (later) throw new ConflictException({ code: 'UNDO_LATER_FIRST', message: 'Undo the later merges into this customer first' });
      const [p, d] = await Promise.all([tx.customer.findUniqueOrThrow({ where: { id: m.primaryId } }), tx.customer.findUniqueOrThrow({ where: { id: m.duplicateId } })]);
      const filled = m.filledFields as Record<string, unknown>;

      const pData: Prisma.CustomerUpdateInput = {};
      if (filled.email && p.email === filled.email) pData.email = null;
      if (filled.city && p.city === filled.city) pData.city = null;
      if (filled.pan && p.panHash === d.panHash) { pData.panEncrypted = null; pData.panHash = null; pData.panLast4 = null; }
      if (filled.primaryRmId && p.primaryRmId === filled.primaryRmId) pData.primaryRmId = null;
      if (Array.isArray(filled.alternateMobiles)) pData.alternateMobiles = p.alternateMobiles.filter((x) => !(filled.alternateMobiles as string[]).includes(x));
      if (Object.keys(pData).length) await tx.customer.update({ where: { id: p.id }, data: pData });

      if (d.mobile) {
        const clash = await tx.customer.findFirst({ where: { mobile: d.mobile, mergedIntoId: null, id: { not: d.id } }, select: { code: true } });
        if (clash) throw new ConflictException({ code: 'MOBILE_NOW_IN_USE', message: `The duplicate's number now belongs to ${clash.code}; undo is not possible` });
      }
      await tx.customer.update({ where: { id: d.id }, data: { mergedIntoId: null, mergedAt: null } });
      await tx.lead.updateMany({ where: { id: { in: m.movedLeadIds }, customerId: p.id }, data: { customerId: d.id } });
      await tx.customerPackage.updateMany({ where: { id: { in: m.movedPackageIds }, customerId: p.id }, data: { customerId: d.id } });
      await tx.customerAccess.updateMany({ where: { id: { in: m.movedAccessIds }, customerId: p.id }, data: { customerId: d.id } });
      for (const [k, ids] of Object.entries((m.movedOther ?? {}) as Record<string, string[]>)) {
        if ((FOLLOWERS as readonly string[]).includes(k) && ids.length) await mover(tx, k as Follower).updateMany({ where: { id: { in: ids }, customerId: p.id }, data: { customerId: d.id } });
      }
      await tx.customerMerge.update({ where: { id: m.id }, data: { undoneAt: new Date(), undoneById: auth().userId } });
      await this.db.audit(tx, { entity: 'customer', entityId: p.id, action: 'customer.merge_undone', newValue: { restored: { id: d.id, code: d.code, name: d.name } } });
      return { ok: true, restoredId: d.id };
    });
  }

  // ── helpers ──

  /** Organization-wide viewers see all customers; others only customers with at least one lead they can see. */
  private async visibleWhere(tx: Tx): Promise<Prisma.CustomerWhereInput> {
    const base = { mergedIntoId: null };
    if (auth().permissions['crm.customer.view'] === 'ORGANIZATION' && !auth().workspaceId) return base;
    return { ...base, leads: { some: await scopeFilter(tx, 'crm.customer.view') } };
  }

  private async visibleCustomer(tx: Tx, id: string) {
    const c = await tx.customer.findFirst({ where: { AND: [await this.visibleWhere(tx), { id }] } });
    if (!c) {
      const merged = await tx.customer.findUnique({ where: { id }, select: { mergedIntoId: true } });
      if (merged?.mergedIntoId) {
        throw new ConflictException({ code: 'CUSTOMER_MERGED', message: 'This customer was merged into another record', details: { mergedIntoId: merged.mergedIntoId } });
      }
      throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
    }
    return c;
  }

  private async assertMobileFree(tx: Tx, mobile: string, selfId: string) {
    const other = await tx.customer.findFirst({
      where: { mergedIntoId: null, id: { not: selfId }, OR: [{ mobile }, { alternateMobiles: { has: mobile } }] },
      select: { code: true },
    });
    if (other) throw new ConflictException({ code: 'MOBILE_BELONGS_TO_OTHER', message: `This number is already on customer ${other.code}. Merge the two records instead.` });
  }
}
