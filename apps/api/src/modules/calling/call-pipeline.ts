import { normalizeMobile } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { activity, syncNextFollowUp } from '../../common/lead-ops';
import { intakeLead } from '../../common/lead-intake';
import { emitEvent } from '../../common/events';
import type { LiveEvent } from '../../common/live';

/** One call as sent by the phone app, a cloud provider, or logged by hand. */
export interface CallInput {
  externalId: string; direction: 'outbound' | 'inbound'; phone: string; startedAt: Date; ringSec?: number; talkSec?: number; answered: boolean;
  leadId?: string | null; disposition?: string | null; remark?: string | null; followUpAt?: Date | null; clientUpdatedAt?: Date | null;
}
export interface CallContext { tenantId: string; userId: string | null; channel: 'sim' | 'cloud' | 'manual'; provider?: string | null; deviceId?: string | null; unknownWorkspaceId?: string | null }
export type IngestStatus = 'created' | 'duplicate' | 'updated' | 'unmatched';
export interface IngestResult { externalId: string; status: IngestStatus; callId: string; leadId: string | null; live: LiveEvent[] }

const toE164 = (p: string) => normalizeMobile(p) ?? p.replace(/[^\d+]/g, '').slice(0, 20);

/** Is this lead the user's to log calls on: owner, lead-team member, or covering for the owner right now. */
async function leadIsMine(tx: Tx, leadId: string, userId: string | null) {
  const lead = await tx.lead.findUnique({ where: { id: leadId } });
  if (!lead) return null;
  if (!userId || lead.ownerId === userId) return lead;
  if (await tx.leadTeamMember.findFirst({ where: { leadId, userId, removedAt: null } })) return lead;
  const now = new Date();
  if (lead.ownerId && await tx.userCover.findFirst({ where: { userId: lead.ownerId, coverUserId: userId, cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now } } })) return lead;
  return null;
}

/** The lead a number belongs to: the customer's open lead (mine first), else their latest lead. */
async function leadForNumber(tx: Tx, phone: string, userId: string | null) {
  const customers = await tx.customer.findMany({ where: { mergedIntoId: null, OR: [{ mobile: phone }, { alternateMobiles: { has: phone } }] }, select: { id: true } });
  if (!customers.length) return null;
  const leads = await tx.lead.findMany({ where: { customerId: { in: customers.map((c) => c.id) } }, orderBy: { updatedAt: 'desc' } });
  const stages = new Map((await tx.leadStage.findMany({ where: { id: { in: leads.map((l) => l.stageId) } } })).map((s) => [s.id, s]));
  const open = leads.filter((l) => { const s = stages.get(l.stageId); return s && !s.isWon && !s.isLost; });
  return open.find((l) => l.ownerId === userId) ?? open[0] ?? leads.find((l) => l.ownerId === userId) ?? leads[0] ?? null;
}

/** A valid outcome for this business line: the one given, else the default for connected / not connected calls. */
async function outcome(tx: Tx, workspaceId: string, given: string | null | undefined, answered: boolean) {
  const opts = await tx.workspaceOption.findMany({ where: { workspaceId, kind: 'call_disposition', isArchived: false } });
  const hit = given ? opts.find((o) => o.value === given) : null;
  if (hit) return { value: hit.value, connected: hit.connected };
  const fallback = answered ? opts.find((o) => o.isDefault && o.connected) ?? opts.find((o) => o.connected) : opts.find((o) => o.value === 'not_answered') ?? opts.find((o) => !o.connected);
  return { value: fallback?.value ?? null, connected: answered };
}

/**
 * Stores a call once per organization (same externalId → duplicate, or updated if the phone sent a newer edit),
 * puts it on the lead's journey at the time it happened, and updates the lead (last call, first response,
 * follow-ups). Numbers not in UBOS become a lead in the chosen business line when inbound, otherwise the call
 * waits as "unmatched" until someone links it.
 */
