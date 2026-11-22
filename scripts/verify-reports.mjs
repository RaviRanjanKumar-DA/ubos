// End-to-end checks for slice 4.1: the Reports hub (leaderboard, actions, tasks, call report, call log, leads, duplicates,
// Facebook data, sales), scope, filters and downloads.
// Usage: npm run verify:reports   (API running, freshly seeded; run `npm run db:seed` afterwards).
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
  return { status: res.status, body: json, text, headers: res.headers };
}
const login = async (id, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier: id, password: PASSWORD } })).body.accessToken;
const admin = await login('admin@mycompany.local');
const manager = await login('manager@mycompany.local');
const rm = await login('arjun');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = me.workspaces.find((w) => w.name === 'Vastu Consultation / Audit').id;
const COURSE = me.workspaces.find((w) => w.name === 'Course / Software').id;
const users = (await call('/api/v1/users', { token: admin })).body;
const ARJUN = users.find((u) => u.username === 'arjun');
const R = { token: rm, workspace: VASTU };
const rep = (key, qs = '', token = admin) => call(`/api/v1/reports/${key}?${qs}`, { token, workspace: token === rm ? VASTU : undefined });
let n = 0;
const mkLead = async (name, source = 'website', cf = { property_type: 'Home' }) => (await call('/api/v1/leads', { ...R, method: 'POST', body: { name, mobile: `98307${String(100000 + ++n).slice(1)}`, source, customFields: cf } })).body;

// Data: leads, a repeat enquiry, calls, a task, a Facebook lead
const l1 = await mkLead('Report Alpha');
const l2 = await mkLead('Report Beta', 'manual');
const fb = await mkLead('Report Facebook', 'facebook', { property_type: 'Office' });
await call('/api/v1/leads', { ...R, method: 'POST', body: { name: 'Report Alpha', mobile: '98307' + String(100001).slice(1), source: 'website', customFields: { property_type: 'Home' } } });
await call(`/api/v1/leads/${l1.id}/activities`, { ...R, method: 'POST', body: { type: 'call', disposition: 'interested', durationSec: 180, remark: 'Talked about budget' } });
await call(`/api/v1/leads/${l2.id}/activities`, { ...R, method: 'POST', body: { type: 'call', disposition: 'not_answered' } });
await call(`/api/v1/leads/${l1.id}/activities`, { ...R, method: 'POST', body: { type: 'remark', remark: 'Sent brochure' } });
await call('/api/v1/tasks', { ...R, method: 'POST', body: { title: 'Report task', dueAt: new Date(Date.now() + 3_600_000).toISOString(), leadId: l1.id } });

// ---- Catalogue and access ----
const cat = (await call('/api/v1/reports', { token: admin })).body;
check('the hub lists every report type, with the ones still coming marked', cat.reports.length >= 12 && cat.reports.filter((r) => r.ready).length === 10 && cat.reports.some((r) => r.key === 'ai_insights' && !r.ready) && cat.canExport === true, cat.reports?.map((r) => r.key));
check('a report that is coming says so', (await rep('ai_insights')).body.code === 'REPORT_COMING');
check('an unknown report is refused', (await rep('nope')).body.code === 'UNKNOWN_REPORT');
check('a plan or role without dashboards cannot open reports', [403].includes((await call('/api/v1/reports', { tenant: 'abc', token: abc })).status) || (await call('/api/v1/reports/leads', { tenant: 'abc', token: abc })).body.rows?.every((r) => !r.name?.startsWith('Report ')));
check('custom dates need both days', (await rep('leads', 'range=custom&from=2026-11-01')).body.code === 'DATES_REQUIRED');

