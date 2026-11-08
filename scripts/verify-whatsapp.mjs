// End-to-end checks for slice 2.3 (WhatsApp): Meta's webhook check and signatures, new chats → leads, resends stored once,
// inbox visibility, 24-hour rule, delivery statuses, STOP / START, templates, broadcasts, provider failures, live events.
// A local server plays Meta's Graph API. Usage: npm run verify:whatsapp   (API running, freshly seeded)

import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const PORT = Number(process.env.VERIFY_META_PORT ?? 4597);
const SECRET = 'meta-app-secret-for-tests';
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers = {}, raw } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(path.startsWith('http') ? path : API + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stand-in for Meta's Graph API ──
const sent = [];
let seq = 0;
const server = createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const b = data ? JSON.parse(data) : {};
    sent.push({ url: req.url, auth: req.headers.authorization, body: b });
    res.setHeader('Content-Type', 'application/json');
    if (b.to === '919000000099') { res.statusCode = 400; return res.end('{"error":{"message":"Recipient is not on WhatsApp"}}'); }
    res.end(JSON.stringify({ messages: [{ id: `wamid.out${++seq}` }] }));
  });
});
await new Promise((r) => server.listen(PORT, r));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const simran = await login('rm2@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const COURSE = ws['Course / Software'];
const R = { token: rm, workspace: VASTU };
const M = { token: manager, workspace: VASTU };
const users = (await call('/api/v1/users', { token: admin })).body;
const ARJUN = users.find((u) => u.email === 'rm@mycompany.local').id;
const vastu = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body;
const arjunLeads = vastu.filter((l) => l.ownerId === ARJUN);
const lead = (await call(`/api/v1/leads/${arjunLeads[0].id}`, { token: admin, workspace: VASTU })).body;
const lead2 = (await call(`/api/v1/leads/${arjunLeads[1].id}`, { token: admin, workspace: VASTU })).body;
const WA = lead.mobile.replace(/\D/g, '');
const WA2 = lead2.mobile.replace(/\D/g, '');

const now = () => String(Math.floor(Date.now() / 1000));
const envelope = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PN1' }, ...value } }] }] });
const inMsg = (from, id, text, name, ts = now()) => envelope({ contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, timestamp: ts, type: 'text', text: { body: text } }] });
const statusOf = (id, status, errors) => envelope({ statuses: [{ id, status, timestamp: now(), ...(errors ? { errors } : {}) }] });

