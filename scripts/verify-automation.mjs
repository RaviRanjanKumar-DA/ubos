// End-to-end checks for slice 2.5 (automation): rules with conditions and each action, business-line separation, pause,
// failure log, loop guard, idle leads, sequences (timing, stop on reply, opt-out, closed leads).
// Usage: npm run verify:automation   (API running with AUTOMATION_IDLE_MS=2000, freshly seeded)

import { createServer } from 'node:http';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const PORT = Number(process.env.VERIFY_AUTO_PORT ?? 4595);
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body } = {}) {
  const h = { 'Content-Type': 'application/json' };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(300); } };

const hits = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push(Object.fromEntries(u.searchParams));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: `GW${hits.length}` }));
});
await new Promise((r) => server.listen(PORT, r));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const COURSE = ws['Course / Software'];
const A = { token: admin, workspace: VASTU };
const M = { token: manager, workspace: VASTU };
const R = { token: rm, workspace: VASTU };
const opts = (await call('/api/v1/automation/options', M)).body;
const settings = (await call(`/api/v1/workspaces/${VASTU}/settings`, A)).body;
const consult = settings.pipelines.find((p) => p.name === 'Consultation');
const stage = (n) => consult.stages.find((s) => s.name === n).id;
const other = settings.pipelines.find((p) => p.name !== 'Consultation').stages[0].id;
let n = 0;
const mkLead = async (name, source = 'manual', who = R, cf = { property_type: 'Home' }) => (await call('/api/v1/leads', { ...who, method: 'POST', body: { name, mobile: `98107${String(100000 + ++n).slice(1)}`, source, customFields: cf } })).body;
const rule = (b) => call('/api/v1/automation/rules', { ...M, method: 'POST', body: b });
const detail = (id, who = A) => call(`/api/v1/leads/${id}`, who).then((r) => r.body);
const runsOf = async (ruleId) => (await call(`/api/v1/automation/runs?ruleId=${ruleId}`, M)).body;
const pause = (id) => call(`/api/v1/automation/rules/${id}`, { ...M, method: 'PATCH', body: { isActive: false } });