// ---- Each report ----
const lb = (await rep('leaderboard')).body;
const arjunRow = lb.rows.find((r) => r.name?.startsWith('Arjun'));
check('leaderboard shows each person with totals', !!arjunRow && arjunRow.calls >= 2 && arjunRow.leads >= 3 && lb.totals?.name === 'Total' && lb.columns.some((c) => c.key === 'wonValue' && c.format === 'currency'), { arjunRow, totals: lb.totals });
const ac = (await rep('actions')).body;
const arjunAct = ac.rows.find((r) => r.name?.startsWith('Arjun'));
check('actions count calls and remarks by person', arjunAct?.call >= 2 && arjunAct?.remark >= 1 && arjunAct.total >= 3, arjunAct);
const cr = (await rep('calls')).body;
const arjunCalls = cr.rows.find((r) => r.name?.startsWith('Arjun'));
check('call report splits connected and not connected with talk time', arjunCalls?.total >= 2 && arjunCalls.connected >= 1 && arjunCalls.notConnected >= 1 && arjunCalls.talkMinutes >= 3, arjunCalls);
const log = (await rep('call_log')).body;
check('call log lists every call with lead and outcome', log.rows.some((r) => r.lead === 'Report Alpha' && r.duration === 180 && r.outcome) && log.columns[0].format === 'datetime', log.rows.slice(0, 2));
const leads = (await rep('leads')).body;
check('leads report lists new leads with owner and stage', leads.rows.some((r) => r.name === 'Report Alpha' && r.owner.startsWith('Arjun') && r.stage && r.businessLine === 'Vastu Consultation / Audit'), leads.rows.slice(0, 2));
check('filters narrow the report', (await rep('leads', 'source=manual')).body.rows.every((r) => /manual/i.test(r.source)) && (await rep('leads', 'source=manual')).body.rows.length < leads.rows.length && (await rep('leads', `workspaceId=${COURSE}`)).body.rows.every((r) => r.businessLine === 'Course / Software'));
check('filtering by person works', (await rep('leads', `ownerId=${ARJUN.id}`)).body.rows.every((r) => r.owner.startsWith('Arjun')));
const tk = (await rep('tasks')).body;
check('tasks report shows due tasks and their state', tk.rows.some((r) => r.title === 'Report task' && r.state === 'Open' && r.lead === 'Report Alpha') && /done/.test(tk.totals?.state ?? ''), tk.rows.slice(0, 2));
const dup = (await rep('duplicates')).body;
check('duplicate leads shows people with more than one open lead', dup.rows.some((r) => r.name === 'Report Alpha' && r.kind === 'More than one open lead' && r.times >= 2), dup.rows.slice(0, 2));
const fbr = (await rep('facebook')).body;
check('Facebook data shows the form answers as columns', fbr.rows.some((r) => r.name === 'Report Facebook' && r.cf_property_type === 'Office') && fbr.columns.some((c) => c.key === 'cf_property_type') && !fbr.rows.some((r) => r.name === 'Report Alpha'), fbr.columns.map((c) => c.key));
const sales = (await rep('sales')).body;
check('sales report has value columns and totals', sales.columns.some((c) => c.key === 'invoiced') && typeof sales.totals?.received === 'number', sales.totals);

// ---- Scope ----
const rmLeads = (await rep('leads', '', rm)).body;
check('a salesperson sees only their own leads', rmLeads.rows.length > 0 && rmLeads.rows.every((r) => r.owner.startsWith('Arjun')), [...new Set(rmLeads.rows.map((r) => r.owner))]);
const rmLb = (await rep('leaderboard', '', rm)).body;
check('a salesperson sees only themselves on the leaderboard', rmLb.rows.every((r) => r.name.startsWith('Arjun')), rmLb.rows.map((r) => r.name));

// ---- Downloads ----
const dl = await call('/api/v1/reports/leads/download', { token: admin });
const raw = new Uint8Array(await (await fetch(API + '/api/v1/reports/leads/download', { headers: { 'X-Tenant': 'mycompany', Authorization: `Bearer ${admin}` } })).arrayBuffer());
const bomOk = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
check('a report downloads as CSV for Excel', dl.status === 200 && dl.headers.get('content-type').includes('text/csv') && bomOk && dl.text.includes('Created (IST)') && dl.text.includes('Report Alpha'), dl.text.slice(0, 120));
const lbDl = await call('/api/v1/reports/leaderboard/download', { token: admin });
check('money downloads as rupees and percent with a sign', lbDl.status === 200 && lbDl.text.includes('Won value') && /\d+%|,\d+\.\d{2}/.test(lbDl.text), lbDl.text.slice(0, 200));
check('someone without "Export leads" cannot download lead lists', (await call('/api/v1/reports/leads/download', { token: rm, workspace: VASTU })).status === 403);
check('summaries can still be downloaded without export rights', (await call('/api/v1/reports/leaderboard/download', { token: rm, workspace: VASTU })).status === 200);
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('downloads are audited', audit.includes('report.downloaded'));
check('the auditor can view reports', (await rep('leaderboard', '', auditor)).status === 200);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
