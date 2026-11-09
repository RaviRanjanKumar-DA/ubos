// End-to-end checks for slice 2.9: territory routing, scoring by rules, moving leads between business lines, property portals.
// Usage: npm run verify:leadrules   (API running, freshly seeded; run `npm run db:seed` afterwards).

const API = process.env.API_URL ?? 'http://localhost:4000';
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
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const WS = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = WS['Vastu Consultation / Audit'], COURSE = WS['Course / Software'], LOGO = WS['Logo Designing'];
const users = (await call('/api/v1/users', { token: admin })).body;
const uid = (e) => users.find((u) => u.email === e).id;
const ARJUN = uid('rm@mycompany.local'), NEHA = uid('manager@mycompany.local');
const post = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'POST', body: body ?? {} });
const patch = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'PATCH', body });
const get = (p, token, workspace = VASTU) => call(p, { token, workspace });
const stamp = Date.now();
let n = 0;
const mob = () => `9${String(stamp).slice(-7)}${String(++n).padStart(2, '0')}`;

// Incoming leads arrive through a web form, the same path as every outside channel.
const form = (await post('/api/v1/forms', admin, { name: `Rules ${stamp}`, title: 'Enquiry', source: 'website', duplicateMode: 'new_lead', fields: [{ target: 'name', label: 'Name', required: true }, { target: 'mobile', label: 'Mobile', required: true }, { target: 'city', label: 'City', required: false }, { target: 'cf:property_type', label: 'Type', required: false }] })).body;
check('(setup) a web form', !!form.slug, form);
const arrive = async (city, extra = {}) => {
  const name = `Rule Lead ${++n} ${stamp}`;
  const r = await call(`/public/forms/mycompany/${form.slug}`, { tenant: null, method: 'POST', body: { name, mobile: mob(), city, ...extra } });
  if (r.status !== 200) return { error: r.body };
  await sleep(1200); // form submissions are rate limited per IP: 10 a minute
  const list = (await get(`/api/v1/leads?q=${encodeURIComponent(name)}`, admin)).body;
  return (list.items ?? list.leads ?? list)[0];
};
const ownerOf = (l) => l?.owner?.id ?? l?.ownerId;

// Routing
check('a salesperson cannot change routing rules', (await post('/api/v1/routing-rules', rm, { name: 'x y', conditions: [{ field: 'city', op: 'eq', value: 'a' }], userIds: [ARJUN] })).status === 403);
check('an auditor cannot either', (await get('/api/v1/routing-rules', auditor)).status === 403);
check('a rule needs a condition', (await post('/api/v1/routing-rules', manager, { name: 'No cond', conditions: [], userIds: [ARJUN] })).status === 400);
check('a rule needs people', (await post('/api/v1/routing-rules', manager, { name: 'No one', conditions: [{ field: 'city', op: 'eq', value: 'a' }], userIds: [] })).status === 400);
check('someone outside the business line is refused', (await post('/api/v1/routing-rules', manager, { name: 'Auditor rule', conditions: [{ field: 'city', op: 'eq', value: 'a' }], userIds: [uid('auditor@mycompany.local')] })).body.code === 'INVALID_USER');
check('a condition needs a value', (await post('/api/v1/routing-rules', manager, { name: 'No value', conditions: [{ field: 'city', op: 'eq' }], userIds: [ARJUN] })).status === 400);
const west = (await post('/api/v1/routing-rules', manager, { name: 'West', conditions: [{ field: 'city', op: 'in', value: 'Pune, Nashik' }], userIds: [NEHA] })).body;
const home = (await post('/api/v1/routing-rules', manager, { name: 'Homes', conditions: [{ field: 'city', op: 'eq', value: 'Goa' }, { field: 'cf:property_type', op: 'eq', value: 'Home' }], userIds: [ARJUN] })).body;
check('a manager adds routing rules', !!west.id && !!home.id, west);
check('another organization cannot see them', !(await call('/api/v1/routing-rules', { tenant: 'abc', token: abc, workspace: VASTU })).body?.some?.((r) => r.id === west.id));
const a = await arrive('Pune');
check('a city in the territory goes to its person', ownerOf(a) === NEHA, a);
check('matching ignores capitals', ownerOf(await arrive('NASHIK')) === NEHA);
check('a custom field can route too', ownerOf(await arrive('Goa', { 'cf:property_type': 'Home' })) === ARJUN);
const none = await arrive('Goa', { 'cf:property_type': 'Office' });
check('all conditions must match, otherwise normal assignment applies', !!none && (await get('/api/v1/routing-rules', manager)).body.find((r) => r.id === home.id).hits === 1, none);
const first = (await get('/api/v1/routing-rules', manager)).body;
check('the routed count goes up', first.find((r) => r.id === west.id).hits === 2);
const ov = (await post('/api/v1/routing-rules', manager, { name: 'Pune to Arjun', conditions: [{ field: 'city', op: 'eq', value: 'Pune' }], userIds: [ARJUN] })).body;
check('rules can be reordered', (await post('/api/v1/routing-rules/order', manager, { ids: [ov.id, west.id, home.id] })).status === 201);
check('the first matching rule wins', ownerOf(await arrive('Pune')) === ARJUN);
await patch(`/api/v1/routing-rules/${ov.id}`, manager, { isActive: false });
check('a paused rule is skipped', ownerOf(await arrive('Pune')) === NEHA);
await patch(`/api/v1/routing-rules/${ov.id}`, manager, { isArchived: true });
check('an archived rule disappears', !(await get('/api/v1/routing-rules', manager)).body.some((r) => r.id === ov.id));
check('an out-of-date order is refused', (await post('/api/v1/routing-rules/order', manager, { ids: [west.id] })).status === 400);

