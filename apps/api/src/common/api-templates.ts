import { HttpException } from '@nestjs/common';
import { fillTemplate } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { decrypt } from '../auth/crypto';
import { assertPublicUrl } from '../modules/integration-runtime';
import { ctx } from './context';

/** Values for {placeholders}: the lead (when there is one), its owner, its custom fields and the organization. */
export async function placeholderValues(tx: Tx, leadId: string | null): Promise<Record<string, string>> {
  const v: Record<string, string> = { 'org.name': ctx().tenant?.name ?? '' };
  if (!leadId) return v;
  const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { customer: true } });
  if (!lead) return v;
  const [stage, owner] = await Promise.all([tx.leadStage.findUnique({ where: { id: lead.stageId }, select: { name: true } }), lead.ownerId ? tx.user.findUnique({ where: { id: lead.ownerId }, select: { name: true, email: true } }) : null]);
  Object.assign(v, {
    'lead.id': lead.id, 'lead.name': lead.customer.name, 'lead.mobile': lead.customer.mobile ?? '', 'lead.email': lead.customer.email ?? '', 'lead.city': lead.customer.city ?? '',
    'lead.source': lead.source, 'lead.stage': stage?.name ?? '', 'lead.status': lead.status ?? '', 'lead.owner': owner?.name ?? '', 'lead.ownerEmail': owner?.email ?? '',
  });
  for (const [k, val] of Object.entries((lead.customFields ?? {}) as Record<string, unknown>)) v[`lead.cf.${k}`] = val === null || val === undefined ? '' : String(val);
  return v;
}

/**
 * Calls an API template for a lead: placeholders filled (URL-encoded in the URL, JSON-escaped in a JSON body), private
 * addresses refused, 10-second timeout. Throws with the reason when the call fails or the answer is not 2xx.
 */
export async function callApiTemplate(tx: Tx, templateId: string, leadId: string | null) {
  const t = await tx.apiTemplate.findFirst({ where: { id: templateId, isArchived: false } });
  if (!t) throw new HttpException({ code: 'API_TEMPLATE_NOT_FOUND', message: 'API template not found' }, 400);
  const values = await placeholderValues(tx, leadId);
  const url = fillTemplate(t.url, values, 'url');
  await assertPublicUrl(url);
  const headers: Record<string, string> = t.headersEnc ? JSON.parse(decrypt(t.headersEnc)) : {};
  const json = Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'content-type' && /json/i.test(v)) || /^\s*[{[]/.test(t.body ?? '');
  const body = t.method === 'GET' || !t.body ? undefined : fillTemplate(t.body, values, json ? 'json' : 'text');
  if (body && json && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  const started = Date.now();
  let status = 0, text = '';
  try {
    const res = await fetch(url, { method: t.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    status = res.status;
    text = (await res.text()).slice(0, 500);
  } catch (e) {
    await tx.apiTemplate.update({ where: { id: t.id }, data: { lastStatus: 0, lastCalledAt: new Date() } });
    throw new HttpException({ code: 'API_UNREACHABLE', message: `Could not reach ${new URL(url).host}: ${e instanceof Error ? e.message : e}` }, 502);
  }
  await tx.apiTemplate.update({ where: { id: t.id }, data: { lastStatus: status, lastCalledAt: new Date() } });
  return { status, ok: status >= 200 && status < 300, ms: Date.now() - started, body: text, url: url.replace(/\?.*$/, '?…'), name: t.name };
}
