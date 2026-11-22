// End-to-end checks for slice 4.3: API templates (placeholders, encrypted headers, test call, "Call an API" in rules and
// flows) and scheduled report emails (run as the creator, CSV attached).
// Usage: npm run verify:automations   (API running, freshly seeded, Mailpit on :8025; run `npm run db:seed` afterwards).
import { createServer } from 'node:http';

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const PORT = 4594, SECRET = 'Bearer super-secret-token-42';
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
  return { status: res.status, body: json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(300); } };
const hits = [];
const server = createServer((req, res) => {
  let data = ''; req.on('data', (c) => (data += c));
  req.on('end', () => { hits.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: data }); res.statusCode = req.url.startsWith('/broken') ? 500 : 200; res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
});
await new Promise((r) => server.listen(PORT, r));
const login = async (id, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier: id, password: PASSWORD } })).body.accessToken;
const admin = await login('admin@mycompany.local');
const manager = await login('manager@mycompany.local');
const rm = await login('arjun');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = me.workspaces.find((w) => w.name === 'Vastu Consultation / Audit').id;
const M = { token: manager, workspace: VASTU }, R = { token: rm, workspace: VASTU }, A = { token: admin, workspace: VASTU };
const users = (await call('/api/v1/users', { token: admin })).body;
const ADMIN = users.find((u) => u.email === 'admin@mycompany.local');
let n = 0;
const mkLead = async (name) => (await call('/api/v1/leads', { ...R, method: 'POST', body: { name, mobile: `98507${String(100000 + ++n).slice(1)}`, source: 'website', customFields: { property_type: 'Home' } } })).body;

// ---- API templates ----
const tplBody = { name: 'Send to website CRM', method: 'POST', url: `http://localhost:${PORT}/hook?m={lead.mobile}`, headers: { Authorization: SECRET, 'Content-Type': 'application/json' }, body: '{"name":"{lead.name}","stage":"{lead.stage}","prop":"{lead.cf.property_type}","org":"{org.name}"}' };
check('a salesperson cannot add API templates', (await call('/api/v1/automation/api-templates', { ...R, method: 'POST', body: tplBody })).status === 403);
check('the address must be http(s)', (await call('/api/v1/automation/api-templates', { ...M, method: 'POST', body: { ...tplBody, url: 'ftp://x.test/a' } })).status === 400);
const tpl = await call('/api/v1/automation/api-templates', { ...M, method: 'POST', body: tplBody });
check('a manager saves an API template', tpl.status === 201 && tpl.body.headerNames.includes('Authorization') && !tpl.text.includes('super-secret'), tpl.body);
const list = await call('/api/v1/automation/api-templates', M);
check('header values are never sent back', list.body.some((t) => t.id === tpl.body.id) && !list.text.includes('super-secret'));
const lead = await mkLead('Ravi "Quote" Sharma');
const t1 = await call(`/api/v1/automation/api-templates/${tpl.body.id}/test`, { ...M, method: 'POST', body: { leadId: lead.id } });
const hit = hits[hits.length - 1];
check('a test call fills placeholders and answers with the status', t1.status === 200 && t1.body.status === 200 && t1.body.ok === true && hit?.url === '/hook?m=%2B919850700001' && hit.auth === SECRET, { t1: t1.body, hit });
const sent = JSON.parse(hit.body);
check('a JSON body stays valid with quotes in names', sent.name === 'Ravi "Quote" Sharma' && sent.prop === 'Home' && sent.org === 'My Company' && !!sent.stage, sent);
const keep = await call(`/api/v1/automation/api-templates/${tpl.body.id}`, { ...M, method: 'PUT', body: { ...tplBody, name: 'Send to website CRM v2', headers: {}, keepHeaders: true } });
await call(`/api/v1/automation/api-templates/${tpl.body.id}/test`, { ...M, method: 'POST', body: {} });
check('editing without new headers keeps the saved ones', keep.body.headerNames.includes('Authorization') && hits[hits.length - 1].auth === SECRET);
const broken = (await call('/api/v1/automation/api-templates', { ...M, method: 'POST', body: { ...tplBody, name: 'Broken endpoint', url: `http://localhost:${PORT}/broken` } })).body;