// Scoring
const sc = (body, token = manager) => post('/api/v1/score-rules', token, body);
check('a salesperson cannot change scoring rules', (await sc({ name: 'x y', conditions: [{ field: 'source', op: 'eq', value: 'website' }], points: 5 }, rm)).status === 403);
check('zero points is refused', (await sc({ name: 'Zero', conditions: [{ field: 'source', op: 'eq', value: 'website' }], points: 0 })).status === 400);
const web = (await sc({ name: 'From website', conditions: [{ field: 'source', op: 'eq', value: 'website' }], points: 10 })).body;
const type = (await sc({ name: 'Is a home', conditions: [{ field: 'cf:property_type', op: 'eq', value: 'Home' }], points: 25 })).body;
const noEmail = (await sc({ name: 'No email', conditions: [{ field: 'email', op: 'empty' }], points: -5 })).body;
check('a manager adds scoring rules', !!web.id && !!type.id && !!noEmail.id, web);
const scored = await arrive('Delhi', { 'cf:property_type': 'Home' });
await sleep(4500);
const scoreOf = async (id, ws = VASTU) => (await get(`/api/v1/leads/${id}/score`, admin, ws)).body;
let s = await scoreOf(scored.id);
check('a new lead is scored by every matching rule', s.score === 30 && s.rules.length === 3, s);
check('the breakdown names each rule', s.rules.some((r) => r.name === 'Is a home' && r.points === 25));
const edited = await call(`/api/v1/leads/${scored.id}/fields`, { token: admin, workspace: VASTU, method: 'PATCH', body: { customFields: { property_type: 'Office' } } });
await sleep(4000);
s = await scoreOf(scored.id);
check('points go when a rule stops matching', s.score === 5 && s.rules.length === 2, { s, edited: edited.status });
const old = await arrive('Delhi2', { 'cf:property_type': 'Home' });
await sleep(3500);
await patch(`/api/v1/score-rules/${web.id}`, manager, { points: 15 });
const rc = await post('/api/v1/score-rules/recalculate', manager);
check('recalculating applies a changed rule', rc.status === 201 && rc.body.leads > 0 && (await scoreOf(old.id)).score === 35, rc.body);
const again = await post('/api/v1/score-rules/recalculate', manager);
check('recalculating twice changes nothing', again.body.changed === 0, again.body);
await patch(`/api/v1/score-rules/${type.id}`, manager, { isArchived: true });
await post('/api/v1/score-rules/recalculate', manager);
check('an archived rule takes its points back', (await scoreOf(old.id)).score === 10);
check('a lead you cannot see has no score for you', (await get(`/api/v1/leads/${a.id}/score`, rm)).status === 404);

