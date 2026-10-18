import type { Tx } from '@ubos/database';
import { normalizeMobile, validateCustomFields, type DuplicateMode, type FieldDef } from '@ubos/shared';
import { findCustomer, nextCustomerCode } from './customers';
import { activity, assignmentAvailability, defaultStatus, eligibleOwners, makeAssigner } from './lead-ops';
import { notify } from './notify';
import { emitEvent } from './events';

/** A lead arriving from outside: webhook, web form, public API, Google Sheet. */
export interface IntakeInput {
  name?: string | null; mobile?: string | null; email?: string | null; city?: string | null; remark?: string | null;
  customFields?: Record<string, unknown>; source: string;
}
export type IntakeOutcome = 'created' | 'linked' | 'add_remark' | 'update_blank' | 'overwrite' | 'skip' | 'rejected';
export interface IntakeResult { outcome: IntakeOutcome; leadId: string | null; customerId: string | null; errors: string[] }

const blank = (v: unknown) => v === undefined || v === null || v === '';

/**
 * One path for every channel: checks the Lead ID, matches the customer across the organization, applies the
 * duplicate rule when the person already has an open lead in this business line, otherwise creates the lead
 * with the business line's assignment rules. Required custom fields are not enforced (outside forms can't
 * always send them); values that are present must be valid.
 */
export async function intakeLead(tx: Tx, tenantId: string, workspaceId: string, input: IntakeInput, mode: DuplicateMode, via: string): Promise<IntakeResult> {
  const errors: string[] = [];
  const byEmail = (await tx.organizationSetting.findFirst())?.leadIdentifier === 'email';
  const name = (input.name ?? '').toString().trim().slice(0, 120);
  const email = input.email ? String(input.email).trim().toLowerCase().slice(0, 160) : null;
  const mobile = input.mobile ? normalizeMobile(String(input.mobile)) : null;
  if (!name) errors.push('Name is missing');
  if (input.mobile && !mobile) errors.push(`"${input.mobile}" is not a valid mobile number`);
  if (!byEmail && !mobile) errors.push('Mobile is missing (it is the Lead ID)');
  if (byEmail && !email) errors.push('Email is missing (it is the Lead ID)');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`"${email}" is not a valid email`);
  const defs = (await tx.leadField.findMany({ where: { workspaceId, isArchived: false } })) as unknown as FieldDef[];
  const { values: custom, errors: fieldErrors } = validateCustomFields(defs, input.customFields ?? {}, { partial: true });
  errors.push(...Object.values(fieldErrors));
  if (errors.length) return { outcome: 'rejected', leadId: null, customerId: null, errors };

  const source = await ensureSource(tx, tenantId, workspaceId, input.source);
  const remark = input.remark ? String(input.remark).slice(0, 4000) : null;
  const match = await findCustomer(tx, { mobile, email, preferEmail: byEmail });

  if (match && mode !== 'new_lead') {
    const leads = await tx.lead.findMany({ where: { customerId: match.customer.id, workspaceId }, orderBy: { createdAt: 'desc' } });
    const stages = await tx.leadStage.findMany({ where: { id: { in: leads.map((l) => l.stageId) } } });
    const open = leads.find((l) => { const st = stages.find((x) => x.id === l.stageId); return st && !st.isWon && !st.isLost; });
    if (open) {
      if (mode === 'skip') return { outcome: 'skip', leadId: open.id, customerId: match.customer.id, errors: [] };
      const current = (open.customFields ?? {}) as Record<string, unknown>;
      const changes: Record<string, unknown> = {};
      if (mode === 'update_blank' || mode === 'overwrite') {
        const merged = { ...current };
        for (const [k, v] of Object.entries(custom)) if (mode === 'overwrite' || blank(current[k])) { merged[k] = v; changes[k] = v; }
        await tx.lead.update({ where: { id: open.id }, data: { customFields: merged as object } });
        const c = match.customer;
        const cust: Record<string, string> = {};
        if (input.city && (mode === 'overwrite' || !c.city)) cust.city = String(input.city).slice(0, 80);
        if (email && !c.email) cust.email = email;
        if (mode === 'overwrite' && name && name !== c.name) cust.name = name;
        if (Object.keys(cust).length) await tx.customer.update({ where: { id: c.id }, data: cust });
      }
      await tx.lead.update({ where: { id: open.id }, data: { lastActivityAt: new Date() } });
      await tx.leadActivity.create({ data: activity(open, null, { type: 'remark', remark: `Repeat enquiry via ${via}${remark ? `: ${remark}` : ''}`, data: { source, via, changed: Object.keys(changes) } }) });
      if (open.ownerId) await notify(tx, [open.ownerId], { type: 'lead', title: `Repeat enquiry from ${match.customer.name} (${via})`, link: `/app/leads/${open.id}` });
      await emitEvent(tx, tenantId, workspaceId, 'lead.updated', { leadId: open.id, customerId: match.customer.id, via, source, remark });
      return { outcome: mode, leadId: open.id, customerId: match.customer.id, errors: [] };
    }
  }

  // New lead (new or returning customer).
  let customer = match?.customer ?? null;
  if (!customer) {
    customer = await tx.customer.create({ data: { tenantId, name, mobile, email, city: input.city ? String(input.city).slice(0, 80) : null, code: await nextCustomerCode(tx) } });
  } else if (mobile && mobile !== customer.mobile && !customer.alternateMobiles.includes(mobile)) {
    customer = await tx.customer.update({ where: { id: customer.id }, data: customer.mobile ? { alternateMobiles: { push: mobile } } : { mobile } });
  }
  const pipeline = await tx.pipeline.findFirst({ where: { workspaceId }, orderBy: { position: 'asc' }, include: { stages: { orderBy: { position: 'asc' }, take: 1 } } });
  if (!pipeline?.stages[0]) return { outcome: 'rejected', leadId: null, customerId: customer.id, errors: ['This business line has no pipeline'] };
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const eligible = (await eligibleOwners(tx, workspaceId)).map((u) => u.id);
  const assigner = makeAssigner(ws.assignmentMode === 'creator' ? { ...ws, assignmentMode: 'round_robin' } : ws, eligible, eligible[0] ?? '', await assignmentAvailability(tx));
  const ownerId = eligible.length ? assigner.pick(customer.primaryRmId) || null : null;
  await tx.workspace.update({ where: { id: workspaceId }, data: { assignmentCursor: assigner.state.cursor } });
  const lead = await tx.lead.create({
    data: {
      tenantId, workspaceId, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, customerId: customer.id, source, ownerId, assignedAt: ownerId ? new Date() : null,
      customFields: custom as object, status: await defaultStatus(tx, workspaceId), lastActivityAt: remark ? new Date() : null,
    },
  });
  await tx.leadActivity.create({ data: activity(lead, null, { type: 'remark', remark: `Enquiry via ${via}${remark ? `: ${remark}` : ''}`, data: { source, via } }) });
  if (ownerId) {
    await tx.leadActivity.create({ data: activity(lead, null, { type: 'assignment', data: { from: null, to: ownerId, auto: true } }) });
    await tx.customer.updateMany({ where: { id: customer.id, primaryRmId: null }, data: { primaryRmId: ownerId } });
    await notify(tx, [ownerId], { type: 'lead', title: `New lead: ${customer.name} (${via})`, link: `/app/leads/${lead.id}` });
  }
  await emitEvent(tx, tenantId, workspaceId, 'lead.created', {
    leadId: lead.id, customerId: customer.id, customerCode: customer.code, name: customer.name, mobile: customer.mobile, email: customer.email,
    source, via, ownerId, stageId: lead.stageId, customFields: custom,
  });
  return { outcome: match ? 'linked' : 'created', leadId: lead.id, customerId: customer.id, errors: [] };
}

