// End-to-end checks for Phase 1.7: inbound webhooks with field mapping and duplicate rules (Website/API, IndiaMART),
// event log and replay, public API with scoped keys, outgoing signed webhooks with retries, hosted web forms, and
// Google Sheets sync. A small local server stands in for the other side (webhook receiver and the published sheet).
// Usage: npm run verify:integrations   (API running, freshly seeded; run `npm run db:seed` afterwards)

import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const PORT = Number(process.env.VERIFY_HOOK_PORT ?? 4599);
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers = {}, raw = false } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(path.startsWith('http') ? path : API + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') =>
  (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 12_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); } return null; };

// ── The other side: receives outgoing webhooks, serves a sheet as CSV ──
const received = [];
let sheet = 'Name,Mobile,Email,City,Notes\nAsha Kapoor,9810066001,asha@example.com,Pune,Wants the advanced course\nBharat Rao,9810066002,,Delhi,Call after 6 pm\n';
const server = createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    if (req.url === '/sheet.csv') { res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end(sheet); }
    received.push({ url: req.url, headers: req.headers, body: data });
    if (req.url === '/fail') { res.writeHead(500); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
});
await new Promise((r) => server.listen(PORT, r));
const LOCAL = `http://localhost:${PORT}`;

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const COURSE = ws['Course / Software'];
const A = { token: admin };

