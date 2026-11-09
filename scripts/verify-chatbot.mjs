// End-to-end checks for slice 2.10: chatbot flows on WhatsApp and website chat, a person taking over, saving answers, scheduled messages, website chat privacy.
// A local server plays Meta's Graph API on :4597. Usage: npm run verify:chatbot   (API running, freshly seeded, Mailpit on; run `npm run db:seed` afterwards).

import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const SECRET = 'meta-app-secret-for-tests';
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers = {}, raw } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(path.startsWith('http') ? path : API + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sent = [];
let seq = 0;
const server = createServer((req, res) => {
  let data = ''; req.on('data', (c) => (data += c));
  req.on('end', () => { const b = data ? JSON.parse(data) : {}; sent.push(b); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ messages: [{ id: `wamid.out${++seq}` }] })); });
});
await new Promise((r) => server.listen(4597, r));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const WS = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = WS['Vastu Consultation / Audit'];
const post = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'POST', body: body ?? {} });
const patch = (p, token, body) => call(p, { token, workspace: VASTU, method: 'PATCH', body });
const get = (p, token, workspace = VASTU) => call(p, { token, workspace });
const stamp = Date.now();
let n = 0;
const num = () => `9198${String(stamp).slice(-6)}${String(++n).padStart(2, '0')}`;

