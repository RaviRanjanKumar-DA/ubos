// End-to-end checks for slice 2.7 (help desk): role access and organization isolation, ticket numbers, SLA targets and the stopped clock, replies
// by email, internal notes, queues, past-target alerts, Customer 360 (also after a merge) and the knowledge base.
// Usage: npm run verify:helpdesk   (API running, freshly seeded, Mailpit on; run `npm run db:seed` afterwards). Takes about 70 seconds.

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const simran = await login('rm2@mycompany.local');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]))['Vastu Consultation / Audit'];
const users = (await call('/api/v1/users', { token: admin })).body;
const uid = (e) => users.find((u) => u.email === e).id;
const ARJUN = uid('rm@mycompany.local'), NEHA = uid('manager@mycompany.local'), KABIR = uid('auditor@mycompany.local');
const post = (p, token, body) => call(p, { token, workspace: VASTU, method: 'POST', body: body ?? {} });
const patch = (p, token, body) => call(p, { token, workspace: VASTU, method: 'PATCH', body });
const get = (p, token) => call(p, { token, workspace: VASTU });

let n = 0;
const stamp = String(Date.now()).slice(-5);
const mkCustomer = async (name, email, ownerId = ARJUN) => {
  const r = await post('/api/v1/leads', admin, { name, mobile: `9830${stamp}${String(++n).padStart(1, '0')}`.slice(0, 10), ...(email ? { email } : {}), customFields: { property_type: 'Home' }, ownerId });
  return (await get(`/api/v1/leads/${r.body.id}`, admin)).body.customerId;
};
const withEmail = await mkCustomer('Help Desk Asha', `asha.${stamp}@example.com`);
const noEmail = await mkCustomer('Help Desk Ravi');
const mk = (token, body) => post('/api/v1/tickets', token, { customerId: withEmail, subject: 'Report not received', ...body });
const one = async (id, token = manager) => (await get(`/api/v1/tickets/${id}`, token)).body;
const near = (d, ms, tol = 8000) => Math.abs(new Date(d).getTime() - Date.now() - ms) < tol;

// ── Access ──
const optM = (await get('/api/v1/tickets/options', manager)).body, optR = (await get('/api/v1/tickets/options', rm)).body;
check('managers can manage and assign; callers can only work', optM.canManage && optM.canAssign && !optR.canManage && !optR.canAssign && optR.canWork, [optM.canManage, optR.canManage]);
check('only people who can work tickets are offered as owners', optM.users.some((u) => u.value === ARJUN) && !optM.users.some((u) => u.value === KABIR), optM.users);
check('an auditor can read but not raise tickets', (await get('/api/v1/tickets', auditor)).status === 200 && (await mk(auditor)).status === 403);

// ── Raising tickets ──
check('an unknown customer is refused', (await mk(rm, { customerId: '00000000-0000-4000-8000-000000000000' })).body.code === 'CUSTOMER_NOT_FOUND');
const nehaCustomer = await mkCustomer('Help Desk Neha Customer', undefined, NEHA);
check('a customer outside your access is refused', (await mk(rm, { customerId: nehaCustomer })).body.code === 'CUSTOMER_NOT_FOUND');
check('a too short subject is refused', (await mk(rm, { subject: 'x' })).status === 400);
const a = await mk(rm, { description: 'Paid last week', category: 'Delivery' });
const A = await one(a.body.id);
check('a caller raises a ticket on a customer', a.status === 201 && a.body.number >= 1 && A.customer.id === withEmail && A.status === 'open', a.body);
check('built-in targets apply until managers set their own', near(A.firstResponseDueAt, 240 * 60_000) && near(A.resolutionDueAt, 1440 * 60_000), [A.firstResponseDueAt, A.resolutionDueAt]);
const abcTicket = await call(`/api/v1/tickets/${a.body.id}`, { tenant: 'abc', token: abc });
const abcList = (await call('/api/v1/tickets?view=all', { tenant: 'abc', token: abc })).body;
check('another organization cannot see the ticket', abcTicket.status === 404 && Array.isArray(abcList) && !abcList.some((t) => t.id === a.body.id), [abcTicket.status, abcList]);
const many = await Promise.all(Array.from({ length: 8 }, () => mk(admin)));
check('tickets raised at the same moment get different numbers', many.every((r) => r.status === 201) && new Set(many.map((r) => r.body.number)).size === 8, many.map((r) => r.body.number ?? r.body));
check('a caller cannot assign to someone else', (await mk(rm, { assigneeId: NEHA })).status === 403);
const mine = await mk(rm, { assigneeId: ARJUN, subject: 'Mine from the start' });
check('a caller can take their own ticket', mine.status === 201);
const toNeha = await mk(manager, { assigneeId: NEHA, subject: 'Neha only' });
const toArjun = await mk(manager, { assigneeId: ARJUN, subject: 'For Arjun' });
check('the new owner is told', JSON.stringify((await get('/api/v1/notifications', rm)).body).includes(`/app/tickets/${toArjun.body.id}`));
check('someone who cannot work tickets cannot own one', (await mk(manager, { assigneeId: KABIR })).body.code === 'INVALID_ASSIGNEE');