export async function ingestCall(tx: Tx, c: CallContext, input: CallInput): Promise<IngestResult> {
  const existing = await tx.call.findUnique({ where: { tenantId_externalId: { tenantId: c.tenantId, externalId: input.externalId } } });
  if (existing) {
    const newer = input.clientUpdatedAt && (!existing.clientUpdatedAt || input.clientUpdatedAt > existing.clientUpdatedAt);
    const changed = (input.disposition ?? null) !== existing.disposition || (input.remark ?? null) !== existing.remark;
    if (!newer || !changed) return { externalId: input.externalId, status: 'duplicate', callId: existing.id, leadId: existing.leadId, live: [] };
    let disposition = input.disposition ?? existing.disposition;
    if (existing.workspaceId) disposition = (await outcome(tx, existing.workspaceId, input.disposition, existing.answered)).value;
    await tx.call.update({ where: { id: existing.id }, data: { disposition, remark: input.remark ?? existing.remark, clientUpdatedAt: input.clientUpdatedAt } });
    if (existing.activityId) await tx.leadActivity.update({ where: { id: existing.activityId }, data: { disposition, remark: input.remark ?? existing.remark } });
    if (existing.leadId && disposition) await tx.lead.update({ where: { id: existing.leadId }, data: { lastDisposition: disposition } });
    return { externalId: input.externalId, status: 'updated', callId: existing.id, leadId: existing.leadId, live: [{ type: 'call.updated', leadId: existing.leadId, userId: existing.userId, callId: existing.id }] };
  }

  const phone = toE164(input.phone);
  let lead = input.leadId ? await leadIsMine(tx, input.leadId, c.userId) : null;
  if (!lead) lead = await leadForNumber(tx, phone, c.userId);
  const live: LiveEvent[] = [];
  if (!lead && input.direction === 'inbound' && c.unknownWorkspaceId && normalizeMobile(phone)) {
    const r = await intakeLead(tx, c.tenantId, c.unknownWorkspaceId, { name: `Caller ${phone}`, mobile: phone, source: 'phone_call', remark: 'First call from this number' }, 'add_remark', c.channel === 'sim' ? 'phone call' : 'cloud call');
    if (r.leadId) { lead = await tx.lead.findUnique({ where: { id: r.leadId } }); live.push({ type: 'lead.created', leadId: r.leadId, userId: lead?.ownerId ?? null }); }
  }
  const userId = c.userId ?? lead?.ownerId ?? null;
  const call = await tx.call.create({
    data: {
      tenantId: c.tenantId, externalId: input.externalId, channel: c.channel, provider: c.provider ?? null, direction: input.direction, phone, userId, deviceId: c.deviceId ?? null,
      workspaceId: lead?.workspaceId ?? null, leadId: lead?.id ?? null, customerId: lead?.customerId ?? null, startedAt: input.startedAt,
      ringSec: Math.max(0, Math.round(input.ringSec ?? 0)), talkSec: Math.max(0, Math.round(input.talkSec ?? 0)), answered: input.answered,
      disposition: input.disposition ?? null, remark: input.remark ?? null, clientUpdatedAt: input.clientUpdatedAt ?? null,
    },
  });
  if (!lead) return { externalId: input.externalId, status: 'unmatched', callId: call.id, leadId: null, live: [{ type: 'call.logged', leadId: null, userId, callId: call.id }] };
  await attachToLead(tx, call.id, lead, userId, input);
  live.push({ type: 'call.logged', leadId: lead.id, userId, callId: call.id });
  return { externalId: input.externalId, status: 'created', callId: call.id, leadId: lead.id, live };
}

type LeadRow = { id: string; tenantId: string; workspaceId: string; customerId: string; firstResponseAt: Date | null; lastActivityAt: Date | null; ownerId: string | null };