await call('/api/v1/integrations/whatsapp/setup', { token: admin, method: 'PUT', body: { values: { phoneNumberId: 'PN1', wabaId: 'WABA', accessToken: 'meta-token-123', appSecret: SECRET, apiBase: 'http://localhost:4597/v21.0', businessLine: VASTU }, activate: true } });
const URL_ = (await call('/api/v1/integrations/whatsapp/setup', { token: admin })).body.webhookUrl;
check('(setup) WhatsApp connected', !!URL_);
let mid = 0;
const incoming = async (from, text, button) => {
  const message = button ? { from, id: `wamid.b${stamp}${++mid}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { button_reply: { title: text } } } : { from, id: `wamid.b${stamp}${++mid}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } };
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name: `Bot Test ${from.slice(-4)}` } }], messages: [message] } }] }] });
  return call(URL_, { tenant: null, method: 'POST', raw, headers: { 'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } });
};
const toNumber = (w) => sent.filter((s) => s.to === w);
const textOf = (s) => s.text?.body ?? s.interactive?.body?.text;

const steps = [
  { id: 's1', type: 'buttons', text: 'Hello! What do you need?', options: [{ label: 'Pricing', next: 's2' }, { label: 'Person', next: 's5' }] },
  { id: 's2', type: 'question', text: 'Which city are you in?', saveTo: 'city', next: 's3' },
  { id: 's3', type: 'question', text: 'Your email please?', saveTo: 'email', next: 's4' },
  { id: 's4', type: 'message', text: 'Thanks, we will send the prices.' },
  { id: 's5', type: 'handoff', text: 'Connecting you with our team.' },
];
const flow = (body, token = manager) => post('/api/v1/chat-flows', token, { name: 'Welcome', steps, ...body });
check('a salesperson cannot build flows', (await flow({}, rm)).status === 403);
check('an auditor cannot read them', (await get('/api/v1/chat-flows', auditor)).status === 403);
check('a step cannot point nowhere', (await flow({ steps: [{ id: 'a', type: 'message', text: 'x', next: 'zz' }] })).status === 400);
check('button labels follow WhatsApp\'s limit', (await flow({ steps: [{ id: 'a', type: 'buttons', text: 'x', options: [{ label: 'x'.repeat(21) }] }] })).status === 400);
check('at most three buttons', (await flow({ steps: [{ id: 'a', type: 'buttons', text: 'x', options: [1, 2, 3, 4].map((i) => ({ label: `o${i}` })) }] })).status === 400);
check('a buttons step needs buttons', (await flow({ steps: [{ id: 'a', type: 'buttons', text: 'x' }] })).status === 400);
check('a keyword flow needs keywords', (await flow({ trigger: 'keyword', keywords: [] })).status === 400);
const welcome = (await flow({})).body;
check('a manager builds a flow', !!welcome.id, welcome);

// Conversation
const A = num();
await incoming(A, 'hi there');
let out = toNumber(A);
check('the first message starts the flow', out.length === 1 && out[0].type === 'interactive' && out[0].interactive.action.buttons.length === 2, out);
await incoming(A, 'something else');
out = toNumber(A);
check('an unrecognised reply is asked again', out.length === 2 && textOf(out[1]).includes('Please choose'), out.map(textOf));
await incoming(A, 'Pricing', true);
out = toNumber(A);
check('a button leads to the next step', textOf(out.at(-1)) === 'Which city are you in?', out.map(textOf));
await incoming(A, 'Pune');
await incoming(A, 'not-an-email');
out = toNumber(A);
check('a wrong email is asked again', textOf(out.at(-1)).includes('did not get that'), out.map(textOf));
await incoming(A, `bot.${stamp}@example.com`);
out = toNumber(A);
check('the flow ends with its last message', textOf(out.at(-1)) === 'Thanks, we will send the prices.', out.map(textOf));
const convs = (await get('/api/v1/conversations', admin)).body;
const c = convs.find((x) => x.name === `Bot Test ${A.slice(-4)}`);
const lead = (await get(`/api/v1/leads/${c.leadId}`, admin)).body;
check('answers are saved on the lead', lead.city === 'Pune' && lead.email === `bot.${stamp}@example.com`, { city: lead.city, email: lead.email });
check('answers are on the journey', JSON.stringify(lead.activities).includes('Chatbot: Pune'));
const before = toNumber(A).length;
await incoming(A, 'one more question');
check('a finished flow does not restart', toNumber(A).length === before);
const th = (await get(`/api/v1/conversations/${c.id}`, admin)).body;
check('bot messages show in the inbox with their buttons', th.messages.some((m) => m.direction === 'out' && m.options?.length === 2), th.messages.slice(0, 2));
check('bot replies leave the chat unread for the team', th.unread > 0 || c.unread > 0, c.unread);

// Handoff
const B = num();
await incoming(B, 'hello');
await incoming(B, 'Person', true);
check('handing off tells the customer', textOf(toNumber(B).at(-1)) === 'Connecting you with our team.');
const after = toNumber(B).length;
await incoming(B, 'are you there');
check('the bot stays quiet after handing off', toNumber(B).length === after);

// A person takes over
const C = num();
await incoming(C, 'hello');
const cc = (await get('/api/v1/conversations', admin)).body.find((x) => x.name === `Bot Test ${C.slice(-4)}`);
await post(`/api/v1/conversations/${cc.id}/messages`, admin, { text: 'Hi, I am Neha.' }, VASTU);
const count = toNumber(C).length;
await incoming(C, 'Pricing', true);
check('when a person replies, the bot steps aside', toNumber(C).length === count, toNumber(C).map(textOf));

// STOP and keywords
const D = num();
await incoming(D, 'STOP');
check('STOP never starts a flow', toNumber(D).length === 0);
await patch(`/api/v1/chat-flows/${welcome.id}`, manager, { isActive: false });
const E = num();
await incoming(E, 'hello');
check('a paused flow does not run', toNumber(E).length === 0);
await post('/api/v1/chat-flows', manager, { name: 'Prices', trigger: 'keyword', keywords: ['price'], steps: [{ id: 'a', type: 'message', text: 'Prices start at 999.' }] });
await incoming(E, 'what is the price please');
check('a keyword starts its flow any time', textOf(toNumber(E).at(-1)) === 'Prices start at 999.', toNumber(E).map(textOf));
check('another organization cannot see flows', !(await call('/api/v1/chat-flows', { tenant: 'abc', token: abc, workspace: VASTU })).body?.flows?.some?.((f) => f.id === welcome.id));

// Website chat
check('a salesperson cannot create chat buttons', (await post('/api/v1/chat-widgets', rm, { name: 'Site', greeting: 'Hi' })).status === 403);
const w = (await post('/api/v1/chat-widgets', manager, { name: 'Main site', greeting: 'Hi! How can we help?', color: '#123456' })).body;
check('a manager creates a chat button', !!w.publicKey, w);
const base = `/public/chat/mycompany/${w.publicKey}`;
const script = await call(`${base}/widget.js`, { tenant: null });
check('the website script loads', script.status === 200 && script.headers.get('content-type').includes('javascript') && String(script.body).includes(`/chat/mycompany/${w.publicKey}`));
check('the script keeps the colour safe', String(script.body).includes('"#123456"'));
check('a wrong key finds nothing', (await call('/public/chat/mycompany/nope', { tenant: null })).status === 404);
check('another organization\'s address finds nothing', (await call(`/public/chat/abc/${w.publicKey}`, { tenant: null })).status === 404);
await post('/api/v1/chat-flows', manager, { name: 'Web hello', channel: 'webchat', steps: [{ id: 's1', type: 'buttons', text: 'Pick one', options: [{ label: 'Sales', next: 's2' }] }, { id: 's2', type: 'handoff', text: 'One moment.' }] });
const mobile = `98${String(stamp).slice(-8)}`;
check('a bad number starts nothing', (await call(`${base}/start`, { tenant: null, method: 'POST', body: { name: 'Web V', mobile: '12345678' } })).status === 400);
check('a hidden-field bot gets no chat', (await (async () => { const r = await call(`${base}/start`, { tenant: null, method: 'POST', body: { name: 'Bot', mobile, _hp: 'x' } }); return (await call(`${base}/messages`, { tenant: null, headers: { 'X-Chat-Token': r.body.token } })).status; })()) === 404);
const started = await call(`${base}/start`, { tenant: null, method: 'POST', body: { name: `Web Visitor ${stamp}`, mobile, message: 'Do you do offices?' } });
const token = started.body.token;
check('a visitor starts a chat', !!token, started.body);
const vh = { tenant: null, headers: { 'X-Chat-Token': token } };
let vm = (await call(`${base}/messages`, vh)).body;
check('the visitor sees the greeting and the bot', vm[0].text === 'Hi! How can we help?' && vm.some((m) => m.from === 'them' && m.options?.[0] === 'Sales'), vm);
check('the chat cannot be read without its token', (await call(`${base}/messages`, { tenant: null })).status === 404 && (await call(`${base}/messages`, { tenant: null, headers: { 'X-Chat-Token': 'wrong' } })).status === 404);
await call(`${base}/messages`, { ...vh, method: 'POST', body: { text: 'Sales' } });
vm = (await call(`${base}/messages`, vh)).body;
check('web buttons work like WhatsApp buttons', vm.at(-1).text === 'One moment.', vm.map((m) => m.text));
const inbox = (await get('/api/v1/conversations', admin)).body;
const wc = inbox.find((x) => x.name === `Web Visitor ${stamp}`);
check('the website chat is in the Inbox', wc?.channel === 'webchat' && wc.windowOpen === true && wc.phone === null, wc);
const wl = (await get(`/api/v1/leads/${wc.leadId}`, admin)).body;
check('a website chat creates a lead', wl.source === 'website_chat' && JSON.stringify(wl.activities).includes('Do you do offices?'), wl.source);
const reply = await post(`/api/v1/conversations/${wc.id}/messages`, admin, { text: 'Yes we do. <b>Call us</b>' });
check('the team replies from the Inbox', reply.status === 201 && !sent.some((s) => JSON.stringify(s).includes('Yes we do')), reply.body);
vm = (await call(`${base}/messages`, vh)).body;
check('the visitor gets the reply', vm.at(-1).text === 'Yes we do. <b>Call us</b>');
check('the visitor is not told who is staff', !JSON.stringify(vm).includes('userId') && !JSON.stringify(vm).includes('Company Admin'));
await patch(`/api/v1/chat-widgets/${w.id}`, manager, { isActive: false });
check('a button turned off stops new chats', (await call(`${base}/start`, { tenant: null, method: 'POST', body: { name: 'Late Visitor', mobile: `97${String(stamp).slice(-8)}` } })).status === 404);

// Scheduled messages
const users = (await call('/api/v1/users', { token: admin })).body;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local').id;
const L = (await post('/api/v1/leads', manager, { name: `Later ${stamp}`, mobile: `96${String(stamp).slice(-8)}`, customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const LID = L.id ?? L.lead?.id;
const tpl = (await post('/api/v1/message-templates', admin, { name: `later_${stamp}`, body: 'Hello {{1}}', variables: ['name'], category: 'utility' })).body;
const later = (body, token = manager, id = LID) => post(`/api/v1/leads/${id}/scheduled`, token, body);
const soon = () => new Date(Date.now() + 90_000).toISOString();
check('a time in the past is refused', (await later({ templateId: tpl.id, sendAt: new Date(Date.now() - 60_000).toISOString() })).body.code === 'TOO_SOON');
check('a salesperson cannot schedule on a lead they cannot see', (await later({ templateId: tpl.id, sendAt: soon() }, rm)).status === 404);
const sch = (await later({ templateId: tpl.id, sendAt: soon() })).body;
check('a message is scheduled', sch.status === 'pending', sch);
const sch2 = (await later({ templateId: tpl.id, sendAt: soon() })).body;
check('a scheduled message can be cancelled', (await post(`/api/v1/scheduled-messages/${sch2.id}/cancel`, manager)).status === 200);
check('it cannot be cancelled twice', (await post(`/api/v1/scheduled-messages/${sch2.id}/cancel`, manager)).body.code === 'ALREADY_SENT');
const beforeSend = sent.filter((s) => s.template?.name === `later_${stamp}`).length;
console.log('INFO scheduled sends wait for their time, up to about 3 minutes');
await (async () => { for (let i = 0; i < 200; i++) { const r = (await get(`/api/v1/leads/${LID}/scheduled`, manager)).body; if (r.find((x) => x.id === sch.id)?.status !== 'pending') return; await sleep(1000); } })();
const row = (await get(`/api/v1/leads/${LID}/scheduled`, manager)).body;
check('it goes out at its time, once', row.find((x) => x.id === sch.id)?.status === 'sent' && sent.filter((s) => s.template?.name === `later_${stamp}`).length === beforeSend + 1, row);
check('a cancelled message is never sent', row.find((x) => x.id === sch2.id)?.status === 'cancelled');

server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