// ── Who sees what ──
const listR = (await get('/api/v1/tickets?view=open', rm)).body;
check('a caller sees their tickets and the unassigned queue', listR.some((t) => t.id === a.body.id) && listR.some((t) => t.id === mine.body.id));
check('a caller does not see a colleague’s ticket', !listR.some((t) => t.id === toNeha.body.id) && (await get(`/api/v1/tickets/${toNeha.body.id}`, rm)).status === 404);
check('nor can they change it', (await patch(`/api/v1/tickets/${toNeha.body.id}`, rm, { status: 'closed' })).status === 404);
check('a manager sees every ticket of the business line', (await get('/api/v1/tickets?view=open', manager)).body.some((t) => t.id === toNeha.body.id));
check('people outside the business line cannot open it', [403, 404].includes((await call(`/api/v1/tickets/${a.body.id}`, { token: simran })).status));
check('the Mine view shows only mine', (await get('/api/v1/tickets?view=mine', rm)).body.every((t) => t.assigneeId === ARJUN));
check('the Unassigned view shows nobody’s tickets', (await get('/api/v1/tickets?view=unassigned', rm)).body.every((t) => t.assigneeId === null));
check('search finds by subject and by number', (await get('/api/v1/tickets?q=Mine%20from', manager)).body.length === 1 && (await get(`/api/v1/tickets?q=%23${a.body.number}`, manager)).body[0]?.id === a.body.id);

// ── Conversation ──
const before = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=1`)).json()).total;
const noteR = await post(`/api/v1/tickets/${a.body.id}/messages`, rm, { kind: 'note', body: 'Checking with the audit team' });
let cur = await one(a.body.id);
check('an internal note does not count as a response or email anyone', noteR.body.emailStatus === 'none' && cur.firstRespondedAt === null && (await (await fetch(`${MAILPIT}/api/v1/messages?limit=1`)).json()).total === before, noteR.body);
const reply = await post(`/api/v1/tickets/${a.body.id}/messages`, rm, { kind: 'reply', body: 'We are sending your report today.' });
cur = await one(a.body.id);
check('a reply meets the first response target', reply.body.emailStatus === 'sent' && cur.firstRespondedAt && cur.sla.first === 'met', [reply.body, cur.sla]);
await sleep(500);
const mail = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"Ticket #${a.body.number}"`)}`)).json()).messages ?? [];
check('the customer receives the reply by email', mail.filter((m) => m.To[0].Address === `asha.${stamp}@example.com`).length === 1, mail.length);
check('a reply can stay out of email', (await post(`/api/v1/tickets/${a.body.id}/messages`, rm, { kind: 'reply', body: 'Logged a phone update', email: false })).body.emailStatus === 'none');
const nb = await mk(manager, { customerId: noEmail, subject: 'No email on file' });
check('a customer with no email: the reply is saved here', (await post(`/api/v1/tickets/${nb.body.id}/messages`, manager, { kind: 'reply', body: 'Called and explained' })).body.emailStatus === 'none');
check('an empty message is refused', (await post(`/api/v1/tickets/${a.body.id}/messages`, rm, { kind: 'note', body: ' ' })).status === 400);

// ── Status and clocks ──
const dueBefore = new Date((await one(a.body.id)).resolutionDueAt).getTime();
await patch(`/api/v1/tickets/${a.body.id}`, rm, { status: 'pending' });
cur = await one(a.body.id);
check('waiting on the customer stops the clock', cur.status === 'pending' && cur.sla.resolution === 'paused', cur.sla);
await sleep(2000);
await patch(`/api/v1/tickets/${a.body.id}`, rm, { status: 'open' });
cur = await one(a.body.id);
check('the target moves on by the time spent waiting', new Date(cur.resolutionDueAt).getTime() - dueBefore >= 1900 && new Date(cur.resolutionDueAt).getTime() - dueBefore < 10_000, new Date(cur.resolutionDueAt).getTime() - dueBefore);
await patch(`/api/v1/tickets/${a.body.id}`, rm, { status: 'resolved' });
cur = await one(a.body.id);
check('resolving in time counts as met', cur.resolvedAt && cur.sla.resolution === 'met', cur.sla);
await patch(`/api/v1/tickets/${a.body.id}`, rm, { status: 'open' });
cur = await one(a.body.id);
check('a reopened ticket is live again', cur.resolvedAt === null && cur.status === 'open');
await patch(`/api/v1/tickets/${a.body.id}`, rm, { status: 'closed' });
check('a closed ticket takes no more messages', (await post(`/api/v1/tickets/${a.body.id}/messages`, rm, { kind: 'note', body: 'late' })).body.code === 'TICKET_CLOSED');
check('status changes appear in the conversation', (await one(a.body.id)).messages.filter((m) => m.kind === 'event').length === 5, (await one(a.body.id)).messages.map((m) => m.body));

const p = await mk(manager, { subject: 'Priority change' });
await patch(`/api/v1/tickets/${p.body.id}`, manager, { priority: 'urgent' });
cur = await one(p.body.id);
check('a new priority sets new targets', near(cur.resolutionDueAt, 240 * 60_000) && near(cur.firstResponseDueAt, 30 * 60_000), [cur.resolutionDueAt]);
const q = await mk(manager, { subject: 'Queue pickup' });
check('a caller can pick up an unassigned ticket', (await patch(`/api/v1/tickets/${q.body.id}`, rm, { assigneeId: ARJUN })).status === 200 && (await one(q.body.id)).assigneeId === ARJUN);
check('but cannot hand it to someone else', (await patch(`/api/v1/tickets/${q.body.id}`, rm, { assigneeId: NEHA })).status === 403);

// ── Targets ──
check('a caller cannot change target times', (await call('/api/v1/tickets/sla', { token: rm, workspace: VASTU, method: 'PUT', body: { policies: [{ priority: 'low', firstResponseMin: 1, resolutionMin: 1 }] } })).status === 403);
const put = (policies) => call('/api/v1/tickets/sla', { token: manager, workspace: VASTU, method: 'PUT', body: { policies } });
check('a resolution target shorter than the first response is refused', (await put([{ priority: 'low', firstResponseMin: 10, resolutionMin: 5 }])).body.code === 'INVALID_SLA');
check('a manager sets target times', (await put([{ priority: 'low', firstResponseMin: 1, resolutionMin: 1 }])).status === 200 && (await get('/api/v1/tickets/sla', rm)).body.find((x) => x.priority === 'low').resolutionMin === 1);

// ── Past target ──
const late = await mk(manager, { subject: 'Going to be late', priority: 'low', assigneeId: ARJUN });
await sleep(62_000);
await call('/api/v1/automation/run-now', { token: admin, method: 'POST', body: {} });
cur = await one(late.body.id);
check('a ticket past its time shows as overdue', cur.sla.overdue === true && cur.sla.resolution === 'breached', cur.sla);
check('it appears in the Past target view and the count', (await get('/api/v1/tickets?view=overdue', manager)).body.some((t) => t.id === late.body.id) && (await get('/api/v1/tickets/summary', manager)).body.overdue >= 1);
const alerts = async (t) => JSON.stringify((await get('/api/v1/notifications', t)).body).split(`Ticket #${late.body.number} is past its target`).length - 1;
check('the owner and the managers are alerted', (await alerts(rm)) === 1 && (await alerts(manager)) === 1, [await alerts(rm), await alerts(manager)]);
await call('/api/v1/automation/run-now', { token: admin, method: 'POST', body: {} });
check('the alert is sent only once', (await alerts(rm)) === 1, await alerts(rm));