// ---- Call an API in a rule and a flow ----
const opts = (await call('/api/v1/automation/options', M)).body;
check('rule and flow editors offer the templates', opts.apiTemplates?.some((t) => t.value === tpl.body.id) && opts.actions.some((a) => a.value === 'call_api'), opts.apiTemplates);
check('a Call an API step needs a template', (await call('/api/v1/automation/rules', { ...M, method: 'POST', body: { name: 'No template', trigger: 'lead.created', actions: [{ type: 'call_api' }] } })).body.code === 'ACTION_INCOMPLETE');
const rule = (await call('/api/v1/automation/rules', { ...M, method: 'POST', body: { name: 'Push new leads', trigger: 'lead.created', actions: [{ type: 'call_api', apiTemplateId: tpl.body.id }] } })).body;
const before = hits.length;
const l2 = await mkLead('Rule Pushed');
const pushed = await until(() => hits.slice(before).find((h) => h.body.includes('Rule Pushed')));
check('a rule calls the API for a new lead', !!pushed && pushed.auth === SECRET, hits.slice(before));
await call(`/api/v1/automation/rules/${rule.id}`, { ...M, method: 'PATCH', body: { isActive: false } });
const badRule = (await call('/api/v1/automation/rules', { ...M, method: 'POST', body: { name: 'Push to broken', trigger: 'lead.created', actions: [{ type: 'call_api', apiTemplateId: broken.id }] } })).body;
await mkLead('Breaks The API');
const failedRun = await until(async () => (await call(`/api/v1/automation/runs?ruleId=${badRule.id}`, M)).body.find((r) => r.status === 'failed'));
check('an API that answers 500 fails the run with the reason', /answered 500/.test(failedRun?.detail ?? ''), failedRun);
await call(`/api/v1/automation/rules/${badRule.id}`, { ...M, method: 'PATCH', body: { isActive: false } });
const flow = (await call('/api/v1/automation/flows', { ...M, method: 'POST', body: { name: 'Flow push', trigger: 'lead.created', graph: { steps: [{ id: 'c', type: 'action', action: { type: 'call_api', apiTemplateId: tpl.body.id } }] } } })).body;
const fRun = await call(`/api/v1/automation/flows/${flow.id}/start`, { ...M, method: 'POST', body: { leadId: l2.id } });
check('a flow step calls the API too', fRun.status === 200 && (await until(async () => (await call(`/api/v1/automation/flows/${flow.id}/runs`, M)).body.find((r) => r.status === 'done' && r.log.some((x) => /called/.test(x.result))))), fRun.body);

// ---- Schedules ----
const sched = { name: 'Morning leaderboard', reportKey: 'leaderboard', range: 'this_month', frequency: 'daily', time: '09:00', recipientIds: [ADMIN.id] };
check('weekly schedules need a day', (await call('/api/v1/automation/schedules', { token: admin, method: 'POST', body: { ...sched, frequency: 'weekly' } })).body.code === 'WEEKDAY_REQUIRED');
check('emailing lead lists needs "Export leads"', (await call('/api/v1/automation/schedules', { ...R, method: 'POST', body: { ...sched, reportKey: 'leads' } })).status === 403);
check('recipients must be active users', (await call('/api/v1/automation/schedules', { token: admin, method: 'POST', body: { ...sched, recipientIds: ['00000000-0000-0000-0000-000000000000'] } })).body.code === 'BAD_RECIPIENTS');
const s1 = await call('/api/v1/automation/schedules', { token: admin, method: 'POST', body: sched });
check('a schedule is saved with its next run in India time', s1.status === 201 && /T03:30:00.000Z$/.test(s1.body.nextRunAt), s1.body);
await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
await call(`/api/v1/automation/schedules/${s1.body.id}`, { token: admin, method: 'PATCH', body: { runNow: true } });
await call('/api/v1/automation/run-now', { token: admin, method: 'POST' });
const mail = await until(async () => (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()).messages?.find((m) => m.Subject.startsWith('Morning leaderboard')));
check('the report is emailed', !!mail && mail.To[0].Address === 'admin@mycompany.local' && mail.Attachments >= 1, mail && { subject: mail.Subject, attachments: mail.Attachments });
const after = (await call('/api/v1/automation/schedules', { token: admin })).body.find((s) => s.id === s1.body.id);
check('the schedule records the send and moves to the next day', /^sent to 1/.test(after?.lastStatus ?? '') && new Date(after.nextRunAt) > new Date(), after);
check('a salesperson does not see other people\'s schedules', !(await call('/api/v1/automation/schedules', R)).body.some((s) => s.id === s1.body.id));
await call(`/api/v1/automation/schedules/${s1.body.id}`, { token: admin, method: 'PATCH', body: { isArchived: true } });
check('an archived schedule is gone', !(await call('/api/v1/automation/schedules', { token: admin })).body.some((s) => s.id === s1.body.id));

const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('changes are audited without secrets', ['api_template.created', 'api_template.tested', 'report_schedule.created', 'report_schedule.sent'].every((a) => audit.includes(a)) && !audit.includes('super-secret'));

server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
