// End-to-end checks for slice 3.9: visual automation flows (actions, if/else paths, waits), runs, preview, editing safety.
// Usage: npm run verify:flows   (API running with AUTOMATION_IDLE_MS=2000 and AUTOMATION_HOUR_MS=4000, freshly seeded)
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
const login = async (id, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier: id, password: PASSWORD } })).body.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(300); } };
const admin = await login('admin@mycompany.local');
const manager = await login('manager@mycompany.local');
const rm = await login('arjun');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = me.workspaces.find((w) => w.name === 'Vastu Consultation / Audit').id;
const COURSE = me.workspaces.find((w) => w.name === 'Course / Software').id;
const M = { token: manager, workspace: VASTU }, R = { token: rm, workspace: VASTU }, A = { token: admin, workspace: VASTU };
const settings = (await call(`/api/v1/workspaces/${VASTU}/settings`, A)).body;
const consult = settings.pipelines.find((p) => p.name === 'Consultation');
const stage = (n) => consult.stages.find((s) => s.name === n).id;
const wonStage = consult.stages.find((s) => s.isWon)?.id;
const other = settings.pipelines.find((p) => p.name !== 'Consultation').stages[0].id;
let n = 0;
const mkLead = async (name, source = 'manual') => (await call('/api/v1/leads', { ...R, method: 'POST', body: { name, mobile: `98207${String(100000 + ++n).slice(1)}`, source, customFields: { property_type: 'Home' } } })).body;
const flowApi = (path = '', method = 'GET', body, who = M) => call(`/api/v1/automation/flows${path}`, { ...who, method, body });
const runsOf = async (id) => (await flowApi(`/${id}/runs`)).body;
const runFor = async (flowId, leadId) => (await runsOf(flowId)).find((r) => r.leadId === leadId);
const acts = async (leadId) => { const d = (await call(`/api/v1/leads/${leadId}`, A)).body; return (d.activities ?? d.timeline ?? []).map((a) => a.remark ?? '').join(' | '); };

const graph = {
  steps: [
    { id: 'welcome', type: 'action', action: { type: 'add_remark', text: 'Welcome {name}' } },
    { id: 'pick', type: 'condition', conditions: [{ field: 'source', op: 'eq', value: 'website' }],
      yes: [
        { id: 'task', type: 'action', action: { type: 'create_task', title: 'Call {name}', dueHours: 2 } },
        { id: 'pause', type: 'wait', hours: 0.25 },
        { id: 'later', type: 'action', action: { type: 'add_remark', text: 'Checked again for {name}' } },
      ],
      no: [{ id: 'tell', type: 'action', action: { type: 'notify_owner', text: 'New offline lead {name}' } }] },
  ],
};
const body = { name: 'Website welcome', trigger: 'lead.created', graph };

// ---- Saving ----
check('a salesperson cannot make flows', (await flowApi('', 'POST', body, R)).status === 403);
const badLast = await flowApi('', 'POST', { ...body, graph: { steps: [{ ...graph.steps[1] }, { id: 'x', type: 'wait', hours: 1 }] } });
check('an "if" step must end its path', badLast.body.code === 'FLOW_INVALID' && /last step/.test(badLast.body.message), badLast.body);
check('incomplete steps are refused', (await flowApi('', 'POST', { ...body, graph: { steps: [{ id: 'a', type: 'action', action: { type: 'create_task' } }] } })).body.code === 'FLOW_INVALID');
check('conditions need values', (await flowApi('', 'POST', { ...body, graph: { steps: [{ id: 'c', type: 'condition', conditions: [{ field: 'source', op: 'eq' }], yes: [], no: [] }] } })).body.code === 'CONDITION_INCOMPLETE');
check('quiet-lead flows need the number of days', (await flowApi('', 'POST', { ...body, trigger: 'lead.idle' })).body.code === 'IDLE_DAYS_REQUIRED');
const f1 = (await flowApi('', 'POST', body)).body;
check('a flow is saved switched off', !!f1.id && f1.isActive === false, f1);
const quiet = await mkLead('Before Switch', 'website');
await sleep(3000);
check('a switched-off flow does nothing', !(await runFor(f1.id, quiet.id)));

// ---- Running ----
await flowApi(`/${f1.id}`, 'PATCH', { isActive: true });
const web = await mkLead('Web Visitor', 'website');
const r1 = await until(async () => { const r = await runFor(f1.id, web.id); return r?.status === 'waiting' ? r : null; });
check('a new lead enters the flow and stops at the wait', !!r1 && r1.log.map((x) => x.nodeId).join() === 'welcome,pick,task,pause' && r1.log[1].result === 'yes', r1);
const tasks = (await call(`/api/v1/tasks?leadId=${web.id}`, A)).body;
check('the steps really happened', (await acts(web.id)).includes('Welcome Web Visitor') && JSON.stringify(tasks).includes('Call Web Visitor'));
const r1done = await until(async () => { const r = await runFor(f1.id, web.id); return r?.status === 'done' ? r : null; });
check('after the wait the flow carries on to the end', !!r1done && r1done.log.some((x) => x.nodeId === 'later') && (await acts(web.id)).includes('Checked again for Web Visitor'), r1done);
const walkIn = await mkLead('Walk In', 'manual');
const r2 = await until(async () => { const r = await runFor(f1.id, walkIn.id); return r?.status === 'done' ? r : null; });
check('the other path is taken when the condition fails', !!r2 && r2.log.map((x) => `${x.nodeId}:${x.result}`).join() .includes('pick:no') && r2.log.some((x) => x.nodeId === 'tell'), r2);
const pv = await flowApi(`/${f1.id}/preview`, 'POST', { leadId: web.id }, R);
check('anyone can preview the path for a lead without doing anything', pv.status === 200 && pv.body.path.map((p) => p.result).join('|').includes('yes') && pv.body.path.some((p) => p.result === 'waits 0.25 h') && pv.body.leadName === 'Web Visitor', pv.body);
check('a lead is in a flow once at a time', (await flowApi(`/${f1.id}/start`, 'POST', { leadId: web.id })).status === 200 && (await flowApi(`/${f1.id}/start`, 'POST', { leadId: web.id })).body.code === 'ALREADY_RUNNING');