// ── Customer 360 ──
check('the customer’s record lists their tickets', (await get(`/api/v1/tickets?view=all&customerId=${withEmail}`, manager)).body.some((t) => t.id === a.body.id));
const dup = await mkCustomer('Help Desk Duplicate');
const dupT = await mk(manager, { customerId: dup, subject: 'On the duplicate' });
const merged = await post('/api/v1/customers/merge', admin, { primaryId: noEmail, duplicateId: dup });
check('after a merge, the kept record shows the merged customer’s tickets', merged.status < 300 && (await get(`/api/v1/tickets?view=all&customerId=${noEmail}`, manager)).body.some((t) => t.id === dupT.body.id), merged.body);

// ── Knowledge base ──
const kb = (t, body) => post('/api/v1/kb', t, body);
check('a caller cannot write articles', (await kb(rm, { title: 'Nope', body: 'x' })).status === 403);
const art = await kb(manager, { title: 'Report delivery times', body: 'Audit reports reach you within five working days.', category: 'Delivery' });
check('a manager writes a draft', art.status === 201);
check('callers do not see drafts', !(await get('/api/v1/kb', rm)).body.articles.some((x) => x.id === art.body.id) && (await get(`/api/v1/kb/${art.body.id}`, rm)).status === 404);
await patch(`/api/v1/kb/${art.body.id}`, manager, { status: 'published' });
check('once published, the team can read it', (await get(`/api/v1/kb/${art.body.id}`, rm)).body.body.includes('five working days'));
check('search looks inside the answer', (await get('/api/v1/kb?q=working%20days', rm)).body.articles.length === 1 && (await get('/api/v1/kb?q=zzzz', rm)).body.articles.length === 0);
check('a caller cannot edit it', (await patch(`/api/v1/kb/${art.body.id}`, rm, { title: 'Changed' })).status === 403);
await patch(`/api/v1/kb/${art.body.id}`, manager, { archived: true });
check('an archived article disappears', !(await get('/api/v1/kb', manager)).body.articles.some((x) => x.id === art.body.id) && (await get(`/api/v1/kb/${art.body.id}`, manager)).status === 404);

const logs = (await call('/api/v1/audit-logs', { token: admin })).body;
const acts = new Set((logs.items ?? logs).map((l) => l.action));
check('help desk actions are audited', ['ticket.created', 'ticket.updated', 'ticket.replied', 'ticket.noted', 'ticket.sla_updated', 'kb.created', 'kb.archived'].every((x) => acts.has(x)), [...acts].slice(0, 20));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll help desk checks passed');
process.exit(failures ? 1 : 0);