/** Puts a stored call on a lead's journey (also used when an unmatched call is linked later). */
export async function attachToLead(tx: Tx, callId: string, lead: LeadRow, userId: string | null, input?: Pick<CallInput, 'disposition' | 'remark' | 'followUpAt'>) {
  const call = await tx.call.findUniqueOrThrow({ where: { id: callId } });
  const o = await outcome(tx, lead.workspaceId, input?.disposition ?? call.disposition, call.answered);
  const act = await tx.leadActivity.create({
    data: {
      ...activity(lead, userId, {
        type: 'call', disposition: o.value, connected: o.connected, durationSec: call.talkSec, remark: input?.remark ?? call.remark,
        data: { callId: call.id, channel: call.channel, direction: call.direction, ringSec: call.ringSec, provider: call.provider },
      }),
      createdAt: call.startedAt, // late-synced calls still count on the day they happened
    },
  });
  await tx.call.update({ where: { id: call.id }, data: { leadId: lead.id, workspaceId: lead.workspaceId, customerId: lead.customerId, activityId: act.id, disposition: o.value, userId: call.userId ?? userId } });
  const latest = !lead.lastActivityAt || call.startedAt > lead.lastActivityAt;
  await tx.lead.update({
    where: { id: lead.id },
    data: {
      ...(latest ? { lastActivityAt: call.startedAt, lastDisposition: o.value } : {}),
      ...(!lead.firstResponseAt && call.direction === 'outbound' ? { firstResponseAt: call.startedAt } : {}),
    },
  });
  if (o.connected || call.direction === 'outbound') {
    await tx.followUp.updateMany({ where: { leadId: lead.id, doneAt: null, dueAt: { lte: new Date(call.startedAt.getTime() + 3_600_000) } }, data: { doneAt: call.startedAt, outcome: o.value } });
  }
  const fuUser = userId ?? lead.ownerId;
  if (input?.followUpAt && fuUser) {
    await tx.followUp.create({ data: { tenantId: lead.tenantId, leadId: lead.id, dueAt: input.followUpAt, userId: fuUser, createdById: userId, note: 'Planned after a call' } });
  }
  await syncNextFollowUp(tx, lead.id);
  await emitEvent(tx, lead.tenantId, lead.workspaceId, 'call.logged', {
    callId: call.id, leadId: lead.id, customerId: lead.customerId, userId: call.userId ?? userId, channel: call.channel, direction: call.direction,
    startedAt: call.startedAt, talkSec: call.talkSec, answered: call.answered, disposition: o.value,
  });
  return act.id;
}

const pick = (r: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const hit = Object.keys(r).find((x) => x.toLowerCase() === k.toLowerCase());
    if (hit && r[hit] !== undefined && r[hit] !== null && r[hit] !== '') return String(r[hit]);
  }
  return null;
};
const seconds = (v: string | null) => {
  if (!v) return 0;
  if (/^\d+:\d{2}(:\d{2})?$/.test(v)) return v.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/**
 * A cloud-telephony webhook (CallerDesk and similar) as a call. Field names differ per provider and account, so the
 * usual names are accepted; verify against a real account when connecting one.
 */
export function normalizeCloudCall(provider: string, r: Record<string, unknown>) {
  const id = pick(r, ['call_id', 'callid', 'CallSid', 'unique_id', 'uniqueid', 'call_uuid', 'id']);
  const customer = pick(r, ['customer_number', 'caller_number', 'SourceNumber', 'From', 'caller', 'customer', 'calling_party_b', 'mobile']);
  const agent = pick(r, ['agent_number', 'DestinationNumber', 'To', 'agent_phone', 'receiver', 'calling_party_a', 'member_number']);
  const dir = (pick(r, ['direction', 'call_type', 'Direction', 'type']) ?? '').toLowerCase();
  const start = pick(r, ['start_time', 'StartTime', 'call_start_time', 'CallStartTime', 'call_date', 'date', 'timestamp']);
  const talk = seconds(pick(r, ['talk_duration', 'CallDuration', 'billsec', 'duration', 'call_duration', 'talk_time']));
  const ring = seconds(pick(r, ['ring_duration', 'RingDuration', 'ring_time']));
  const status = (pick(r, ['call_status', 'Status', 'status', 'DialCallStatus']) ?? '').toLowerCase();
  const recording = pick(r, ['recording_url', 'RecordingUrl', 'recording', 'call_recording', 'recording_link']);
  const startedAt = start ? new Date(/^\d{10}$/.test(start) ? Number(start) * 1000 : start.replace(' ', 'T')) : new Date();
  const answered = talk > 0 && !/(miss|no.?answer|busy|fail|cancel)/.test(status);
  return {
    externalId: id ? `${provider}:${id}` : null, phone: customer, agent,
    direction: (/out/.test(dir) ? 'outbound' : 'inbound') as 'outbound' | 'inbound',
    startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt, talkSec: talk, ringSec: ring, answered, recordingUrl: recording,
  };
}
