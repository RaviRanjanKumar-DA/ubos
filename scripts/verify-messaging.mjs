// End-to-end checks for slice 2.4 (SMS & email): templates and their rules, sending through a URL-pattern gateway and
// MSG91, delivery reports, email with unsubscribe, opt-outs, bulk sends, scope. A local server plays the SMS gateway;
// emails land in Mailpit. Usage: npm run verify:messaging   (API + Mailpit running, freshly seeded)

import { createServer } from 'node:http';

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const PORT = Number(process.env.VERIFY_SMS_PORT ?? 4596);
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers = {}, form } = {}) {
  const h = { ...(form ? {} : { 'Content-Type': 'application/json' }), ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(path.startsWith('http') ? path : API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (id, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier: id, password: PASSWORD } })).body.accessToken;
const started = Date.now() - 3000;
const mailFor = async (to) => {
  const list = ((await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()).messages ?? []).filter((m) => new Date(m.Created).getTime() >= started && m.To.some((t) => t.Address === to));
  return Promise.all(list.map(async (m) => ({ subject: m.Subject, text: (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()).Text })));
};

// ── Stand-in SMS gateway ──
const hits = [];
let seq = 0;
const server = createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    hits.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), key: req.headers.authkey, body: data ? JSON.parse(data) : null });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/send') { if (u.searchParams.get('to') === '919000000098') { res.statusCode = 500; return res.end('{"message":"Invalid number"}'); } return res.end(JSON.stringify({ id: `GW${++seq}` })); }
    if (u.pathname === '/api/v5/flow') return res.end(JSON.stringify({ type: 'success', message: `REQ${++seq}` }));
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => server.listen(PORT, r));
const LOCAL = `http://localhost:${PORT}`;

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = me.workspaces.find((w) => w.name.startsWith('Vastu')).id;
const R = { token: rm, workspace: VASTU };
const M = { token: manager, workspace: VASTU };
const A = { token: admin };
const stamp = String(Date.now()).slice(-6);
const mkLead = async (name, mobile, email) => (await call('/api/v1/leads', { ...R, method: 'POST', body: { name, mobile, ...(email ? { email } : {}), customFields: { property_type: 'Home' } } })).body.id;
const L1 = await mkLead('Asha Rao', '9810070001', `asha${stamp}@example.com`);
const L2 = await mkLead('Bina Das', '9810070002', `bina${stamp}@example.com`);
const L3 = await mkLead('No Email', '9810070003', null);
const BAD = await mkLead('Bad Number', '9000000098', `bad${stamp}@example.com`);
const users = (await call('/api/v1/users', A)).body;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local').id;
const nehaL = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body.find((l) => l.ownerId === NEHA);
const send = (lead, templateId, who = R) => call(`/api/v1/leads/${lead}/outreach`, { ...who, method: 'POST', body: { templateId } });