try {
  // Rule validation
  const base = { name: 'Test', trigger: 'lead.created', actions: [{ type: 'add_remark', text: 'x' }] };
  const rmR = await call('/api/v1/automation/rules', { ...R, method: 'POST', body: base });
  const badT = await rule({ ...base, trigger: 'nope' });
  const noDays = await rule({ ...base, trigger: 'lead.idle' });
  const incomplete = await rule({ ...base, actions: [{ type: 'change_stage' }] });
  const noVal = await rule({ ...base, conditions: [{ field: 'source', op: 'eq' }] });
  check('rules: managers only; triggers, idle days, actions and conditions are validated', rmR.status === 403 && badT.status === 400 && noDays.body.code === 'IDLE_DAYS_REQUIRED' && incomplete.body.code === 'ACTION_INCOMPLETE' && noVal.body.code === 'CONDITION_INCOMPLETE', [rmR.status, badT.status, noDays.body, incomplete.body, noVal.body]);
  check('the builder gets triggers, actions, stages, statuses, fields', opts.canManage && opts.triggers.some((t) => t.value === 'lead.idle') && opts.actions.length === 9 && opts.stages.length > 4 && opts.fields.some((f) => f.value === 'cf:property_type'), Object.keys(opts));

  // Condition + several actions
  const label = await call('/api/v1/labels', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'From website', workspaceId: VASTU } });
  const r1 = await rule({ name: 'Website leads', trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'website' }], actions: [
    { type: 'add_remark', text: 'Welcome {name}' }, { type: 'set_status', status: 'hot' }, { type: 'add_label', labelId: label.body.id }, { type: 'create_task', title: 'Call {name}', dueHours: 2 }, { type: 'notify_owner', text: 'Website lead: {name}' },
  ] });
  check('a manager creates a rule', r1.status === 201, r1.body);
  const yes = await mkLead('Web Lead', 'website');
  const no = await mkLead('Manual Lead', 'manual');
  await until(async () => (await runsOf(r1.body.id)).length > 0);
  await sleep(2500);
  const y = await detail(yes.id);
  const tasks = (await call(`/api/v1/tasks?leadId=${yes.id}&status=all`, A)).body;
  const noD = await detail(no.id);
  const runs1 = await runsOf(r1.body.id);
  check('when the conditions match, every action runs', y.status === 'hot' && y.labelIds.includes(label.body.id) && y.activities.some((a) => a.remark === 'Welcome Web Lead') && tasks.some((t) => t.title === 'Call Web Lead') && runs1[0]?.status === 'done' && runs1[0].leadName === 'Web Lead', [y.status, y.labelIds, tasks, runs1[0]]);
  check('when they do not match, nothing happens', noD.status !== 'hot' && runs1.length === 1, [noD.status, runs1.length]);
  check('the rule’s work is on the lead’s journey', y.activities.some((a) => a.type === 'automation' && /Website leads/.test(a.remark ?? '')), y.activities.map((a) => a.type));
  await pause(r1.body.id);

  // Stage trigger, assign, business-line separation
  const NEHA = (await call('/api/v1/users', { token: admin })).body.find((u) => u.email === 'manager@mycompany.local').id;
  const r2 = await rule({ name: 'Interested goes to manager', trigger: 'lead.stage_changed', conditions: [{ field: 'stage', op: 'eq', value: stage('Interested') }], actions: [{ type: 'assign', userId: NEHA }] });
  const l2 = await mkLead('Stage Lead');
  await call(`/api/v1/leads/${l2.id}/stage`, { ...R, method: 'PATCH', body: { stageId: stage('Contacted') } });
  await sleep(2500);
  const stay = await detail(l2.id);
  await call(`/api/v1/leads/${l2.id}/stage`, { ...R, method: 'PATCH', body: { stageId: stage('Interested') } });
  await until(async () => (await runsOf(r2.body.id)).length > 0);
  const moved = await detail(l2.id);
  check('a stage rule fires only for that stage and can reassign the lead', stay.owner.name.startsWith('Arjun') && moved.owner.id === NEHA, [stay.owner, moved.owner]);
  const courseRun = await rule({ name: 'Vastu only', trigger: 'lead.created', actions: [{ type: 'add_remark', text: 'vastu rule ran' }] });
  const cl = (await call('/api/v1/leads', { token: admin, workspace: COURSE, method: 'POST', body: { name: 'Course Lead', mobile: '9810799991', customFields: { course: 'Numerology Basic' } } })).body;
  await sleep(2500);
  const cd = await detail(cl.id, { token: admin, workspace: COURSE });
  check('a rule never touches another business line', !cd.activities.some((a) => a.remark === 'vastu rule ran'), cd.activities.map((a) => a.remark));
  await pause(courseRun.body.id); await pause(r2.body.id);
  const pausedLead = await mkLead('After Pause', 'website');
  await sleep(2500);
  check('a paused rule does nothing', (await runsOf(r1.body.id)).length === 1 && (await detail(pausedLead.id)).status !== 'hot', (await runsOf(r1.body.id)).length);

  // Failure log
  const bad = await rule({ name: 'Wrong stage', trigger: 'lead.created', actions: [{ type: 'change_stage', stageId: other }] });
  const fl = await mkLead('Fail Lead');
  const failed = await until(async () => (await runsOf(bad.body.id))[0]);
  check('a failing rule is logged with the reason and the lead is unharmed', failed?.status === 'failed' && /pipeline/.test(failed.detail) && (await detail(fl.id)).id === fl.id, failed);
  await pause(bad.body.id);

  // Loop guard
  const loopA = await rule({ name: 'Loop A', trigger: 'lead.stage_changed', conditions: [{ field: 'stage', op: 'eq', value: stage('Contacted') }], actions: [{ type: 'change_stage', stageId: stage('Interested') }] });
  const loopB = await rule({ name: 'Loop B', trigger: 'lead.stage_changed', conditions: [{ field: 'stage', op: 'eq', value: stage('Interested') }], actions: [{ type: 'change_stage', stageId: stage('Contacted') }] });
  const ll = await mkLead('Loop Lead');
  await call(`/api/v1/leads/${ll.id}/stage`, { ...R, method: 'PATCH', body: { stageId: stage('Contacted') } });
  await sleep(9000);
  const c1 = (await runsOf(loopA.body.id)).length + (await runsOf(loopB.body.id)).length;
  await sleep(4000);
  const c2 = (await runsOf(loopA.body.id)).length + (await runsOf(loopB.body.id)).length;
  check('rules that trigger each other stop after three links', c1 === 3 && c2 === 3, [c1, c2]);
  await pause(loopA.body.id); await pause(loopB.body.id);

  // Idle
  const idleL = await mkLead('Quiet Lead', 'referral');
  const idleR = await rule({ name: 'Quiet leads', trigger: 'lead.idle', idleDays: 0, conditions: [{ field: 'source', op: 'eq', value: 'referral' }], actions: [{ type: 'create_task', title: 'Revive {name}' }] });
  await until(async () => (await runsOf(idleR.body.id)).length > 0);
  await sleep(5000);
  check('idle leads fire once per quiet spell', (await runsOf(idleR.body.id)).length === 1 && (await call(`/api/v1/tasks?leadId=${idleL.id}&status=all`, A)).body.some((t) => t.title === 'Revive Quiet Lead'), await runsOf(idleR.body.id));
  await pause(idleR.body.id);

  // Sequences
  await call('/api/v1/integrations/sms_dlt/setup', { token: admin, method: 'PUT', body: { values: { provider: 'Other', apiKey: 'k', senderId: 'BATRAA', entityId: '1201159000000000001', gatewayUrl: `http://localhost:${PORT}/send?to={to}&text={text}` }, activate: true } });
  const t1 = (await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: { channel: 'sms', name: 'seq_one', body: 'One for {#var#}', variables: ['name'], dltTemplateId: '1207161234567890001' } })).body;
  const t2 = (await call('/api/v1/outreach/templates', { ...M, method: 'POST', body: { channel: 'sms', name: 'seq_two', body: 'Two for {#var#}', variables: ['name'], dltTemplateId: '1207161234567890002' } })).body;
  const seqOf = (name, steps) => call('/api/v1/automation/sequences', { ...M, method: 'POST', body: { name, steps } });
  const rmSeq = await call('/api/v1/automation/sequences', { ...R, method: 'POST', body: { name: 'X', steps: [{ delayHours: 0, templateId: t1.id }] } });
  const quick = await seqOf('Quick', [{ delayHours: 0, templateId: t1.id }, { delayHours: 0, templateId: t2.id }]);
  const slow = await seqOf('Slow', [{ delayHours: 0, templateId: t1.id }, { delayHours: 48, templateId: t2.id }]);
  check('managers create sequences', rmSeq.status === 403 && quick.status === 201 && slow.status === 201, [rmSeq.status, quick.body]);
  const statusOf = async (id, name) => (await call(`/api/v1/leads/${id}/sequences`, A)).body.find((e) => e.name === name);
  const enroll = (id, s) => call(`/api/v1/leads/${id}/sequences`, { ...R, method: 'POST', body: { sequenceId: s } });
  const q = await mkLead('Quick Lead');
  const en = await enroll(q.id, quick.body.id);
  const dupE = await enroll(q.id, quick.body.id);
  const done = await until(async () => (await statusOf(q.id, 'Quick'))?.status === 'completed' && statusOf(q.id, 'Quick'));
  const sentQ = hits.filter((h) => /Quick Lead/.test(h.text ?? '')).map((h) => h.text);
  check('a sequence sends its steps in order and completes; no double enrolment', en.status === 201 && dupE.status === 400 && (await done)?.status === 'completed' && sentQ.join('|') === 'One for Quick Lead|Two for Quick Lead', [en.body, dupE.body, sentQ]);
  const s = await mkLead('Slow Lead');
  await enroll(s.id, slow.body.id);
  const waited = await until(async () => { const x = await statusOf(s.id, 'Slow'); return x?.stepIndex === 1 && x; });
  check('the next step waits for its delay', waited?.status === 'active' && new Date(waited.nextAt) > new Date(Date.now() + 47 * 3_600_000) && hits.filter((h) => /Slow Lead/.test(h.text ?? '')).length === 1, waited);
  // Reply stops it
  await call('/api/v1/integrations/whatsapp/setup', { token: admin, method: 'PUT', body: { values: { phoneNumberId: 'PN1', wabaId: 'W', accessToken: 'tok', businessLine: VASTU }, activate: true } });
  const hook = (await call('/api/v1/integrations/whatsapp/setup', { token: admin })).body.webhookUrl;
  const sMobile = (await detail(s.id)).mobile.replace(/\D/g, '');
  const replyRule = await rule({ name: 'On reply', trigger: 'whatsapp.received', actions: [{ type: 'notify_owner', text: '{name} replied' }] });
  await call(hook, { tenant: null, method: 'POST', body: { entry: [{ changes: [{ value: { contacts: [{ wa_id: sMobile, profile: { name: 'Slow Lead' } }], messages: [{ from: sMobile, id: `wamid.${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Yes interested' } }] } }] }] } });
  const stopped = await statusOf(s.id, 'Slow');
  const fired = await until(async () => (await runsOf(replyRule.body.id)).length > 0);
  check('a WhatsApp reply stops the sequence and can fire a rule', stopped.status === 'stopped' && stopped.stopReason === 'customer replied' && !!fired, [stopped, fired]);
  await pause(replyRule.body.id);
  // Opt-out and closed leads
  const oo = await mkLead('Opted Lead');
  await call(`/api/v1/leads/${oo.id}/outreach/opt-out`, { ...R, method: 'POST', body: { channel: 'sms', optedOut: true } });
  await enroll(oo.id, quick.body.id);
  const ooS = await until(async () => { const x = await statusOf(oo.id, 'Quick'); return x?.status === 'stopped' && x; });
  check('an opted-out customer ends the sequence without a message', /opted out/.test(ooS?.stopReason ?? '') && !hits.some((h) => /Opted Lead/.test(h.text ?? '')), ooS);
  const wl = await mkLead('Won Lead');
  await call(`/api/v1/leads/${wl.id}/stage`, { ...R, method: 'PATCH', body: { stageId: stage('Won') } });
  await enroll(wl.id, quick.body.id);
  const wS = await until(async () => { const x = await statusOf(wl.id, 'Quick'); return x?.status === 'stopped' && x; });
  check('a won lead’s sequence stops', wS?.stopReason === 'lead closed' && !hits.some((h) => /Won Lead/.test(h.text ?? '')), wS);
  // Via a rule action
  const seqRule = await rule({ name: 'Start nurture', trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'walk_in' }], actions: [{ type: 'enroll_sequence', sequenceId: slow.body.id }, { type: 'send_template', templateId: t2.id }] });
  const nl = await mkLead('Nurture Lead', 'walk_in');
  const nS = await until(async () => { const x = await statusOf(nl.id, 'Slow'); return x?.stepIndex === 1 && x; });
  check('a rule can start a sequence and send a template', !!nS && hits.some((h) => h.text === 'Two for Nurture Lead'), nS);
  await pause(seqRule.body.id);
  const stopIt = await call(`/api/v1/leads/${nl.id}/sequences/${nS.id}/stop`, { ...R, method: 'POST' });
  check('a person can stop a sequence by hand', stopIt.status === 201 && (await statusOf(nl.id, 'Slow')).status === 'stopped', stopIt.body);

  // Scope, isolation, audit
  const crossEnroll = await call(`/api/v1/leads/${cl.id}/sequences`, { token: admin, workspace: COURSE, method: 'POST', body: { sequenceId: slow.body.id } });
  const abcR = await call('/api/v1/automation/rules', { token: abc, tenant: 'abc' });
  const logs = (await call('/api/v1/audit-logs', { token: admin })).body;
  check('sequences stay in their business line; another organization sees nothing; changes are audited', crossEnroll.status === 400 && (abcR.status === 403 || abcR.status === 400) && logs.some((l) => l.action === 'automation_rule.created') && logs.some((l) => l.action === 'sequence.created'), [crossEnroll.body, abcR.status]);
} finally {
  server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll automation checks passed');
process.exit(failures ? 1 : 0);
