// End-to-end checks for slice 2.8: booking links, native Facebook Lead Ads, Gmail and Outlook sync, tracked email. Facebook, Google and Microsoft
// are played by a local stand-in on :4597, so this proves UBOS's side only; real accounts must still be checked (docs/CONNECTED_ACCOUNTS.md).
// Usage: npm run verify:connected   (API started with CONNECT_STANDIN_URL=http://localhost:4597, META_APP_SECRET=test-meta-secret, META_VERIFY_TOKEN=test-verify and the
// test Google and Microsoft IDs; freshly seeded; Mailpit on).

import { createServer } from 'http';
import { createHmac } from 'crypto';

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const SECRET = process.env.META_APP_SECRET ?? 'test-meta-secret';
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers ?? {}) };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(API + path, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;

// ── Stand-in for the outside services ──
const stamp = Date.now();
const fb = { fail: false, subscribed: [], unsubscribed: [], leads: {} };
const gmail = { messages: [], sent: [], bodiesRead: [], refreshes: 0, refuse: false };
const graph = { messages: [], sent: [], bodiesRead: [] };
const json = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
const b64 = (s) => Buffer.from(s).toString('base64url');
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let raw = ''; for await (const c of req) raw += c;
  const p = u.pathname;
  const authed = (req.headers.authorization ?? '').startsWith('Bearer ');
  // authorize pages: send the browser straight back with a code
  if (p === '/dialog' || p.endsWith('/authorize')) { res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=code-${p.split('/')[1]}&state=${encodeURIComponent(u.searchParams.get('state'))}` }); return res.end(); }
  if (p === '/graph/oauth/access_token') return json(res, 200, { access_token: `fb-${u.searchParams.get('grant_type') ?? 'short'}` });
  if (p === '/graph/me/accounts') return json(res, 200, { data: [{ id: '1001', name: 'Vastu Page', access_token: 'page-token-1001' }, { id: '1002', name: 'Course Page', access_token: 'page-token-1002' }] });
  let m;
  if ((m = p.match(/^\/graph\/(\d+)\/subscribed_apps$/))) { if (req.method === 'POST') fb.subscribed.push(m[1]); else fb.unsubscribed.push(m[1]); return json(res, 200, { success: true }); }
  if ((m = p.match(/^\/graph\/(\d+)\/leadgen_forms$/))) return json(res, 200, { data: [{ id: '777', name: 'Course form', status: 'ACTIVE' }] });
  if ((m = p.match(/^\/graph\/(lg\w+)$/))) { if (fb.fail) return json(res, 500, { error: { message: 'down' } }); if (req.headers.authorization !== 'Bearer page-token-1001' && req.headers.authorization !== 'Bearer page-token-1002') return json(res, 401, { error: { message: 'bad token' } }); return json(res, 200, fb.leads[m[1]] ?? { error: { message: 'none' } }); }
  // Google
  if (p === '/google/token' || p === '/microsoft/token') { const f = new URLSearchParams(raw); if (f.get('grant_type') === 'refresh_token') { gmail.refreshes++; return gmail.refuse ? json(res, 400, { error: 'invalid_grant' }) : json(res, 200, { access_token: 'fresh', expires_in: 3600 }); } return json(res, 200, { access_token: f.get('code') === 'code-google' ? 'short-lived' : 'ms-token', refresh_token: 'r1', expires_in: f.get('code') === 'code-google' ? 1 : 3600 }); }
  if (p === '/google/userinfo') return json(res, 200, { email: 'neha@gmail.example' });
  if (p === '/microsoft/userinfo') return json(res, 200, { preferred_username: 'Neha@Outlook.Example' });
  if (!authed) return json(res, 401, {});
  if (gmail.rateLimited && p.startsWith('/google/gmail')) return json(res, 403, { error: { message: 'userRateLimitExceeded' } });
  if (gmail.refuse && p.startsWith('/google/gmail')) return json(res, 401, {});
  if (p === '/google/gmail/v1/users/me/messages') return json(res, 200, { messages: gmail.messages.map((x) => ({ id: x.id })) });
  if (p === '/google/gmail/v1/users/me/messages/send') { const mime = Buffer.from(JSON.parse(raw).raw, 'base64url').toString(); gmail.sent.push(mime); return json(res, 200, { id: `sent${gmail.sent.length}` }); }
  if ((m = p.match(/^\/google\/gmail\/v1\/users\/me\/messages\/(\w+)$/))) {
    const x = gmail.messages.find((y) => y.id === m[1]);
    const headers = [{ name: 'From', value: x.from }, { name: 'To', value: x.to }, { name: 'Subject', value: x.subject }];
    if (u.searchParams.get('format') === 'full') { gmail.bodiesRead.push(x.id); return json(res, 200, { id: x.id, internalDate: String(x.at), payload: { mimeType: 'multipart/alternative', headers, parts: [{ mimeType: 'text/plain', body: { data: b64(x.body) } }] } }); }
    return json(res, 200, { id: x.id, internalDate: String(x.at), payload: { headers } });
  }
  if (p === '/microsoft/me/messages' && req.method === 'POST') { const d = JSON.parse(raw); graph.sent.push(d); return json(res, 201, { id: `draft${graph.sent.length}` }); }
  if (p === '/microsoft/me/messages') return json(res, 200, { value: graph.messages.map((x) => ({ id: x.id, subject: x.subject, from: { emailAddress: { address: x.from } }, toRecipients: [{ emailAddress: { address: x.to } }], receivedDateTime: new Date(x.at).toISOString() })) });
  if ((m = p.match(/^\/microsoft\/me\/messages\/(\w+)\/send$/))) return json(res, 202, {});
  if ((m = p.match(/^\/microsoft\/me\/messages\/(\w+)$/))) { graph.bodiesRead.push(m[1]); return json(res, 200, { body: { contentType: 'text', content: graph.messages.find((y) => y.id === m[1]).body } }); }
  json(res, 404, {});
});
await new Promise((r) => server.listen(4597, r));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const WS = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = WS['Vastu Consultation / Audit'], COURSE = WS['Course / Software'];
const users = (await call('/api/v1/users', { token: admin })).body;
const uid = (e) => users.find((u) => u.email === e).id;
const ARJUN = uid('rm@mycompany.local'), NEHA = uid('manager@mycompany.local');
const post = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'POST', body: body ?? {} });
const get = (p, token, workspace = VASTU) => call(p, { token, workspace });
const mob = (n) => `9${String(stamp).slice(-8)}${n}`;

// ── Booking links ──
const everyDay = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [[600, 720]]])); // 10:00 to 12:00 IST
const mk = (token, body) => post('/api/v1/booking-links', token, { title: 'Site visit', durationMin: 30, bufferMin: 15, noticeHours: 1, horizonDays: 14, hours: everyDay, ...body });
const link = (await mk(rm, {})).body;
check('a salesperson creates their own booking link', !!link.slug && link.hostId === ARJUN, link);
check('they cannot create one for someone else', (await mk(rm, { hostId: NEHA })).body.code === 'HOST_NOT_ALLOWED');
const forNeha = await mk(manager, { title: 'Manager slot', hostId: NEHA });
check('a manager can create one for a colleague', forNeha.status === 201);
check('an auditor cannot manage booking links', (await mk(auditor, {})).status === 403);
check('an end time before the start is refused', (await mk(rm, { hours: { 1: [[700, 600]] } })).status === 400);
check('titles get a unique address', (await mk(rm, {})).body.slug !== link.slug);
check('a salesperson sees only their own links', (await get('/api/v1/booking-links', rm)).body.every((l) => l.hostId === ARJUN));
check('a manager sees everyone in the business line', (await get('/api/v1/booking-links', manager)).body.some((l) => l.hostId === ARJUN));
check('another organization cannot see the link', (await call(`/public/booking/abc/${link.slug}`, { tenant: null })).status === 404);

const page = (await call(`/public/booking/mycompany/${link.slug}`, { tenant: null })).body;
check('the public page lists free times', page.days?.length >= 13 && page.host.length > 0, page);
const first = page.days[1].slots;
const ist = (s) => new Date(s).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
check('times follow the weekly hours in IST', ist(first[0]) === '10:00' && ist(first.at(-1)) === '11:30', first.map(ist));
check('the first slots respect minimum notice', new Date(page.days[0].slots[0]).getTime() >= Date.now() + 3_500_000);

const SLOT = page.days[1].slots[1];
const book = (slot, n, extra = {}, slug = link.slug) => call(`/public/booking/mycompany/${slug}`, { tenant: null, method: 'POST', body: { name: `Booker ${n}`, mobile: mob(n), email: `booker${n}.${stamp}@example.com`, startAt: slot, ...extra } });
const two = await Promise.all([book(SLOT, 1), book(SLOT, 2)]);
check('two people racing for one time: only one gets it', two.filter((r) => r.status === 200).length === 1 && two.filter((r) => r.body.code === 'SLOT_TAKEN').length === 1, two.map((r) => r.body));
const winner = two.find((r) => r.status === 200).body;
const after = (await call(`/public/booking/mycompany/${link.slug}`, { tenant: null })).body.days.find((d) => d.date === page.days[1].date);
check('the booked time and its buffer disappear', !after.slots.includes(SLOT) && !after.slots.includes(page.days[1].slots[0]) && !after.slots.includes(page.days[1].slots[2]), after.slots.map(ist));
check('a time outside the hours is refused', (await book(new Date(new Date(SLOT).getTime() + 12 * 3_600_000).toISOString(), 3)).body.code === 'SLOT_TAKEN');
check('a hidden-field bot gets no booking', (await book(page.days[2].slots[0], 4, { _hp: 'x' })).body.cancelToken === undefined);
check('a bad mobile number books nothing', (await book(page.days[2].slots[0], 5, { mobile: '12' })).status === 400);
check('that time stays free', (await call(`/public/booking/mycompany/${link.slug}`, { tenant: null })).body.days.find((d) => d.date === page.days[2].date).slots.includes(page.days[2].slots[0]));
const entries = (await get(`/api/v1/booking-links/${link.id}/bookings`, rm)).body;
const entry = entries.find((b) => b.status === 'booked');
check('the booking is linked to a lead', !!entry?.leadId, entries);
const tasks = (await get(`/api/v1/tasks?from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 9 * 86_400_000).toISOString())}`, rm)).body;
const list = Array.isArray(tasks) ? tasks : tasks.items ?? tasks.tasks ?? [];
check('the host gets a meeting on the calendar', list.some((t) => t.type === 'meeting' && t.leadId === entry.leadId && new Date(t.dueAt).toISOString() === SLOT), tasks);
const mail = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:booker`)}&limit=5`).then((r) => r.json());
check('the visitor is emailed a confirmation', mail.messages?.some((m) => m.To[0].Address.includes(String(stamp)) && m.Subject.includes('booked')), mail.messages?.length);
const c = await call(`/public/booking/mycompany/cancel/${winner.cancelToken}`, { tenant: null });
check('the cancel link shows the meeting without changing it', c.body.status === 'booked' && c.body.canCancel === true, c.body);
check('a wrong cancel link finds nothing', (await call('/public/booking/mycompany/cancel/nope', { tenant: null })).status === 404);
const cancelled = await call(`/public/booking/mycompany/cancel/${winner.cancelToken}`, { tenant: null, method: 'POST' });
check('the visitor can cancel', cancelled.body.status === 'cancelled', cancelled.body);
check('a cancelled time is free again', (await call(`/public/booking/mycompany/${link.slug}`, { tenant: null })).body.days.find((d) => d.date === page.days[1].date).slots.includes(SLOT));
await call(`/api/v1/booking-links/${link.id}`, { token: rm, workspace: VASTU, method: 'PATCH', body: { isActive: false } });
check('a link turned off stops working', (await call(`/public/booking/mycompany/${link.slug}`, { tenant: null })).status === 404);

// ── Connecting: the state must match this browser ──
const connect = async (path, token, workspace, tenant = 'mycompany') => {
  const s = await call(path, { tenant, token, workspace, method: 'POST', body: {} });
  const cookie = (s.headers.get('set-cookie') ?? '').split(';')[0];
  const provider = await fetch(s.body.url, { redirect: 'manual' });
  return { cookie, callback: provider.headers.get('location'), start: s };
};
const finish = async ({ cookie, callback }, useCookie = true) => { const r = await fetch(callback, { redirect: 'manual', headers: useCookie ? { Cookie: cookie } : {} }); return r.headers.get('location') ?? ''; };

check('a salesperson cannot connect Facebook', (await call('/api/v1/connected/facebook/start', { token: rm, workspace: VASTU, method: 'POST', body: {} })).status === 403);
const fbConn = await connect('/api/v1/connected/facebook/start', admin);
check('a return link without this browser\'s cookie is refused', (await finish(fbConn, false)).includes('STATE_INVALID'));
const fbConn2 = await connect('/api/v1/connected/facebook/start', admin);
check('connecting Facebook lists the pages', (await finish(fbConn2)).includes('FACEBOOK_OK'));
const pagesRes = (await call('/api/v1/connected/facebook', { token: admin })).body;
const P1 = pagesRes.pages.find((p) => p.pageId === '1001'), P2 = pagesRes.pages.find((p) => p.pageId === '1002');
check('pages wait for a business line', P1?.status === 'pending', pagesRes);
check('page tokens never reach the browser', !JSON.stringify(pagesRes).includes('page-token') && !JSON.stringify(pagesRes).includes('tokenEncrypted'));
const route = (id, body, token = admin) => call(`/api/v1/connected/facebook/pages/${id}`, { token, method: 'PATCH', body });
check('turning a page on subscribes it at Facebook', (await route(P1.id, { workspaceId: VASTU, formRoutes: { 777: COURSE } })).body.status === 'active' && fb.subscribed.includes('1001'));
const abcConn = await connect('/api/v1/connected/facebook/start', abc, undefined, 'abc').catch(() => null);

const sign = (raw) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const event = (leadgen, form, page = '1001') => JSON.stringify({ object: 'page', entry: [{ id: page, changes: [{ field: 'leadgen', value: { page_id: page, form_id: form, leadgen_id: leadgen } }] }] });
const hook = (raw, sig = sign(raw)) => call('/connect/meta/webhook', { tenant: null, method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': sig } });
check('Facebook\'s webhook check needs the right token', (await call('/connect/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=7', { tenant: null })).status === 404);
check('Facebook\'s webhook check echoes the challenge', String((await call(`/connect/meta/webhook?hub.mode=subscribe&hub.verify_token=${process.env.META_VERIFY_TOKEN ?? 'test-verify'}&hub.challenge=7`, { tenant: null })).body) === '7');
const lg = (name, phone, extra = []) => ({ field_data: [{ name: 'full_name', values: [name] }, { name: 'phone_number', values: [phone] }, { name: 'email', values: [`${name.replace(/ /g, '.').toLowerCase()}.${stamp}@example.com`] }, ...extra] });
fb.leads.lg1 = lg('Facebook Asha', `+91${mob(6).slice(-10)}`, [{ name: 'property_type', values: ['Home'] }, { name: 'best_time_to_call', values: ['Evening'] }]);
fb.leads.lg2 = lg('Facebook Course', mob(7));
check('an unsigned webhook is refused', (await hook(event('lg1'), 'sha256=00')).status === 401);
check('a signed webhook is accepted', (await hook(event('lg1', '555'))).status === 200);
const findLead = async (q, ws, token = admin) => { const r = (await get(`/api/v1/leads?q=${encodeURIComponent(q)}`, token, ws)).body; return (r.items ?? r.leads ?? r)[0]; };
const asha = await findLead('Facebook Asha', VASTU);
check('the lead arrives in the page\'s business line', !!asha, asha);
const ashaFull = (await get(`/api/v1/leads/${asha.id}`, admin)).body;
check('a matching question fills the custom field', (ashaFull.customFields ?? ashaFull.lead?.customFields)?.property_type === 'Home', ashaFull.customFields);
check('other answers are kept on the lead', JSON.stringify(ashaFull).includes('Evening'), Object.keys(ashaFull));
await hook(event('lg1', '555'));
const twice = (await get(`/api/v1/leads?q=${encodeURIComponent('Facebook Asha')}`, admin)).body;
check('the same lead sent twice is stored once', (twice.items ?? twice.leads ?? twice).length === 1, Object.keys(twice));
await hook(event('lg2', '777'));
check('a form can go to a different business line', !!(await findLead('Facebook Course', COURSE)));
fb.leads.lg3 = lg('Facebook Retry', mob(8));
fb.fail = true;
check('if Facebook cannot be reached we ask it to resend', (await hook(event('lg3', '555'))).status === 502);
fb.fail = false;
check('the resend then works', (await hook(event('lg3', '555'))).status === 200 && !!(await findLead('Facebook Retry', VASTU)));
fb.leads.lg4 = { field_data: [{ name: 'full_name', values: ['No Phone'] }] };
check('a lead with no mobile is not lost or retried forever', (await hook(event('lg4', '555'))).status === 200);
check('the page shows why it failed', (await call('/api/v1/connected/facebook', { token: admin })).body.pages.find((p) => p.pageId === '1001').lastError?.includes('Mobile'));
check('Facebook shows as active in Integrations', (await call('/api/v1/integrations', { token: admin })).body.find?.((i) => i.key === 'facebook_leads')?.status === 'active');
check('pages of another org are not visible', !(await call('/api/v1/connected/facebook', { tenant: 'abc', token: abc })).body.pages?.some((p) => p.pageId === '1001') );
check('another org cannot take a page already in use', abcConn ? await (async () => { await finish(abcConn); const ap = (await call('/api/v1/connected/facebook', { tenant: 'abc', token: abc })).body.pages.find((p) => p.pageId === '1001'); if (!ap) return false; const abcWs = (await call('/api/v1/auth/me', { tenant: 'abc', token: abc })).body.workspaces[0].id; return (await call(`/api/v1/connected/facebook/pages/${ap.id}`, { tenant: 'abc', token: abc, method: 'PATCH', body: { workspaceId: abcWs } })).body.code === 'PAGE_TAKEN'; })() : false);
check('disconnecting removes the access', (await call(`/api/v1/connected/facebook/pages/${P1.id}/disconnect`, { token: admin, method: 'POST', body: {} })).status === 200 && fb.unsubscribed.includes('1001'));
fb.leads.lg5 = lg('Facebook After', mob(9));
await hook(event('lg5', '555'));
check('a disconnected page brings no more leads', !(await findLead('Facebook After', VASTU)));
check('existing leads stay after disconnecting', !!(await findLead('Facebook Asha', VASTU)));

// ── Mailboxes ──
const CUSTOMER = `mailcustomer.${stamp}@example.com`;
const created = await post('/api/v1/leads', manager, { name: 'Mail Customer', mobile: `8${String(stamp).slice(-9)}`, email: CUSTOMER, customFields: { property_type: 'Home' }, ownerId: NEHA });
const LEAD = created.body.id ?? created.body.lead?.id;
check('(setup) a lead for the mail checks', !!LEAD, created.body);
const OTHER = `arjuncustomer.${stamp}@example.com`;
await post('/api/v1/leads', rm, { name: 'Arjun Only', mobile: `7${String(stamp).slice(-9)}`, email: OTHER, customFields: { property_type: 'Home' }, ownerId: ARJUN });
const now = Date.now();
gmail.messages = [
  { id: 'g1', from: `Mail Customer <${CUSTOMER}>`, to: 'neha@gmail.example', subject: 'Interested in the audit', body: 'Please call me', at: now - 3_600_000 },
  { id: 'g2', from: 'neha@gmail.example', to: CUSTOMER, subject: 'Re: audit', body: 'Will do', at: now - 1_800_000 },
  { id: 'g3', from: 'friend@example.com', to: 'neha@gmail.example', subject: 'Private', body: 'Not for the CRM', at: now - 600_000 },
];
const gConn = await connect('/api/v1/connected/mail/google/start', manager, VASTU);
check('connecting Gmail works', (await finish(gConn)).includes('MAIL_OK'));
const boxes = (await get('/api/v1/connected/mail', manager)).body;
const G = boxes.accounts.find((a) => a.provider === 'google');
check('the mailbox shows as connected', G?.email === 'neha@gmail.example' && G.status === 'active', boxes);
check('tokens never reach the browser', !JSON.stringify(boxes).includes('tokens'));
check('someone else\'s mailbox cannot be read', (await post(`/api/v1/connected/mail/${G.id}/sync`, rm)).status === 404);
const s1 = (await post(`/api/v1/connected/mail/${G.id}/sync`, manager)).body;
check('an expired token is refreshed', gmail.refreshes >= 1, gmail.refreshes);
check('mail with customers is stored', s1.stored === 2, s1);
check('other mail bodies are never downloaded', !gmail.bodiesRead.includes('g3') && gmail.bodiesRead.includes('g1'), gmail.bodiesRead);
const log = (await get(`/api/v1/leads/${LEAD}/outreach`, manager)).body;
check('the email shows on the lead, in and out', log.messages.some((m) => m.direction === 'in' && m.subject === 'Interested in the audit' && m.body === 'Please call me') && log.messages.some((m) => m.direction === 'out' && m.subject === 'Re: audit'), log.messages);
check('nothing private was stored', !JSON.stringify(log).includes('Not for the CRM'));
check('checking again stores nothing twice', (await post(`/api/v1/connected/mail/${G.id}/sync`, manager)).body.stored === 0);
gmail.messages.push({ id: 'g4', from: `<${OTHER}>`, to: 'neha@gmail.example', subject: 'Not hers', body: 'Secret', at: now - 300_000 });
const manager2 = await login('rm2@mycompany.local');
const W2 = (await call('/api/v1/auth/me', { token: manager2 })).body.workspaces[0].id;
const rmConn = await connect('/api/v1/connected/mail/google/start', manager2, W2);
await finish(rmConn);
const G2 = (await get('/api/v1/connected/mail', manager2, W2)).body.accounts[0];
gmail.messages = gmail.messages.filter((x) => x.id === 'g4');
const s2 = (await post(`/api/v1/connected/mail/${G2.id}/sync`, manager2, {}, W2)).body;
check('mail with a customer the person cannot see is not stored', s2.stored === 0 && !gmail.bodiesRead.includes('g4'), s2);

// Tracked send
const sendEmail = (body, token = manager, lead = LEAD) => post(`/api/v1/connected/leads/${lead}/email`, token, body);
const sent = await sendEmail({ subject: 'Your audit report', body: 'Hello\nSee https://example.com/report?a=1 <b>now</b>', track: true });
check('email goes out from the person\'s own mailbox', sent.status === 201 && sent.body.status === 'sent' && gmail.sent.length === 1, sent.body);
const mime = gmail.sent[0].replace(/=\r?\n/g, '');
check('the sender is their own address', /From: neha@gmail\.example/.test(mime));
check('the message text is escaped in the HTML part', mime.includes('&lt;b&gt;') || Buffer.from(mime).includes('&lt;b&gt;'), mime.slice(0, 600));
const htmlMime = (() => { const b = gmail.sent[0].split(/Content-Type: text\/html[^\n]*\n(?:Content-Transfer-Encoding: (\S+)\r?\n)?\r?\n/); return b; })();
const token = sent.body.trackToken;
check('a tracking token is set', !!token);
check('the customer\'s address came from the record', new RegExp(`To: ${CUSTOMER.replace(/[.]/g, '\\.')}`).test(mime));
const openR = await fetch(`${API}/t/o/mycompany/${token}.gif`);
check('the tracking pixel is an image', openR.status === 200 && openR.headers.get('content-type') === 'image/gif');
await fetch(`${API}/t/o/mycompany/${token}.gif`);
let after2 = (await get(`/api/v1/leads/${LEAD}/outreach`, manager)).body.messages.find((m) => m.subject === 'Your audit report');
check('opens are counted', after2.openCount === 2 && !!after2.openedAt, after2);
const notes = (await call('/api/v1/notifications', { token: manager, workspace: VASTU })).body;
check('the sender is told once when it is first opened', JSON.stringify(notes).split('Email opened: Your audit report').length === 2, JSON.stringify(notes).slice(0, 300));
const bad = await fetch(`${API}/t/c/mycompany/${token}?u=${encodeURIComponent('https://evil.example')}&s=00`, { redirect: 'manual' });
check('a forged link cannot redirect anywhere', bad.status === 404);
const linkMatch = gmail.sent[0].replace(/=\r?\n/g, '').match(/\/t\/c\/mycompany\/[^"]+/) ?? Buffer.from(gmail.sent[0].split('\n\n').join('')).toString().match(/x^/);
const bodyPart = (() => { const m = gmail.sent[0].match(/text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/); if (!m) return ''; return /base64/.test(gmail.sent[0].match(/text\/html[\s\S]*?\r?\n\r?\n/)[0]) ? Buffer.from(m[1], 'base64').toString() : m[1].replace(/=\r?\n/g, '').replace(/=3D/g, '=').replace(/&amp;/g, '&'); })();
const href = bodyPart.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
check('links in the email are tracked', !!href && href.includes('/t/c/mycompany/'), bodyPart.slice(0, 300));
const click = href ? await fetch(href, { redirect: 'manual' }) : { status: 0, headers: new Headers() };
check('a click goes on to the original address', click.status === 302 && click.headers.get('location') === 'https://example.com/report?a=1', click.status);
after2 = (await get(`/api/v1/leads/${LEAD}/outreach`, manager)).body.messages.find((m) => m.subject === 'Your audit report');
check('clicks are counted', after2.clickCount === 1, after2);
const noTrack = await sendEmail({ subject: 'Plain one', body: 'No tracking https://example.com', track: false });
check('tracking can be switched off', noTrack.body.trackToken === null && !gmail.sent[1].includes('/t/o/'), noTrack.body);
check('sending to a lead you cannot see is refused', (await sendEmail({ subject: 'x', body: 'y' }, rm)).status === 404);
check('sending without a mailbox is refused', (await post(`/api/v1/connected/leads/${(await findLead('Arjun Only', VASTU, rm)).id}/email`, rm, { subject: 'x', body: 'y' })).body.code === 'NO_MAILBOX');
await post(`/api/v1/leads/${LEAD}/outreach/opt-out`, manager, { channel: 'email', optedOut: true });
check('a customer who opted out is not emailed', (await sendEmail({ subject: 'x', body: 'y' })).body.code === 'OPTED_OUT');
await post(`/api/v1/leads/${LEAD}/outreach/opt-out`, manager, { channel: 'email', optedOut: false });

// Outlook
graph.messages = [{ id: 'm1', from: CUSTOMER, to: 'neha@outlook.example', subject: 'From Outlook', body: 'Hello from Outlook', at: now - 900_000 }, { id: 'm2', from: 'friend@example.com', to: 'neha@outlook.example', subject: 'Private two', body: 'no', at: now - 800_000 }];
const mConn = await connect('/api/v1/connected/mail/microsoft/start', manager, VASTU);
check('connecting Outlook works', (await finish(mConn)).includes('MAIL_OK'));
const M = (await get('/api/v1/connected/mail', manager)).body.accounts.find((a) => a.provider === 'microsoft');
check('Outlook addresses are matched regardless of case', M.email === 'neha@outlook.example', M);
check('Outlook mail is stored, private mail is not', (await post(`/api/v1/connected/mail/${M.id}/sync`, manager)).body.stored === 1 && !graph.bodiesRead.includes('m2'));

graph.messages.push({ id: 'm3', from: CUSTOMER, to: 'neha@outlook.example', subject: 'A new question', body: 'One more thing', at: Date.now() + 60_000 });
await post(`/api/v1/connected/mail/${M.id}/sync`, manager);
const told = JSON.stringify((await call('/api/v1/notifications', { token: manager, workspace: VASTU })).body);
check('the lead owner is told about new email', told.includes('Email from Mail Customer'), told.slice(0, 200));
check('older mail found at connection raises no alert', told.split('Email from Mail Customer').length === 2);

// Losing access
gmail.rateLimited = true;
const limited = await post(`/api/v1/connected/mail/${G2.id}/sync`, manager2, {}, W2);
check('a temporary limit is not treated as lost access', !!limited.body.error && (await get('/api/v1/connected/mail', manager2, W2)).body.accounts[0].status === 'active', limited.body);
gmail.rateLimited = false;
gmail.refuse = true;
const dropAccess = await post(`/api/v1/connected/mail/${G2.id}/sync`, manager2, {}, W2);
check('(setup) a second check still runs', dropAccess.status === 201);
check('a withdrawn permission is reported, not silently ignored', !!dropAccess.body.error, dropAccess.body);
check('the mailbox asks to be reconnected', (await get('/api/v1/connected/mail', manager2, W2)).body.accounts[0].status === 'error');
check('the owner is told to reconnect', JSON.stringify((await call('/api/v1/notifications', { token: manager2, workspace: W2 })).body).includes('Reconnect your mailbox'));
check('disconnecting removes the mailbox', (await post(`/api/v1/connected/mail/${G.id}/disconnect`, manager)).status === 200 && !(await get('/api/v1/connected/mail', manager)).body.accounts.some((a) => a.id === G.id));
check('emails stay on the lead after disconnecting', (await get(`/api/v1/leads/${LEAD}/outreach`, manager)).body.messages.some((m) => m.subject === 'Interested in the audit'));
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('connections are audited', audit.includes('mailbox.connected') && audit.includes('facebook_page.disconnected'));
check('no token appears in the audit log', !/page-token|short-lived|ms-token|fresh/.test(audit));

server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