// Moving between business lines
const toMove = (await post('/api/v1/leads', manager, { name: `Move Me ${stamp}`, mobile: mob(), customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const MOVE = toMove.id ?? toMove.lead?.id;
await sleep(3500);
check('a salesperson cannot move leads', (await post(`/api/v1/leads/${MOVE}/transfer`, rm, { workspaceId: COURSE, reason: 'wrong team' })).status === 403);
check('a reason is required', (await post(`/api/v1/leads/${MOVE}/transfer`, manager, { workspaceId: COURSE, reason: '' })).status === 400);
check('it cannot move to where it is', (await post(`/api/v1/leads/${MOVE}/transfer`, manager, { workspaceId: VASTU, reason: 'same place' })).body.code === 'SAME_WORKSPACE');
check('the options list other business lines only', !(await get(`/api/v1/leads/${MOVE}/transfer-options`, manager)).body.some((w) => w.id === VASTU));
const before = await get(`/api/v1/leads/${MOVE}`, admin);
await post('/api/v1/tasks', manager, { title: 'Call back', dueAt: new Date(Date.now() + 86_400_000).toISOString(), leadId: MOVE });
const moved = await post(`/api/v1/leads/${MOVE}/transfer`, manager, { workspaceId: COURSE, reason: 'Wants the course instead' });
check('a manager moves a lead', moved.status === 201 && moved.body.workspaceId === COURSE, moved.body);
const after = (await call(`/api/v1/leads/${MOVE}`, { token: admin, workspace: COURSE })).body;
const L = after.lead ?? after;
check('it is now in the new business line', (L.workspace?.id ?? L.workspaceId) === COURSE, Object.keys(L));
check('it starts at the first stage there', L.stageId === L.pipeline.stages[0].id && L.pipeline.id !== before.body.pipeline.id);
check('it has an owner there', !!(L.owner?.id ?? L.ownerId));
check('the reason and old fields are on the timeline', JSON.stringify(after).includes('Wants the course instead') || JSON.stringify((await call(`/api/v1/leads/${MOVE}/activities`, { token: admin, workspace: COURSE })).body).includes('Wants the course instead'));
const open = (await call(`/api/v1/tasks?leadId=${MOVE}&status=open`, { token: admin, workspace: COURSE })).body;
const tk = (Array.isArray(open) ? open : open.items ?? []);
check('open tasks go with it to the new owner', tk.length === 1 && (tk[0].assigneeId ?? tk[0].assignee?.id) === (L.owner?.id ?? L.ownerId), open);
await sleep(3500);
check('scores from the old business line do not follow it', (await scoreOf(MOVE, COURSE)).rules.every((r) => r.name !== 'From website'));
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('the move is audited', audit.includes('lead.transferred'));
const twin = (await post('/api/v1/leads', manager, { name: `Twin ${stamp}`, mobile: mob(), customFields: { property_type: 'Home' } })).body;
const twinCustomer = twin.customerId ?? twin.customer?.id ?? twin.lead?.customerId;
const twinId = twin.id ?? twin.lead?.id;
const twinMobile = `9${String(stamp).slice(-7)}${String(n).padStart(2, '0')}`;
const inCourse = await call('/api/v1/leads', { token: admin, workspace: COURSE, method: 'POST', body: { name: `Twin ${stamp}`, mobile: twinMobile, customFields: { course: 'Basics' }, duplicate: 'new_lead' } });
check('it will not make a second open lead for one customer', inCourse.status >= 400 || (await post(`/api/v1/leads/${twinId}/transfer`, manager, { workspaceId: COURSE, reason: 'duplicate test' })).body.code === 'ALREADY_OPEN', inCourse.body);
check('another organization cannot move it', (await call(`/api/v1/leads/${twinId}/transfer`, { tenant: 'abc', token: abc, method: 'POST', body: { workspaceId: COURSE, reason: 'not mine' } })).status >= 400);

// Portals
const list = (await call('/api/v1/integrations', { token: admin })).body;
for (const k of ['acres99', 'magicbricks', 'housing', 'sulekha']) check(`${k} is available to set up`, list.find?.((i) => i.key === k)?.phase === 'Live', list.find?.((i) => i.key === k));
const saved = await call('/api/v1/integrations/acres99/setup', { token: admin, method: 'PUT', body: { values: { businessLine: VASTU }, activate: false } });
const mapped = await call('/api/v1/integrations/acres99/mapping', { token: admin, method: 'PUT', body: { sourceFields: ['name', 'mobile', 'city'], map: { name: 'name', mobile: 'mobile', city: 'city' }, duplicateMode: 'add_remark', defaultSource: '99acres' } });
const on = await call('/api/v1/integrations/acres99/setup', { token: admin, method: 'PUT', body: { values: { businessLine: VASTU }, activate: true } });
const setup2 = (await call('/api/v1/integrations/acres99/setup', { token: admin })).body;
const url = setup2.webhookUrl ?? setup2.webhook;
check('a portal gives a webhook address', !!url, setup2);
const hookPath = url ? new URL(url).pathname : '';
const portalName = `Portal Lead ${stamp}`;
const pushed = await call(hookPath, { tenant: null, method: 'POST', body: { name: portalName, mobile: mob(), city: 'Pune' } });
check('a pushed portal enquiry becomes a lead', pushed.status === 200 && pushed.body.results?.[0]?.outcome === 'created', { saved: saved.status, mapped: mapped.status, on: on.status, body: pushed.body });
const pl = (await get(`/api/v1/leads?q=${encodeURIComponent(portalName)}`, admin)).body;
check('portal leads follow the routing rules', ownerOf((pl.items ?? pl.leads ?? pl)[0]) === NEHA, pl);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