try {
  // ── Inbound webhook: Website / API ──
  const setup1 = await call('/api/v1/integrations/website_api/setup', { ...A, method: 'PUT', body: { values: { businessLine: VASTU, defaultSource: 'website' }, activate: true } });
  const s1 = (await call('/api/v1/integrations/website_api/setup', A)).body;
  check('Website/API: saving the setup gives a private webhook URL', setup1.status === 200 && /\/hooks\/mycompany\/website_api\/[A-Za-z0-9]{16,}$/.test(s1.webhookUrl ?? ''), s1.webhookUrl);
  const hookUrl = s1.webhookUrl;
  const noMap = await call(hookUrl, { tenant: null, method: 'POST', body: { name: 'Early Bird', mobile: '9810055000' } });
  check('before the field mapping is saved, records are refused (and kept in the log)', noMap.status === 200 && noMap.body.results[0].outcome === 'rejected' && /mapping/.test(noMap.body.results[0].errors[0]), noMap.body);
  const map1 = await call('/api/v1/integrations/website_api/mapping', { ...A, method: 'PUT', body: {
    sourceFields: ['name', 'mobile', 'phone', 'email', 'city', 'message', 'property'],
    map: { name: 'name', mobile: 'mobile', phone: 'ignore', email: 'email', city: 'city', message: 'remark', property: 'cf:property_type' }, duplicateMode: 'add_remark',
  } });
  check('field mapping saved', map1.status === 200, map1.body);
  const in1 = await call(hookUrl, { tenant: null, method: 'POST', body: { name: 'Nisha Arora', mobile: '+91 98100 55001', email: 'nisha@example.com', city: 'Jaipur', message: 'Need a vastu audit for my new home', property: 'Home' } });
  const lead1 = in1.body.results?.[0]?.leadId;
  const l1 = lead1 ? (await call(`/api/v1/leads/${lead1}`, { ...A, workspace: VASTU })).body : null;
  check('a webhook post becomes a lead in the chosen business line (mapped fields, owner by assignment rules)', in1.status === 200 && in1.body.results[0].outcome === 'created' && l1?.workspace?.id === VASTU && l1.customFields.property_type === 'Home' && l1.source === 'website' && !!l1.owner, [in1.body, l1 && { ws: l1.workspace, cf: l1.customFields, src: l1.source, owner: l1.owner }]);
  check('the enquiry text is on the lead’s journey', l1?.activities?.some((a) => a.type === 'remark' && /Need a vastu audit/.test(a.remark ?? '')), l1?.activities);
  const wrong = await call(hookUrl.replace(/[A-Za-z0-9]+$/, 'wrongtoken12345678901234'), { tenant: null, method: 'POST', body: { name: 'X', mobile: '9810055099' } });
  const otherOrg = await call(hookUrl.replace('/mycompany/', '/abc/'), { tenant: null, method: 'POST', body: { name: 'X', mobile: '9810055099' } });
  check('a wrong token or another organization’s address is simply “not found”', wrong.status === 404 && otherOrg.status === 404, [wrong.status, otherOrg.status]);
  const again = await call(hookUrl, { tenant: null, method: 'POST', body: { name: 'Nisha A', mobile: '9810055001', message: 'Following up — when can you visit?' } });
  const l1b = (await call(`/api/v1/leads/${lead1}`, { ...A, workspace: VASTU })).body;
  check('a repeat enquiry with an open lead follows the duplicate rule (remark on the same lead)', again.body.results[0].outcome === 'add_remark' && again.body.results[0].leadId === lead1 && l1b.activities.some((a) => /Repeat enquiry .*when can you visit/.test(a.remark ?? '')), again.body);
  const idem1 = await call(hookUrl, { tenant: null, method: 'POST', body: { id: 'ENQ-77', name: 'Om Prakash', mobile: '9810055002', property: 'Office' } });
  const idem2 = await call(hookUrl, { tenant: null, method: 'POST', body: { id: 'ENQ-77', name: 'Om Prakash', mobile: '9810055002', property: 'Office' } });
  check('the same record sent twice (same id) is not processed twice', idem1.body.results[0].outcome === 'created' && idem2.body.results[0].duplicate === true && idem2.body.results[0].leadId === idem1.body.results[0].leadId, [idem1.body, idem2.body]);
  const batch = await call(hookUrl, { tenant: null, method: 'POST', body: [{ name: 'Ravi K', mobile: '9810055003' }, { name: 'Bad Number', mobile: '12' }, { name: 'Wrong Option', mobile: '9810055004', property: 'Castle' }] });
  check('batches: each record gets its own result; invalid ones are rejected with the reason', batch.status === 200 && batch.body.ok === false && batch.body.results[0].outcome === 'created' && /valid mobile/.test(batch.body.results[1].errors[0]) && batch.body.results[2].outcome === 'rejected', batch.body);
  const viaPhone = await call(hookUrl, { tenant: null, method: 'POST', body: { name: 'Phone Field', phone: '9810055005' } });
  check('a record without the mapped Lead ID is rejected and logged', viaPhone.body.results[0].outcome === 'rejected', viaPhone.body);
  await call('/api/v1/integrations/website_api/mapping', { ...A, method: 'PUT', body: {
    sourceFields: ['name', 'mobile', 'phone', 'email', 'city', 'message', 'property'],
    map: { name: 'name', mobile: 'ignore', phone: 'mobile', email: 'email', city: 'city', message: 'remark', property: 'cf:property_type' }, duplicateMode: 'add_remark',
  } });
  const log = (await call('/api/v1/integrations/website_api/events', A)).body;
  const failedEvt = log.items.find((e) => e.status === 'failed' && /Phone Field/.test(e.body));
  const replay = failedEvt ? await call(`/api/v1/integrations/website_api/events/${failedEvt.id}/replay`, { ...A, method: 'POST' }) : { status: 0 };
  const log2 = (await call('/api/v1/integrations/website_api/events', A)).body;
  check('event log shows every record; a failed one can be replayed after fixing the mapping', log.items.length >= 7 && !!failedEvt && replay.status === 201 && replay.body.outcome === 'created' && log2.items.find((e) => e.id === failedEvt.id)?.status === 'processed', [log.last7Days, replay.body]);
  const replayAgain = failedEvt ? await call(`/api/v1/integrations/website_api/events/${failedEvt.id}/replay`, { ...A, method: 'POST' }) : { status: 0 };
  check('a processed record cannot be replayed again', replayAgain.status === 400, replayAgain.body);
  await call('/api/v1/integrations/website_api/deactivate', { ...A, method: 'POST' });
  const off = await call(hookUrl, { tenant: null, method: 'POST', body: { name: 'Off', phone: '9810055006' } });
  await call('/api/v1/integrations/website_api/activate', { ...A, method: 'POST' });
  check('a switched-off integration refuses posts', off.status === 403, off.body);
  const rmLog = await call('/api/v1/integrations/website_api/events/x/replay', { token: rm, workspace: VASTU, method: 'POST' });
  check('only organization admins replay events', rmLog.status === 403, rmLog.status);

  // ── IndiaMART push ──
  await call('/api/v1/integrations/indiamart/setup', { ...A, method: 'PUT', body: { values: { businessLine: COURSE }, activate: true } });
  await call('/api/v1/integrations/indiamart/mapping', { ...A, method: 'PUT', body: {
    sourceFields: ['SENDER_NAME', 'SENDER_MOBILE', 'SENDER_EMAIL', 'SENDER_CITY', 'QUERY_PRODUCT_NAME', 'QUERY_MESSAGE'],
    map: { SENDER_NAME: 'name', SENDER_MOBILE: 'mobile', SENDER_EMAIL: 'email', SENDER_CITY: 'city', QUERY_PRODUCT_NAME: 'remark', QUERY_MESSAGE: 'remark' }, duplicateMode: 'add_remark',
  } });
  const imUrl = (await call('/api/v1/integrations/indiamart/setup', A)).body.webhookUrl;
  const imBody = { CODE: 200, STATUS: 'SUCCESS', RESPONSE: { UNIQUE_QUERY_ID: '2561234567', SENDER_NAME: 'Kiran Traders', SENDER_MOBILE: '+91-9810044001', SENDER_CITY: 'Surat', QUERY_PRODUCT_NAME: 'Numerology software', QUERY_MESSAGE: 'Price for 5 users?' } };
  const im1 = await call(imUrl, { tenant: null, method: 'POST', body: imBody });
  const im2 = await call(imUrl, { tenant: null, method: 'POST', body: imBody });
  const imLead = im1.body.results?.[0]?.leadId ? (await call(`/api/v1/leads/${im1.body.results[0].leadId}`, { ...A, workspace: COURSE })).body : null;
  check('IndiaMART push (wrapped in RESPONSE) becomes a lead; the same enquiry id is never added twice', im1.body.results[0].outcome === 'created' && imLead?.workspace.id === COURSE && imLead.source === 'indiamart' && im2.body.results[0].duplicate === true, [im1.body, im2.body]);
  const catalogue = (await call('/api/v1/integrations', A)).body;
  check('catalogue marks the lead sources that work now as Live', ['website_api', 'google_sheets', 'indiamart', 'zapier'].every((k) => catalogue.find((c) => c.key === k)?.phase === 'Live') && catalogue.find((c) => c.key === 'whatsapp').phase !== 'Live', catalogue.filter((c) => c.phase === 'Live').map((c) => c.key));

  // ── API keys & public API ──
  const rmKey = await call('/api/v1/api-keys', { token: rm, workspace: VASTU, method: 'POST', body: { name: 'Mine', scopes: ['leads:read'] } });
  check('only organization admins manage API keys', rmKey.status === 403, rmKey.status);
  const full = await call('/api/v1/api-keys', { ...A, method: 'POST', body: { name: 'Website backend', scopes: ['leads:read', 'leads:write', 'customers:read', 'meta:read'] } });
  const vastuOnly = await call('/api/v1/api-keys', { ...A, method: 'POST', body: { name: 'Vastu reports', scopes: ['leads:read'], workspaceId: VASTU } });
  const keyList = (await call('/api/v1/api-keys', A)).body;
  check('an API key is shown once; lists only show its prefix', full.status === 201 && /^ubos_[A-Za-z0-9]{30,}$/.test(full.body.key) && keyList.keys.every((k) => !('key' in k) && !('keyHash' in k)) && keyList.keys.some((k) => k.prefix === full.body.key.slice(0, 12)), [full.body, keyList.keys]);
  const K = (k) => ({ tenant: null, headers: { Authorization: `Bearer ${k}` } });
  const noKey = await call('/public/v1/me', { tenant: null });
  const badKey = await call('/public/v1/me', K('ubos_notarealkeynotarealkeynotareal'));
  const meKey = await call('/public/v1/me', K(full.body.key));
  check('the public API needs a valid key and knows its organization', noKey.status === 401 && badKey.status === 401 && meKey.status === 200 && meKey.body.organization === 'My Company', [noKey.status, badKey.status, meKey.body]);
  const meta = await call('/public/v1/workspaces', K(full.body.key));
  check('integrators can read business lines, stages, sources and fields', meta.status === 200 && meta.body.some((w) => w.id === COURSE && w.fields.some((f) => f.key === 'course') && w.stages.length > 0), meta.body?.map?.((w) => w.name));
  const noWs = await call('/public/v1/leads', { ...K(full.body.key), method: 'POST', body: { name: 'No WS', mobile: '9810033000' } });
  const p1 = await call('/public/v1/leads', { ...K(full.body.key), method: 'POST', headers: { Authorization: `Bearer ${full.body.key}`, 'Idempotency-Key': 'order-1001' }, body: { workspaceId: COURSE, name: 'Meera Pillai', mobile: '9810033001', email: 'meera@example.com', source: 'partner_portal', remark: 'From partner site', customFields: { course: 'Numerology Basic' } } });
  const p2 = await call('/public/v1/leads', { ...K(full.body.key), method: 'POST', headers: { Authorization: `Bearer ${full.body.key}`, 'Idempotency-Key': 'order-1001' }, body: { workspaceId: COURSE, name: 'Meera Pillai', mobile: '9810033001' } });
  check('API creates leads (business line required); an Idempotency-Key repeat returns the same lead', noWs.status === 400 && p1.status === 201 && p1.body.outcome === 'created' && p2.status === 201 && p2.body.duplicate && p2.body.leadId === p1.body.leadId, [noWs.body, p1.body, p2.body]);
  const badCf = await call('/public/v1/leads', { ...K(full.body.key), method: 'POST', body: { workspaceId: COURSE, name: 'Bad', mobile: '9810033002', customFields: { course: 'Cooking' } } });
  check('invalid values are refused with the reason', badCf.status === 400 && /course|Course/.test(badCf.body.message), badCf.body);
  const meta2 = await call('/public/v1/workspaces', K(full.body.key));
  check('a new source name is added to the business line’s source list', meta2.body.find((w) => w.id === COURSE).sources.some((s) => s.value === 'partner_portal'), meta2.body.find((w) => w.id === COURSE).sources);
  const vWrite = await call('/public/v1/leads', { ...K(vastuOnly.body.key), method: 'POST', body: { name: 'X', mobile: '9810033003' } });
  const vList = await call('/public/v1/leads?limit=200', K(vastuOnly.body.key));
  const vOther = await call(`/public/v1/leads/${p1.body.leadId}`, K(vastuOnly.body.key));
  check('a key limited to one business line and to reading cannot write or see other lines', vWrite.status === 403 && vWrite.body.code === 'SCOPE_MISSING' && vList.status === 200 && vList.body.items.length > 0 && vList.body.items.every((l) => l.workspaceId === VASTU) && vOther.status === 404, [vWrite.body, vList.body.items?.length, vOther.status]);
  const pRead = await call(`/public/v1/leads/${p1.body.leadId}`, K(full.body.key));
  check('lead detail via API: customer, stage, owner and journey', pRead.status === 200 && pRead.body.customer.name === 'Meera Pillai' && pRead.body.stage.name && pRead.body.activities.some((a) => /From partner site/.test(a.remark ?? '')), pRead.body);
  const since = (await call('/public/v1/leads?limit=1', K(full.body.key))).body;
  check('lists page by updatedSince', Array.isArray(since.items) && since.items.length === 1 && !!since.nextUpdatedSince, since);
  const cust = await call('/public/v1/customers?mobile=9810033001', K(full.body.key));
  check('customer lookup by mobile', cust.status === 200 && cust.body[0]?.name === 'Meera Pillai', cust.body);

  // ── Outgoing webhooks ──
  const mgrHooks = await call('/api/v1/webhooks', { token: manager, workspace: VASTU });
  check('only organization admins manage outgoing webhooks', mgrHooks.status === 403, mgrHooks.status);
  const sub = await call('/api/v1/webhooks', { ...A, method: 'POST', body: { name: 'Our ERP', url: `${LOCAL}/hook`, events: ['lead.created', 'lead.won', 'lead.stage_changed', 'payment.received'] } });
  check('a webhook is created; its signing secret is shown once', sub.status === 201 && /^whsec_/.test(sub.body.secret) && !(await call('/api/v1/webhooks', A)).body.webhooks.some((w) => 'secret' in w || 'secretEncrypted' in w), sub.body);
  const verify = (r) => {
    const m = String(r.headers['x-ubos-signature'] ?? '').match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    return !!m && createHmac('sha256', sub.body.secret).update(`${m[1]}.${r.body}`).digest('hex') === m[2];
  };
  const ping = await call(`/api/v1/webhooks/${sub.body.id}/test`, { ...A, method: 'POST' });
  const gotPing = received.find((r) => r.url === '/hook' && r.headers['x-ubos-event'] === 'ping');
  check('“Send test” delivers a signed ping at once', ping.status === 201 && ping.body.status === 'delivered' && ping.body.responseStatus === 200 && !!gotPing && verify(gotPing), [ping.body, gotPing?.headers]);
  const p3 = await call('/public/v1/leads', { ...K(full.body.key), method: 'POST', body: { workspaceId: COURSE, name: 'Tara Singh', mobile: '9810033005', customFields: { course: 'Software Licence' } } });
  const created = await until(() => received.find((r) => r.headers['x-ubos-event'] === 'lead.created' && JSON.parse(r.body).data.leadId === p3.body.leadId));
  check('lead.created reaches the subscriber within seconds, signed, with the lead data', !!created && verify(created) && JSON.parse(created.body).data.name === 'Tara Singh' && JSON.parse(created.body).data.via === 'API', created?.body);
  const stages = meta.body.find((w) => w.id === COURSE).stages;
  const won = stages.find((s) => s.isWon);
  const patch = await call(`/public/v1/leads/${p3.body.leadId}`, { ...K(full.body.key), method: 'PATCH', body: { stageId: won.id, status: 'hot', remark: 'Paid online' } });
  check('API updates stage, status and adds a remark', patch.status === 200 && patch.body.stage.isWon && patch.body.status === 'hot', patch.body);
  const wonEvt = await until(() => received.find((r) => r.headers['x-ubos-event'] === 'lead.won' && JSON.parse(r.body).data.leadId === p3.body.leadId));
  check('winning the lead sends lead.won (and lead.stage_changed)', !!wonEvt && !!received.find((r) => r.headers['x-ubos-event'] === 'lead.stage_changed' && JSON.parse(r.body).data.leadId === p3.body.leadId), received.map((r) => r.headers['x-ubos-event']));
  const badStatus = await call(`/public/v1/leads/${p3.body.leadId}`, { ...K(full.body.key), method: 'PATCH', body: { status: 'imaginary' } });
  check('unknown status values are refused', badStatus.status === 400, badStatus.body);
  const failing = await call('/api/v1/webhooks', { ...A, method: 'POST', body: { name: 'Broken', url: `${LOCAL}/fail`, events: ['lead.created'] } });
  await call('/public/v1/leads', { ...K(full.body.key), method: 'POST', body: { workspaceId: COURSE, name: 'Uday Jain', mobile: '9810033006' } });
  const failed = await until(async () => (await call(`/api/v1/webhooks/${failing.body.id}/deliveries`, A)).body.find((d) => d.event === 'lead.created' && d.attempts >= 1));
  check('a failing receiver gets retries later (pending, attempt 1, HTTP 500 noted)', failed?.status === 'pending' && failed.responseStatus === 500 && new Date(failed.nextAttemptAt) > new Date(), failed);
  const retry = failed ? await call(`/api/v1/webhook-deliveries/${failed.id}/retry`, { ...A, method: 'POST' }) : { body: {} };
  check('“Retry now” sends it again', retry.body.attempts === 2, retry.body);
  await call(`/api/v1/webhooks/${failing.body.id}`, { ...A, method: 'PATCH', body: { isActive: false } });
  const before = (await call(`/api/v1/webhooks/${failing.body.id}/deliveries`, A)).body.length;
  await call('/public/v1/leads', { ...K(full.body.key), method: 'POST', body: { workspaceId: COURSE, name: 'Vani Rao', mobile: '9810033007' } });
  await sleep(1500);
  const after = (await call(`/api/v1/webhooks/${failing.body.id}/deliveries`, A)).body.length;
  check('a paused webhook gets nothing new', after === before, [before, after]);

  // ── API key revoke & audit ──
  await call(`/api/v1/api-keys/${vastuOnly.body.id}/revoke`, { ...A, method: 'POST' });
  const revoked = await call('/public/v1/me', K(vastuOnly.body.key));
  check('a revoked key stops working at once', revoked.status === 401, revoked.status);
  const audit = (await call('/api/v1/audit-logs', A)).body;
  check('keys, webhooks and API changes are in the audit log (no secrets)', ['api_key.created', 'api_key.revoked', 'webhook.created', 'lead.updated_by_api'].every((a) => audit.some((l) => l.action === a)) && !JSON.stringify(audit).includes(full.body.key) && !JSON.stringify(audit).includes(sub.body.secret), audit.slice(0, 8).map((l) => l.action));

  // ── Web forms ──
  const rmForm = await call('/api/v1/forms', { token: rm, workspace: VASTU, method: 'POST', body: { name: 'X', title: 'X', fields: [{ target: 'name', label: 'Name', required: true }, { target: 'mobile', label: 'Mobile', required: true }] } });
  const noMobile = await call('/api/v1/forms', { token: manager, workspace: VASTU, method: 'POST', body: { name: 'Bad', title: 'Bad', fields: [{ target: 'name', label: 'Name', required: true }] } });
  const form = await call('/api/v1/forms', { token: manager, workspace: VASTU, method: 'POST', body: {
    name: 'Home audit enquiry', title: 'Book a Vastu audit', description: 'We call you back within a day.', source: 'website_form',
    fields: [{ target: 'name', label: 'Your name', required: true }, { target: 'mobile', label: 'Mobile', required: true }, { target: 'email', label: 'Email' }, { target: 'cf:property_type', label: 'Property', required: true }, { target: 'remark', label: 'Anything else?' }],
  } });
  check('business-line managers build forms (Name and a required Lead ID field); RMs cannot', rmForm.status === 403 && noMobile.status === 400 && form.status === 201 && form.body.slug === 'home-audit-enquiry' && /\/f\/mycompany\/home-audit-enquiry$/.test(form.body.hostedUrl) && /<iframe/.test(form.body.embedCode), [rmForm.status, noMobile.body, form.body]);
  const pub = await call('/public/forms/mycompany/home-audit-enquiry', { tenant: null });
  check('the hosted form shows its fields (dropdown options from the lead field)', pub.status === 200 && pub.body.fields.find((f) => f.name === 'cf:property_type')?.options.includes('Shop') && pub.body.fields.find((f) => f.name === 'mobile').type === 'phone', pub.body);
  const missing = await call('/public/forms/mycompany/home-audit-enquiry', { tenant: null, method: 'POST', body: { name: 'Sunil' } });
  const sub1 = await call('/public/forms/mycompany/home-audit-enquiry', { tenant: null, method: 'POST', body: { name: 'Sunil Mehta', mobile: '9810022001', 'cf:property_type': 'Shop', remark: 'Corner shop, east facing', utm_source: 'instagram' } });
  check('required answers are checked; a valid submission thanks the visitor', missing.status === 400 && sub1.status === 200 && /Thank you/.test(sub1.body.message), [missing.body, sub1.body]);
  const formLead = (await call('/api/v1/leads?q=Sunil Mehta', { ...A, workspace: VASTU })).body.find((l) => l.name === 'Sunil Mehta');
  const formLeadD = formLead ? (await call(`/api/v1/leads/${formLead.id}`, { ...A, workspace: VASTU })).body : null;
  check('the submission is a lead with the form’s source, property and message (with UTM)', formLeadD?.source === 'website_form' && formLeadD.customFields.property_type === 'Shop' && formLeadD.activities.some((a) => /east facing[\s\S]*utm_source=instagram/.test(a.remark ?? '')), formLeadD && { src: formLeadD.source, cf: formLeadD.customFields });
  const bot = await call('/public/forms/mycompany/home-audit-enquiry', { tenant: null, method: 'POST', body: { name: 'Spam Bot', mobile: '9810022002', 'cf:property_type': 'Home', _hp: 'http://spam' } });
  const botLead = (await call('/api/v1/leads?q=Spam Bot', { ...A, workspace: VASTU })).body;
  check('bots that fill the hidden field get “thanks” but no lead', bot.status === 200 && botLead.length === 0, botLead.length);
  const forms = (await call('/api/v1/forms', { token: manager, workspace: VASTU })).body;
  check('the form counts its submissions', forms.forms.find((f) => f.id === form.body.id)?.submissions === 1, forms.forms);
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) limited = (await call('/public/forms/mycompany/home-audit-enquiry', { tenant: null, method: 'POST', body: { name: `Flood ${i}`, mobile: `98100221${10 + i}`, 'cf:property_type': 'Home' } })).status === 429;
  check('one visitor cannot flood the form (rate limit)', limited);
  await call(`/api/v1/forms/${form.body.id}/archive`, { token: manager, workspace: VASTU, method: 'POST', body: {} });
  const gone = await call('/public/forms/mycompany/home-audit-enquiry', { tenant: null });
  const abcForm = await call('/public/forms/abc/home-audit-enquiry', { tenant: null });
  check('archived forms and other organizations’ addresses are not found', gone.status === 404 && abcForm.status === 404, [gone.status, abcForm.status]);

  // ── Google Sheets ──
  await call('/api/v1/integrations/google_sheets/setup', { ...A, method: 'PUT', body: { values: { sheetUrl: `${LOCAL}/sheet.csv`, businessLine: COURSE, syncMinutes: '15' }, activate: true } });
  await call('/api/v1/integrations/google_sheets/mapping', { ...A, method: 'PUT', body: { sourceFields: ['Name', 'Mobile', 'Email', 'City', 'Notes'], map: { Name: 'name', Mobile: 'mobile', Email: 'email', City: 'city', Notes: 'remark' }, duplicateMode: 'add_remark' } });
  const sync1 = await call('/api/v1/integrations/google_sheets/sync', { ...A, method: 'POST' });
  const sync2 = await call('/api/v1/integrations/google_sheets/sync', { ...A, method: 'POST' });
  sheet += 'Chetan Shah,9810066003,chetan@example.com,Mumbai,Interested in the software\n';
  const sync3 = await call('/api/v1/integrations/google_sheets/sync', { ...A, method: 'POST' });
  check('Google Sheets: new rows become leads; rows already read are not read again', sync1.status === 201 && sync1.body.created === 2 && sync2.body.created === 0 && sync2.body.seen === 2 && sync3.body.created === 1 && sync3.body.seen === 2, [sync1.body, sync2.body, sync3.body]);
  const rmSync = await call('/api/v1/integrations/google_sheets/sync', { token: rm, workspace: VASTU, method: 'POST' });
  check('only organization admins run a sync', rmSync.status === 403, rmSync.status);

  // ── Setup Guide ──
  const guide = (await call('/api/v1/setup-guide', A)).body;
  const gstep = (id) => guide.guides.flatMap((x) => x.cards.flatMap((c) => c.steps)).find((x) => x.id === id);
  check('Setup Guide: forms, Sheets, portals, webhooks and API keys are live and tick themselves off', ['src_forms', 'src_sheets', 'src_portals', 'src_website', 'webhook_setup', 'api_keys'].every((id) => gstep(id)?.done && gstep(id)?.href), ['src_forms', 'src_sheets', 'src_portals', 'src_website', 'webhook_setup', 'api_keys'].map((id) => [id, gstep(id)?.done, gstep(id)?.href]));

  // ── Isolation ──
  const abcKeys = (await call('/api/v1/api-keys', { token: abc, tenant: 'abc' })).body;
  const abcHooks = (await call('/api/v1/webhooks', { token: abc, tenant: 'abc' })).body;
  const abcLog = (await call('/api/v1/integrations/website_api/events', { token: abc, tenant: 'abc' })).body;
  check('another organization sees none of the keys, webhooks or events', abcKeys.keys.length === 0 && abcHooks.webhooks.length === 0 && abcLog.items.length === 0, [abcKeys.keys?.length, abcHooks.webhooks?.length, abcLog.items?.length]);
} finally {
  server.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll integration checks passed');
process.exit(failures ? 1 : 0);
