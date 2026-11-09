import type { Tx } from '@ubos/database';
import { matchesConditions, type RuleCondition } from '@ubos/shared';
import type { Availability } from './lead-ops';

/**
 * Territory and field rules: the first rule that matches picks the owner, in turn among its people. A returning customer's
 * own RM (sticky) still comes first, and a rule whose people are all away falls through to the next rule.
 */
export async function routedOwner(
  tx: Tx, ws: { id: string; stickyOwner: boolean }, values: Record<string, unknown>, primaryRmId: string | null | undefined, eligible: string[], avail: Availability,
): Promise<string | null> {
  if (ws.stickyOwner && primaryRmId && eligible.includes(primaryRmId) && !avail.paused.has(primaryRmId)) return null;
  const rules = await tx.routingRule.findMany({ where: { workspaceId: ws.id, isActive: true, isArchived: false }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  const free = (id: string) => !avail.paused.has(id) && !avail.cover.has(id);
  for (const r of rules) {
    if (!matchesConditions(r.conditions as unknown as RuleCondition[], values)) continue;
    const pool = r.userIds.filter((id) => eligible.includes(id));
    if (!pool.length) continue;
    for (let i = 0; i < pool.length; i++) {
      const owner = pool[(r.cursor + i) % pool.length];
      if (!free(owner)) continue;
      await tx.routingRule.update({ where: { id: r.id }, data: { cursor: (r.cursor + i + 1) % 1_000_000, hits: { increment: 1 } } });
      return owner;
    }
  }
  return null;
}

export const routingValues = (input: { source: string; city?: string | null; customFields?: Record<string, unknown> | null }) => ({
  source: input.source, city: input.city ?? null,
  ...Object.fromEntries(Object.entries(input.customFields ?? {}).map(([k, v]) => [`cf:${k}`, v])),
});

/** Brings a lead's score in line with the rules: only the difference is applied, so points from custom actions are kept. */
export async function rescoreLead(tx: Tx, leadId: string) {
  const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { customer: { select: { city: true, email: true, mobile: true } } } });
  if (!lead) return 0;
  const [rules, hits] = await Promise.all([
    tx.scoreRule.findMany({ where: { workspaceId: lead.workspaceId, isActive: true, isArchived: false } }),
    tx.leadScoreHit.findMany({ where: { leadId } }),
  ]);
  const values = {
    source: lead.source, status: lead.status, stage: lead.stageId, city: lead.customer.city, email: lead.customer.email, mobile: lead.customer.mobile,
    ...Object.fromEntries(Object.entries((lead.customFields ?? {}) as Record<string, unknown>).map(([k, v]) => [`cf:${k}`, v])),
  };
  const should = new Map(rules.filter((r) => matchesConditions(r.conditions as unknown as RuleCondition[], values)).map((r) => [r.id, r.points]));
  let delta = 0;
  for (const h of hits) {
    const now = should.get(h.ruleId);
    if (now === undefined) { delta -= h.points; await tx.leadScoreHit.delete({ where: { id: h.id } }); }
    else if (now !== h.points) { delta += now - h.points; await tx.leadScoreHit.update({ where: { id: h.id }, data: { points: now } }); }
  }
  const have = new Set(hits.map((h) => h.ruleId));
  for (const [ruleId, points] of should) if (!have.has(ruleId)) { delta += points; await tx.leadScoreHit.create({ data: { tenantId: lead.tenantId, leadId, ruleId, points } }); }
  if (delta) await tx.lead.update({ where: { id: leadId }, data: { score: { increment: delta } } });
  return delta;
}

/** Asks the background worker to rescore a lead after a change that raises no event of its own. */
export async function queueRescore(tx: Tx, lead: { id: string; tenantId: string; workspaceId: string }) {
  if (await tx.scoreRule.count({ where: { workspaceId: lead.workspaceId, isActive: true, isArchived: false } }) || await tx.leadScoreHit.count({ where: { leadId: lead.id } })) {
    await tx.automationEvent.create({ data: { tenantId: lead.tenantId, workspaceId: lead.workspaceId, event: 'score.refresh', data: { leadId: lead.id }, depth: 0 } });
  }
}