try {
  // Templates
  const smsT = { channel: 'sms', name: 'visit_reminder', category: 'utility', body: 'Dear {#var#}, your visit is booked. {#var#}, Batra', variables: ['name', 'owner'], dltTemplateId: '1207161234567890123', providerTemplateId: 'msg91abc' };
  const rmT = await call('/api/v1/outreach/templates', { ...R, method: 'POST', body: smsT });
  const noDlt = await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: { ...smsT, dltTemplateId: null } });
  const mismatch = await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: { ...smsT, variables: ['name'] } });
  const noSubject = await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: { channel: 'email', name: 'welcome', body: 'Hi' } });
  const t1 = await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: smsT });
  const t2 = await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: { channel: 'email', name: 'welcome', subject: 'Welcome {{1}}', body: 'Hello {{1}}, {{2}} will help you.', variables: ['name', 'owner'] } });
  const dup = await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: smsT });
  const noPId = await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: { ...smsT, name: 'no_flow_id', providerTemplateId: null } });
  const rmList = (await call('/api/v1/outreach/templates', R)).body;
  check('templates: managers only, DLT ID and email subject required, blanks must be mapped, no duplicates', rmT.status === 403 && noDlt.body.code === 'DLT_REQUIRED' && mismatch.body.code === 'VARIABLES_MISMATCH' && noSubject.body.code === 'SUBJECT_REQUIRED' && t1.status === 201 && t2.status === 201 && noPId.status === 201 && dup.body.code === 'DUPLICATE_TEMPLATE' && rmList.templates.length === 3 && rmList.canManage === false, [rmT.status, noDlt.body, mismatch.body, noSubject.body, t1.body, dup.body]);

  // Gateway by URL pattern
  const off = await send(L1, t1.body.id);
  check('SMS is refused until the gateway is connected', off.status === 400 && off.body.code === 'SMS_OFF', off.body);
  await call('/api/v1/integrations/sms_dlt/setup', { ...A, method: 'PUT', body: { values: { provider: 'Other', apiKey: 'sms-key-123', senderId: 'BATRAA', entityId: '1201159000000000001', gatewayUrl: `${LOCAL}/send?apikey={key}&to={to}&sender={sender}&message={text}&dlt={dlt}&entity={entity}` }, activate: true } });
  const setup = (await call('/api/v1/integrations/sms_dlt/setup', A)).body;
  check('setup hides the key and gives a delivery-report address', /^••••/.test(setup.values.apiKey) && /\/hooks\/mycompany\/sms_dlt\//.test(setup.webhookUrl) && setup.phase === 'Live', setup.values);
  const s1 = await send(L1, t1.body.id);
  const g = hits.at(-1).q;
  check('SMS goes out with blanks filled, sender, DLT template and entity IDs', s1.status === 201 && s1.body.status === 'sent' && g.to === '919810070001' && g.message === 'Dear Asha Rao, your visit is booked. Arjun (RM), Batra' && g.sender === 'BATRAA' && g.dlt === smsT.dltTemplateId && g.entity === '1201159000000000001' && g.apikey === 'sms-key-123', [s1.body, g]);
  const log = (await call(`/api/v1/leads/${L1}/outreach`, R)).body;
  const lead1 = (await call(`/api/v1/leads/${L1}`, R)).body;
  check('the message shows on the lead’s log and journey', log.messages[0]?.status === 'sent' && log.messages[0].by === 'Arjun (RM)' && log.smsConnected && lead1.activities.some((a) => a.type === 'message' && /SMS sent: visit_reminder/.test(a.remark ?? '')), [log, lead1.activities?.slice(0, 2)]);
  const bad = await send(BAD, t1.body.id);
  const badLog = (await call(`/api/v1/leads/${BAD}/outreach`, R)).body;
  check('a refused SMS tells the person why and is marked failed', bad.status === 502 && /Invalid number/.test(bad.body.message) && badLog.messages[0].status === 'failed', [bad.body, badLog.messages[0]]);

  // Delivery reports
  const hook = setup.webhookUrl;
  const dl = await call(hook, { tenant: null, method: 'POST', body: [{ id: s1.body.waMessageId, status: 'delivered' }] });
  const again = await call(hook, { tenant: null, method: 'POST', body: [{ id: s1.body.waMessageId, status: 'delivered' }] });
  const wrongTok = await call(hook.replace(/[A-Za-z0-9]+$/, 'wrongtoken123456789012345'), { tenant: null, method: 'POST', body: [{ id: s1.body.waMessageId, status: 'failed' }] });
  const after = (await call(`/api/v1/leads/${L1}/outreach`, R)).body.messages[0];
  check('delivery reports update the message once; a wrong address is refused', dl.status === 200 && dl.body.updated === 1 && again.body.updated === 0 && wrongTok.status === 404 && after.status === 'delivered', [dl.body, again.body, wrongTok.status, after]);

  // MSG91
  await call('/api/v1/integrations/sms_dlt/setup', { ...A, method: 'PUT', body: { values: { provider: 'MSG91', apiKey: '••••', senderId: 'BATRAA', entityId: '1201159000000000001', apiBase: `${LOCAL}/api/v5` }, activate: true } });
  const noFlow = await send(L2, noPId.body.id);
  const m1 = await send(L2, t1.body.id);
  const h = hits.at(-1);
  check('MSG91: flow API with the kept key and its template ID (missing ID is refused)', noFlow.status === 400 && noFlow.body.code === 'PROVIDER_TEMPLATE_REQUIRED' && m1.status === 201 && h.path === '/api/v5/flow' && h.key === 'sms-key-123' && h.body.template_id === 'msg91abc' && h.body.recipients[0].mobiles === '919810070002' && h.body.recipients[0].var1 === 'Bina Das' && h.body.recipients[0].var2 === 'Arjun (RM)', [noFlow.body, h]);
  const failRep = await call(hook, { tenant: null, method: 'POST', body: [{ requestId: m1.body.waMessageId, report: [{ status: '2', desc: 'Number switched off' }] }] });
  const f2 = (await call(`/api/v1/leads/${L2}/outreach`, R)).body.messages[0];
  check('a failed delivery report shows its reason', failRep.body.updated === 1 && f2.status === 'failed' && f2.error === 'Number switched off', f2);

  // Email
  const em = await send(L1, t2.body.id);
  await new Promise((r) => setTimeout(r, 700));
  const inbox = await mailFor(`asha${stamp}@example.com`);
  const link = inbox[0]?.text.match(/https?:\/\/\S+\/public\/unsubscribe\/\S+/)?.[0];
  check('email arrives with subject and body filled and an unsubscribe link', em.status === 201 && inbox.length === 1 && inbox[0].subject === 'Welcome Asha Rao' && inbox[0].text.includes('Hello Asha Rao, Arjun (RM) will help you.') && !!link, [em.body, inbox]);
  const noAddr = await send(L3, t2.body.id);
  check('a lead without an email is told so', noAddr.status === 400 && noAddr.body.code === 'NO_ADDRESS', noAddr.body);
  const opened = await call(link, { tenant: null });
  const stillOk = (await call(`/api/v1/leads/${L1}/outreach`, R)).body.emailOptOut;
  const forged = await call(link.replace(/\.[0-9a-f]+$/, '.' + '0'.repeat(32)), { tenant: null, method: 'POST' });
  const post = await call(link, { tenant: null, method: 'POST' });
  const out = (await call(`/api/v1/leads/${L1}/outreach`, R)).body.emailOptOut;
  const blocked = await send(L1, t2.body.id);
  check('opening the link only asks; the button unsubscribes; forged links fail; no more email after', opened.status === 200 && stillOk === false && forged.status === 404 && [200, 201].includes(post.status) && out === true && blocked.body.code === 'OPTED_OUT', [opened.status, stillOk, forged.status, post.status, out, blocked.body]);

  // Opt-out by hand
  const so = await call(`/api/v1/leads/${L2}/outreach/opt-out`, { ...R, method: 'POST', body: { channel: 'sms', optedOut: true } });
  const sb = await send(L2, t1.body.id);
  check('staff can record an SMS opt-out; sending is then refused', so.status === 201 && sb.body.code === 'OPTED_OUT', [so.body, sb.body]);

  // Bulk
  const rmB = await call('/api/v1/outreach/broadcasts', { ...R, method: 'POST', body: { name: 'Offer', templateId: t1.body.id, leadIds: [L1] } });
  const n0 = hits.length;
  const b = await call('/api/v1/outreach/broadcasts', { ...M, method: 'POST', body: { name: 'Diwali SMS', templateId: t1.body.id, leadIds: [L1, L2, L3] } });
  check('bulk SMS: managers only; opted-out are skipped', rmB.status === 403 && b.status === 201 && b.body.total === 3 && b.body.sent === 2 && b.body.skipped === 1 && b.body.failed === 0 && hits.length === n0 + 2, [rmB.status, b.body]);
  const be = await call('/api/v1/outreach/broadcasts', { ...M, method: 'POST', body: { name: 'Diwali email', templateId: t2.body.id, leadIds: [L1, L2, L3] } });
  check('bulk email: unsubscribed and no-email leads are skipped', be.body.total === 3 && be.body.sent === 1 && be.body.skipped === 2, be.body);
  const hist = (await call('/api/v1/outreach/broadcasts', M)).body;
  check('bulk sends are listed', hist.length === 2 && hist.some((x) => x.name === 'Diwali SMS'), hist);

  // Scope & separation
  const notMine = await send(nehaL.id, t1.body.id);
  const abcList = (await call('/api/v1/outreach/templates', { token: abc, tenant: 'abc' })).body;
  const abcOne = await call(`/api/v1/leads/${L1}/outreach`, { token: abc, tenant: 'abc' });
  check('RMs cannot message others’ leads; another organization sees nothing', notMine.status === 404 && abcList.templates.length === 0 && abcOne.status === 404, [notMine.status, abcList, abcOne.status]);
  const wa = await call('/api/v1/conversations', { token: admin, workspace: VASTU });
  check('SMS and email stay out of the WhatsApp inbox', wa.status === 200 && wa.body.length === 0, wa.body);
  const arch = await call(`/api/v1/outreach/templates/${t2.body.id}`, { ...M, method: 'PATCH', body: { isArchived: true } });
  const archSend = await send(L2, t2.body.id);
  check('archived templates cannot be sent', arch.status === 200 && archSend.body.code === 'TEMPLATE_NOT_FOUND', archSend.body);
  const logs = (await call('/api/v1/audit-logs', A)).body;
  check('changes are audited; keys never', ['message_template.created', 'broadcast.sent', 'customer.opt_out_changed'].every((x) => logs.some((l) => l.action === x)) && !JSON.stringify(logs).includes('sms-key-123'), logs.slice(0, 5).map((l) => l.action));
} finally {
  server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll messaging checks passed');
process.exit(failures ? 1 : 0);