try {
  await call('/api/v1/integrations/whatsapp/setup', { token: admin, method: 'PUT', body: { values: { phoneNumberId: 'PN1', wabaId: 'WABA', accessToken: 'meta-token-123', appSecret: SECRET, apiBase: `http://localhost:${PORT}/v21.0`, businessLine: VASTU }, activate: true } });
  const setup = (await call('/api/v1/integrations/whatsapp/setup', { token: admin })).body;
  const URL_ = setup.webhookUrl;
  check('setup gives a webhook URL and a Verify token, and hides the secrets', /\/hooks\/mycompany\/whatsapp\//.test(URL_) && URL_.endsWith(setup.verifyToken) && /^••••/.test(setup.values.accessToken) && /^••••/.test(setup.values.appSecret), { url: !!URL_, v: setup.values });
  const post = (b, sig) => { const raw = JSON.stringify(b); return call(URL_, { tenant: null, method: 'POST', raw, headers: sig === null ? {} : { 'X-Hub-Signature-256': sig ?? `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } }); };

  const okV = await call(`${URL_}?hub.mode=subscribe&hub.verify_token=${setup.verifyToken}&hub.challenge=12345`, { tenant: null });
  const badV = await call(`${URL_}?hub.mode=subscribe&hub.verify_token=wrong-token-xxxxxxxxxxxx&hub.challenge=12345`, { tenant: null });
  check('Meta’s webhook check: right token echoes the challenge, wrong token is refused', okV.status === 200 && String(okV.body) === '12345' && badV.status === 404, [okV, badV.status]);
  const unsigned = await post(inMsg('919811100001', 'wamid.x0', 'hi', 'Fake'), null);
  const forged = await post(inMsg('919811100001', 'wamid.x0', 'hi', 'Fake'), 'sha256=' + '0'.repeat(64));
  check('unsigned or forged webhooks are refused and store nothing', unsigned.status === 401 && forged.status === 401 && (await call('/api/v1/conversations', { token: admin, workspace: VASTU })).body.length === 0, [unsigned.status, forged.status]);

  // New number → lead; resend → once
  const n1 = await post(inMsg('919811100001', 'wamid.in1', 'Need a vastu audit', 'Ritika Sen'));
  const n1b = await post(inMsg('919811100001', 'wamid.in1', 'Need a vastu audit', 'Ritika Sen'));
  const all1 = (await call('/api/v1/conversations', { token: admin, workspace: VASTU })).body;
  const c1 = all1.find((c) => c.name === 'Ritika Sen');
  const newLead = c1 ? (await call(`/api/v1/leads/${c1.leadId}`, { token: admin, workspace: VASTU })).body : null;
  check('a chat from a new number creates a lead (source WhatsApp, assignment rules)', n1.status === 200 && n1.body.messages === 1 && newLead?.source === 'whatsapp' && newLead.workspace.id === VASTU && !!c1.assigneeId && c1.windowOpen, [n1.body, c1]);
  check('Meta resending the same message stores it once', n1b.body.duplicates === 1 && c1?.unread === 1, [n1b.body, c1?.unread]);

  // Existing customer → their open lead, no new lead
  const before = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body.length;
  await post(inMsg(WA, 'wamid.in2', 'When is the site visit?', lead.name));
  await post(inMsg(WA, 'wamid.in3', 'Please confirm', lead.name));
  const after = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body.length;
  const mine = (await call('/api/v1/conversations?view=mine', R)).body;
  const c2 = mine.find((c) => c.leadId === lead.id);
  const leadAfter = (await call(`/api/v1/leads/${lead.id}`, { token: admin, workspace: VASTU })).body;
  check('an existing customer’s chat joins their open lead: no new lead, goes to its owner', after === before && !!c2 && c2.assigneeId === ARJUN && c2.unread === 2 && !leadAfter.activities.some((a) => /Repeat enquiry/.test(a.remark ?? '')), [before, after, c2]);

  // Visibility
  const simAll = (await call('/api/v1/conversations', { token: simran, workspace: COURSE })).body;
  const simOne = await call(`/api/v1/conversations/${c2.id}`, { token: simran, workspace: COURSE });
  const abcAll = await call('/api/v1/conversations', { token: abc, tenant: 'abc' });
  const mgrAll = (await call('/api/v1/conversations', M)).body;
  check('chats follow lead scope: manager sees them, another business line and another organization do not', mgrAll.some((c) => c.id === c2.id) && !simAll.some((c) => c.id === c2.id) && simOne.status === 404 && (abcAll.status === 403 || abcAll.body.length === 0), [simAll.length, simOne.status, abcAll.status]);
  const thread = (await call(`/api/v1/conversations/${c2.id}`, R)).body;
  const unreadAfter = (await call('/api/v1/conversations?view=mine', R)).body.find((c) => c.id === c2.id).unread;
  const mgrView = await call(`/api/v1/conversations/${c1.id}`, M);
  const c1After = (await call('/api/v1/conversations', M)).body.find((c) => c.id === c1.id);
  check('opening a chat shows its messages in order and clears unread for the assignee only', thread.messages.length === 2 && thread.messages[0].body === 'When is the site visit?' && unreadAfter === 0 && mgrView.status === 200 && (c1.assigneeId === NEHA() ? true : c1After.unread === 1), [thread.messages?.length, unreadAfter, c1After?.unread]);

  // Reply, statuses
  const reply = await call(`/api/v1/conversations/${c2.id}/messages`, { ...R, method: 'POST', body: { text: 'Tuesday 11 am works.' } });
  const out = sent.at(-1);
  check('a reply inside 24 hours goes through the Graph API with the token', reply.status === 201 && reply.body.status === 'sent' && out.url === '/v21.0/PN1/messages' && out.auth === 'Bearer meta-token-123' && out.body.to === WA && out.body.type === 'text' && out.body.text.body === 'Tuesday 11 am works.', [reply.body, out]);
  const wid = reply.body.waMessageId;
  const st = async () => (await call(`/api/v1/conversations/${c2.id}`, R)).body.messages.find((m) => m.direction === 'out').status;
  await post(statusOf(wid, 'read'));
  const s1 = await st();
  await post(statusOf(wid, 'delivered'));
  const s2 = await st();
  check('delivery ticks only move forward, even when they arrive out of order', s1 === 'read' && s2 === 'read', [s1, s2]);
  const reply2 = await call(`/api/v1/conversations/${c2.id}/messages`, { ...R, method: 'POST', body: { text: 'Second note' } });
  await post(statusOf(reply2.body.waMessageId, 'failed', [{ title: 'Message undeliverable' }]));
  const failedMsg = (await call(`/api/v1/conversations/${c2.id}`, R)).body.messages.find((m) => m.id === reply2.body.id);
  check('a failed delivery shows its reason', failedMsg.status === 'failed' && failedMsg.error === 'Message undeliverable', failedMsg);

  // 24-hour window
  await post(inMsg('919811100002', 'wamid.old1', 'Old message', 'Old Chat', String(Math.floor(Date.now() / 1000) - 25 * 3600)));
  const oldC = (await call('/api/v1/conversations', { token: admin, workspace: VASTU })).body.find((c) => c.name === 'Old Chat');
  const late = await call(`/api/v1/conversations/${oldC.id}/messages`, { token: admin, workspace: VASTU, method: 'POST', body: { text: 'Hello?' } });
  check('after 24 hours free text is refused (template needed)', late.status === 400 && late.body.code === 'WINDOW_CLOSED' && oldC.windowOpen === false, [late.body, oldC]);

  await post(inMsg('919811100003', 'wamid.fresh', 'Fresh', 'Retry Chat'));
  await post(inMsg('919811100003', 'wamid.stale', 'Stale retry', 'Retry Chat', String(Math.floor(Date.now() / 1000) - 26 * 3600)));
  const retryC = (await call('/api/v1/conversations', { token: admin, workspace: VASTU })).body.find((c) => c.name === 'Retry Chat');
  await post(inMsg('919811100004', 'wamid.old2', 'Old', 'Stale Only', String(Math.floor(Date.now() / 1000) - 26 * 3600)));
  await post(inMsg('919811100004', 'wamid.old3', 'Older', 'Stale Only', String(Math.floor(Date.now() / 1000) - 30 * 3600)));
  const staleC = (await call('/api/v1/conversations', { token: admin, workspace: VASTU })).body.find((c) => c.name === 'Stale Only');
  check('a late retry of an old message does not change the 24-hour window', retryC.windowOpen === true && staleC.windowOpen === false, [retryC, staleC]);

  // Templates
  const tpl = { name: 'audit_followup', language: 'en', category: 'utility', body: 'Hello {{1}}, this is {{2}} about your audit.', variables: ['name', 'owner'] };
  const rmTpl = await call('/api/v1/message-templates', { ...R, method: 'POST', body: tpl });
  const bad = await call('/api/v1/message-templates', { ...M, method: 'POST', body: { ...tpl, variables: ['name'] } });
  const t1 = await call('/api/v1/message-templates', { ...M, method: 'POST', body: tpl });
  const dup = await call('/api/v1/message-templates', { ...M, method: 'POST', body: tpl });
  const list = (await call('/api/v1/message-templates', R)).body;
  check('templates: managers register them, placeholders must be mapped, no duplicates, RMs can use them', rmTpl.status === 403 && bad.status === 400 && bad.body.code === 'VARIABLES_MISMATCH' && t1.status === 201 && dup.status === 400 && list.templates.length === 1 && list.canManage === false, [rmTpl.status, bad.body, t1.body, dup.status]);
  const sendT = await call(`/api/v1/leads/${lead2.id}/whatsapp/template`, { ...R, method: 'POST', body: { templateId: t1.body.id } });
  const tOut = sent.at(-1);
  check('a template is sent with its blanks filled from the lead, and starts a chat', sendT.status === 201 && tOut.body.type === 'template' && tOut.body.template.name === 'audit_followup' && tOut.body.template.components[0].parameters[0].text === lead2.name && tOut.body.template.components[0].parameters[1].text === 'Arjun (RM)' && sendT.body.body === `Hello ${lead2.name}, this is Arjun (RM) about your audit.`, [sendT.body, tOut?.body]);
  const li = (await call(`/api/v1/leads/${lead2.id}/whatsapp`, R)).body;
  check('the lead shows its chat status', li.connected && !!li.conversationId && li.windowOpen === false && li.optedOut === false, li);

  // Opt-out
  await post(inMsg(WA2, 'wamid.stop', 'STOP', lead2.name));
  const blocked = await call(`/api/v1/leads/${lead2.id}/whatsapp/template`, { ...R, method: 'POST', body: { templateId: t1.body.id } });
  const noted = (await call(`/api/v1/leads/${lead2.id}`, R)).body.activities.some((a) => /Opted out/.test(a.remark ?? ''));
  check('STOP opts the customer out: no more templates, noted on the lead', blocked.status === 400 && blocked.body.code === 'OPTED_OUT' && noted, [blocked.body, noted]);

  // Broadcast
  const targets = [lead.id, lead2.id, c1.leadId];
  const rmB = await call('/api/v1/broadcasts', { ...R, method: 'POST', body: { name: 'Diwali', templateId: t1.body.id, leadIds: targets } });
  const nBefore = sent.length;
  const b = await call('/api/v1/broadcasts', { ...M, method: 'POST', body: { name: 'Diwali offer', templateId: t1.body.id, leadIds: targets } });
  check('broadcast: managers only; opted-out customers are skipped', rmB.status === 403 && b.status === 201 && b.body.total === 3 && b.body.sent === 2 && b.body.skipped === 1 && b.body.failed === 0 && sent.length === nBefore + 2 && !sent.slice(nBefore).some((s) => s.body.to === WA2), [rmB.status, b.body]);
  await post(inMsg(WA2, 'wamid.start', 'START', lead2.name));
  const back = await call(`/api/v1/leads/${lead2.id}/whatsapp/template`, { ...R, method: 'POST', body: { templateId: t1.body.id } });
  check('START opts back in', back.status === 201, back.body);

  // Provider failure
  await post(inMsg('919000000099', 'wamid.nf', 'hello', 'Bad Number'));
  const badC = (await call('/api/v1/conversations', { token: admin, workspace: VASTU })).body.find((c) => c.name === 'Bad Number');
  const fail = await call(`/api/v1/conversations/${badC.id}/messages`, { token: admin, workspace: VASTU, method: 'POST', body: { text: 'Hi' } });
  const failRow = (await call(`/api/v1/conversations/${badC.id}`, { token: admin, workspace: VASTU })).body.messages.at(-1);
  check('when WhatsApp refuses, the person is told why and the message is marked failed', fail.status === 502 && /Recipient is not on WhatsApp/.test(fail.body.message) && failRow.status === 'failed', [fail.body, failRow]);

  // Assign, close, permissions
  const rmAssign = await call(`/api/v1/conversations/${c2.id}/assign`, { ...R, method: 'POST', body: { userId: null } });
  const assign = await call(`/api/v1/conversations/${c1.id}/assign`, { ...M, method: 'POST', body: { userId: ARJUN } });
  const closeIt = await call(`/api/v1/conversations/${c1.id}/status`, { ...M, method: 'POST', body: { status: 'closed' } });
  await post(inMsg('919811100001', 'wamid.in9', 'One more thing', 'Ritika Sen'));
  const c1Now = (await call('/api/v1/conversations?view=mine', R)).body.find((c) => c.id === c1.id);
  check('managers assign chats (RMs cannot); a new message reopens a closed chat', rmAssign.status === 403 && assign.status === 201 && closeIt.status === 201 && c1Now?.status === 'open', [rmAssign.status, assign.status, c1Now]);
  const logs = (await call('/api/v1/audit-logs', { token: admin })).body;
  check('broadcasts, templates and assignments are audited, tokens never', ['broadcast.sent', 'message_template.created', 'conversation.assigned'].every((a) => logs.some((l) => l.action === a)) && !JSON.stringify(logs).includes('meta-token-123') && !JSON.stringify(logs).includes(SECRET), logs.slice(0, 6).map((l) => l.action));

  // Live
  const events = [];
  const ctrl = new AbortController();
  const sse = fetch(`${API}/api/v1/stream?tenant=mycompany`, { headers: { Authorization: `Bearer ${manager}` }, signal: ctrl.signal }).then(async (res) => { const r = res.body.getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; events.push(new TextDecoder().decode(value)); } }).catch(() => undefined);
  await sleep(400);
  await post(inMsg(WA, 'wamid.live', 'Are you there?', lead.name));
  await sleep(800);
  ctrl.abort(); await sse;
  check('open browsers get a live “message.received” event', events.join('').includes('event: message.received') && events.join('').includes(c2.id), events.join('').slice(0, 200));
} finally {
  server.close();
}

function NEHA() { return users.find((u) => u.email === 'manager@mycompany.local').id; }
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll WhatsApp checks passed');
process.exit(failures ? 1 : 0);