// ---- Stopping, closing, editing ----
const s1 = await mkLead('Stop Me', 'website');
const rs = await until(async () => { const r = await runFor(f1.id, s1.id); return r?.status === 'waiting' ? r : null; });
check('a waiting lead can be stopped', (await call(`/api/v1/automation/flow-runs/${rs.id}/stop`, { ...M, method: 'POST' })).status === 200 && (await runFor(f1.id, s1.id)).status === 'stopped');
const longFlow = (await flowApi('', 'POST', { name: 'Long wait', trigger: 'lead.created', graph: { steps: [{ id: 'w1', type: 'wait', hours: 2 }, { id: 'after', type: 'action', action: { type: 'add_remark', text: 'Done waiting' } }] } })).body;
await flowApi(`/${longFlow.id}`, 'PATCH', { isActive: true });
const c1 = await mkLead('Closes Soon', 'website');
await until(async () => (await runFor(longFlow.id, c1.id))?.status === 'waiting');
if (wonStage) await call(`/api/v1/leads/${c1.id}/stage`, { ...R, method: 'PATCH', body: { stageId: wonStage } });
const rc = await until(async () => { const r = await runFor(longFlow.id, c1.id); return r?.status === 'stopped' ? r : null; }, 15_000);
check('a lead that is won leaves the flow', !wonStage || (rc?.error === 'lead closed'), rc);
const e1 = await mkLead('Edit Victim', 'website');
await until(async () => (await runFor(longFlow.id, e1.id))?.status === 'waiting');
await flowApi(`/${longFlow.id}`, 'PUT', { name: 'Long wait', trigger: 'lead.created', graph: { steps: [{ id: 'w1', type: 'wait', hours: 2 }] } });
const re = await until(async () => { const r = await runFor(longFlow.id, e1.id); return r?.status === 'stopped' || r?.status === 'done' ? r : null; }, 15_000);
check('removing the step a lead waits for ends its run safely', re?.status === 'stopped' && /gone/.test(re.error ?? ''), re);
await flowApi(`/${longFlow.id}`, 'PATCH', { isArchived: true });

const broken = (await flowApi('', 'POST', { name: 'Broken', trigger: 'lead.created', graph: { steps: [{ id: 'bad', type: 'action', action: { type: 'change_stage', stageId: other } }, { id: 'never', type: 'action', action: { type: 'add_remark', text: 'never' } }] } })).body;
await flowApi(`/${broken.id}`, 'PATCH', { isActive: true });
const b1 = await mkLead('Breaks Flow', 'website');
const rb = await until(async () => { const r = await runFor(broken.id, b1.id); return r?.status === 'failed' ? r : null; });
check('a failing step stops the run with the reason', !!rb && /pipeline/.test(rb.error) && !rb.log.some((x) => x.nodeId === 'never'), rb);
await flowApi(`/${broken.id}`, 'PATCH', { isArchived: true });

// ---- Rules, archive, isolation ----
const rule = (await call('/api/v1/automation/rules', { ...M, method: 'POST', body: { name: 'Website task', trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'website' }], actions: [{ type: 'add_remark', text: 'From rule' }], isActive: false } })).body;
const conv = await call(`/api/v1/automation/rules/${rule.id}/to-flow`, { ...M, method: 'POST' });
check('a rule can be opened as a flow', conv.status === 201 && conv.body.isActive === false && conv.body.graph.steps[0].type === 'condition' && conv.body.graph.steps[0].yes[0].action.text === 'From rule', conv.body);
const w2 = await mkLead('Archive Check', 'website');
await until(async () => (await runFor(f1.id, w2.id))?.status === 'waiting');
await flowApi(`/${f1.id}`, 'PATCH', { isArchived: true });
check('archiving a flow stops the leads still in it', (await call(`/api/v1/automation/flows/${f1.id}`, M)).status === 404);
const list = (await flowApi('')).body;
check('the list shows flows with step and run counts', list.some((f) => f.id === conv.body.id && f.steps === 2) && !list.some((f) => f.id === f1.id), list.map((f) => [f.name, f.steps]));
check('another business line does not see them', !(await call('/api/v1/automation/flows', { token: admin, workspace: COURSE })).body.some((f) => f.id === conv.body.id));
check('another organization cannot open them', [403, 404].includes((await call(`/api/v1/automation/flows/${conv.body.id}`, { tenant: 'abc', token: abc })).status));
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('flow changes are audited', ['automation_flow.created', 'automation_flow.switched_on', 'automation_flow.updated', 'automation_flow.archived', 'automation_flow.created_from_rule'].every((a) => audit.includes(a)));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