/** Unknown sources are added to the business line's source list (so reports and filters show them). */
async function ensureSource(tx: Tx, tenantId: string, workspaceId: string, raw: string) {
  const value = (raw || 'website').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'website';
  const found = await tx.workspaceOption.findFirst({ where: { workspaceId, kind: 'lead_source', value } });
  if (!found) {
    const position = await tx.workspaceOption.count({ where: { workspaceId, kind: 'lead_source' } });
    await tx.workspaceOption.create({ data: { tenantId, workspaceId, kind: 'lead_source', value, label: value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), position } });
  }
  return value;
}

/** Maps an incoming record through an integration's saved field mapping (dotted paths allowed). */
export function applyMapping(record: Record<string, unknown>, map: Record<string, string>, defaultSource: string): IntakeInput {
  const get = (path: string) => (path in record ? record[path] : path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), record));
  const out: IntakeInput = { source: defaultSource, customFields: {} };
  const remarks: string[] = [];
  for (const [src, target] of Object.entries(map)) {
    const raw = get(src);
    if (raw === undefined || raw === null || raw === '' || target === 'ignore') continue;
    const v = Array.isArray(raw) ? raw.join(', ') : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (target === 'remark') remarks.push(v);
    else if (target === 'name') out.name = out.name ? `${out.name} ${v}` : v;
    else if (target.startsWith('cf:')) out.customFields![target.slice(3)] = v;
    else if (target === 'mobile' || target === 'email' || target === 'city') out[target] = v;
  }
  if (remarks.length) out.remark = remarks.join('\n');
  return out;
}
