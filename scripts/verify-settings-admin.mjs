// End-to-end checks for Phase 1.5b: stage rules, Lead ID, primary display fields, defaults, custom actions,
// flexible lead filters, add-lead options, user management (export / bulk / licences) and billing & orders.
// Usage: npm run verify:admin   (API running, freshly seeded; run `npm run db:seed` afterwards to reset)

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 240)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tenant) headers['X-Tenant'] = tenant;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers['X-Workspace'] = workspace;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, total: Number(res.headers.get('x-total-count') ?? NaN) };
}
const login = async (identifier, tenant = 'mycompany') =>
  (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const COURSE = ws['Course / Software'];
const users = (await call('/api/v1/users', { token: admin })).body;
const uid = (email) => users.find((u) => u.email === email).id;
const ARJUN = uid('rm@mycompany.local');
const NEHA = uid('manager@mycompany.local');
const SIMRAN = uid('rm2@mycompany.local');
const settings = async () => (await call(`/api/v1/workspaces/${VASTU}/settings`, { token: admin, workspace: VASTU })).body;
let s = await settings();
const consult = s.pipelines.find((p) => p.name === 'Consultation');
const stageId = (name) => consult.stages.find((x) => x.name === name).id;

// ── Defaults on statuses and call feedback ──
check('call feedback has a default ("Connected") and statuses have a default ("Fresh")',
  s.dispositions.find((d) => d.isDefault)?.value === 'connected' && s.statuses.find((d) => d.isDefault)?.value === 'fresh', [s.dispositions.find((d) => d.isDefault), s.statuses.find((d) => d.isDefault)]);
const twoDefaults = await call(`/api/v1/workspaces/${VASTU}/options/lead_status`, { token: admin, workspace: VASTU, method: 'PUT', body: { options: s.statuses.map((o) => ({ id: o.id, label: o.label, isDefault: true })) } });
check('only one default per list', twoDefaults.status === 400 && twoDefaults.body.code === 'ONE_DEFAULT', twoDefaults.body);
const sourceDefault = await call(`/api/v1/workspaces/${VASTU}/options/lead_source`, { token: admin, workspace: VASTU, method: 'PUT', body: { options: s.sources.map((o, i) => ({ id: o.id, label: o.label, isDefault: i === 0 })) } });
check('lists without a default (sources) refuse one', sourceDefault.status === 400 && sourceDefault.body.code === 'NO_DEFAULT', sourceDefault.body);
const renamed = await call(`/api/v1/workspaces/${VASTU}/options/lead_status`, { token: admin, workspace: VASTU, method: 'PUT', body: { options: s.statuses.map((o) => ({ id: o.id, label: o.value === 'hot' ? 'Very hot' : o.label, isDefault: o.isDefault })) } });
s = await settings();
check('renaming a status keeps its value, so existing leads show the new name', renamed.status === 200 && s.statuses.find((o) => o.value === 'hot')?.label === 'Very hot', s.statuses);

// ── Stage rules ──
const stagesBody = (extra) => ({ stages: consult.stages.map((x) => ({ id: x.id, name: x.name, isWon: x.isWon, isLost: x.isLost, ...(extra[x.name] ?? {}) })) });
const badRule = await call(`/api/v1/pipelines/${consult.id}/stages`, { token: admin, workspace: VASTU, method: 'PUT', body: stagesBody({ Negotiation: { requiredFieldKeys: ['no_such_field'] } }) });
check('stage rules must name real fields', badRule.status === 400, badRule.body);
const rules = await call(`/api/v1/pipelines/${consult.id}/stages`, {
  token: admin, workspace: VASTU, method: 'PUT',
  body: stagesBody({ New: { color: '#d6e6fb' }, Contacted: { slaDays: 2 }, Interested: { setStatus: 'hot', followUpDays: 1, slaDays: 5 }, Negotiation: { requiredFieldKeys: ['site_visit_date'] } }),
});
s = await settings();
const st = (name) => s.pipelines.find((p) => p.id === consult.id).stages.find((x) => x.name === name);
check('stage colour, SLA, auto status / follow-up and required fields are saved',
  rules.status === 200 && st('New').color === '#d6e6fb' && st('Contacted').slaDays === 2 && st('Interested').setStatus === 'hot' && st('Interested').followUpDays === 1 && st('Negotiation').requiredFieldKeys[0] === 'site_visit_date', [rules.body, st('Interested')]);

// ── Add a single lead with owner / status / remark / follow-up ──
const followUpAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
const add = await call('/api/v1/leads', {
  token: admin, workspace: VASTU, method: 'POST',
  body: { name: 'Gaurav Malhotra', mobile: '9810020001', email: 'gaurav@example.com', city: 'Noida', source: 'website', customFields: { property_type: 'Office' }, ownerId: ARJUN, status: 'warm', remark: 'Office of 2,000 sq ft', followUpAt },
});
const gaurav = add.status === 201 || add.status === 200 ? (await call(`/api/v1/leads/${add.body.id}`, { token: admin, workspace: VASTU })).body : null;
check('add lead: chosen owner, status, first remark and follow-up', gaurav?.owner?.id === ARJUN && gaurav.status === 'warm' && gaurav.activities.some((a) => a.type === 'remark' && /2,000/.test(a.remark)) && !!gaurav.nextFollowUpAt && gaurav.followUps.length === 1, gaurav ?? add.body);
check('add lead: city is saved on the customer', gaurav?.city === 'Noida', gaurav?.city);
const plain = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Hema Kulkarni', mobile: '9810020002', customFields: { property_type: 'Home' } } });
const hema = (await call(`/api/v1/leads/${plain.body.id}`, { token: admin, workspace: VASTU })).body;
check('add lead without a status gets the default status; creator owns it', hema.status === 'fresh' && hema.owner?.id === me.user.id, [hema.status, hema.owner]);
const byRules = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Inder Pal', mobile: '9810020003', customFields: { property_type: 'Shop' }, ownerId: 'rules' } });
const eligible = (await call(`/api/v1/workspaces/${VASTU}/assignees`, { token: admin, workspace: VASTU })).body.map((u) => u.id);
check('add lead with "assignment rules" picks someone from the business line', byRules.status === 201 && eligible.includes(byRules.body.ownerId), byRules.body);
const rmForOther = await call('/api/v1/leads', { token: rm, workspace: VASTU, method: 'POST', body: { name: 'Jaya Rao', mobile: '9810020004', customFields: { property_type: 'Home' }, ownerId: NEHA } });
check('RM cannot add a lead for someone else', rmForOther.status === 400 && rmForOther.body.code === 'PERMISSION_DENIED', rmForOther.body);
const outsider = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Jaya Rao', mobile: '9810020004', customFields: { property_type: 'Home' }, ownerId: SIMRAN } });
check('owner must work in this business line', outsider.status === 400 && outsider.body.code === 'INVALID_OWNER', outsider.body);
const badStatus = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Jaya Rao', mobile: '9810020004', customFields: { property_type: 'Home' }, status: 'boiling' } });
check('unknown status is refused', badStatus.status === 400, badStatus.body);

// ── Stage rules in action ──
const toInterested = await call(`/api/v1/leads/${gaurav.id}/stage`, { token: rm, workspace: VASTU, method: 'PATCH', body: { stageId: stageId('Interested') } });
const afterInterested = (await call(`/api/v1/leads/${gaurav.id}`, { token: rm, workspace: VASTU })).body;
check('moving to Interested sets the status to hot and plans a follow-up', toInterested.status === 200 && afterInterested.status === 'hot' && afterInterested.followUps.filter((f) => !f.doneAt).length === 2, [toInterested.body, afterInterested.status, afterInterested.followUps]);
check('stage change is on the journey with its date', afterInterested.activities.some((a) => a.type === 'stage') && Date.now() - new Date(afterInterested.stageChangedAt).getTime() < 60_000, afterInterested.stageChangedAt);
const blocked = await call(`/api/v1/leads/${gaurav.id}/stage`, { token: rm, workspace: VASTU, method: 'PATCH', body: { stageId: stageId('Negotiation') } });
check('a stage that needs a field refuses until it is filled', blocked.status === 400 && blocked.body.code === 'STAGE_RULE' && /Site visit date/.test(blocked.body.message), blocked.body);
const bulkBlocked = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: [gaurav.id, hema.id], action: 'stage', stageId: stageId('Negotiation') } });
check('bulk stage change follows the same rules', bulkBlocked.status === 200 && bulkBlocked.body.updated === 0 && bulkBlocked.body.skipped.length === 2 && /Site visit date/.test(bulkBlocked.body.skipped[0]?.reason ?? ''), bulkBlocked.body);
const singleBlocked = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: [gaurav.id], action: 'stage', stageId: stageId('Negotiation') } });
check('for a single lead the rule is shown as an error', singleBlocked.status >= 400 && /Site visit date/.test(singleBlocked.body.message), singleBlocked.body);
await call(`/api/v1/leads/${gaurav.id}/fields`, { token: rm, workspace: VASTU, method: 'PATCH', body: { customFields: { property_type: 'Office', site_visit_date: '2026-11-05' } } });
const allowed = await call(`/api/v1/leads/${gaurav.id}/stage`, { token: rm, workspace: VASTU, method: 'PATCH', body: { stageId: stageId('Negotiation') } });
check('after filling the field the move works', allowed.status === 200, allowed.body);

// ── Display fields ──
const disp = await call(`/api/v1/workspaces/${VASTU}/display`, { token: admin, workspace: VASTU, method: 'PUT', body: { h1: 'name', h2: 'cf:property_type' } });
s = await settings();
check('primary display fields (H1 / H2) can use a lead field', disp.status === 200 && s.display.h1 === 'name' && s.display.h2 === 'cf:property_type', s.display);
const badDisp = await call(`/api/v1/workspaces/${VASTU}/display`, { token: admin, workspace: VASTU, method: 'PUT', body: { h1: 'passwordHash', h2: 'mobile' } });
check('display fields are limited to safe values', badDisp.status === 400 && badDisp.body.code === 'INVALID_DISPLAY', badDisp.body);
const rmDisp = await call(`/api/v1/workspaces/${VASTU}/display`, { token: rm, workspace: VASTU, method: 'PUT', body: { h1: 'name', h2: 'mobile' } });
check('RM cannot change display fields', rmDisp.status === 403, rmDisp.status);

// ── Flexible filters ──
const list = (qs, token = admin) => call(`/api/v1/leads?${qs}`, { token, workspace: VASTU });
const all = await list('');
check('list returns the total in X-Total-Count and rows carry stage colour, days in stage and score',
  all.status === 200 && all.total === all.body.length && all.body.every((l) => 'stageColor' in l && typeof l.inStageDays === 'number' && typeof l.score === 'number'), all.body[0]);
const multiStage = await list(`stageIds=${stageId('New')},${stageId('Negotiation')}`);
check('several stages at once', multiStage.body.length > 0 && multiStage.body.every((l) => [stageId('New'), stageId('Negotiation')].includes(l.stageId)) && multiStage.body.some((l) => l.id === gaurav.id), multiStage.body.map((l) => l.stage));
const statuses = await list('statuses=hot,warm');
check('several statuses at once', statuses.body.length > 0 && statuses.body.every((l) => ['hot', 'warm'].includes(l.status)), statuses.body.map((l) => l.status));
const mine = await list('owners=me', rm);
check('owners=me for an RM', mine.body.length > 0 && mine.body.every((l) => l.ownerId === ARJUN), mine.body.map((l) => l.owner));
const two = await list(`owners=${ARJUN},${NEHA}`);
check('several owners at once', two.body.some((l) => l.ownerId === ARJUN) && two.body.some((l) => l.ownerId === NEHA) && two.body.every((l) => [ARJUN, NEHA].includes(l.ownerId)), two.body.map((l) => l.owner));
const office = await list('cf_property_type=Office');
check('filter by a custom field', office.body.length >= 1 && office.body.every((l) => l.customFields.property_type === 'Office'), office.body.map((l) => l.customFields));
const notCalled = await list('contacted=no');
const called = await list('contacted=yes');
check('worked / not worked yet split the list', notCalled.total + called.total === all.total && called.body.every((l) => l.lastActivityAt) && notCalled.body.every((l) => !l.lastActivityAt), [notCalled.total, called.total, all.total]);
const today = new Date().toISOString().slice(0, 10);
const createdToday = await list(`createdFrom=${today}&createdTo=${today}`);
check('created-date range', createdToday.body.some((l) => l.id === gaurav.id), createdToday.total);
const future = await list('createdFrom=2099-01-01');
check('a range with nothing in it returns nothing', future.total === 0 && future.body.length === 0, future.total);
const followRange = await list(`followUpFrom=${today}&followUpTo=${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}`);
check('follow-up date range', followRange.body.some((l) => l.id === gaurav.id), followRange.total);
const stuck = await list('stuck=yes');
check('stuck filter only returns leads past their stage SLA', stuck.status === 200 && stuck.body.every((l) => l.slaBreached), stuck.body.map((l) => [l.stage, l.inStageDays]));
const combined = await list(`statuses=hot&owners=${ARJUN}&stageIds=${stageId('Negotiation')}&cf_property_type=Office`);
check('filters combine', combined.body.length === 1 && combined.body[0].id === gaurav.id, combined.body.map((l) => l.name));
const badFilter = await list('scoreMin=abc');
check('invalid filter values are refused politely', badFilter.status === 400, badFilter.status);
const exportFiltered = await call(`/api/v1/leads/export?cf_property_type=Office`, { token: admin, workspace: VASTU });
check('export uses the same filters', exportFiltered.status === 200 && /Gaurav Malhotra/.test(exportFiltered.body) && !/Hema Kulkarni/.test(exportFiltered.body), String(exportFiltered.body).slice(0, 120));

// ── Lead ID: email mode ──
const mgrLeadId = await call('/api/v1/settings/lead-identifier', { token: manager, method: 'PUT', body: { leadIdentifier: 'email' } });
check('only organization admins change the Lead ID', mgrLeadId.status === 403, mgrLeadId.status);
await call('/api/v1/settings/lead-identifier', { token: admin, method: 'PUT', body: { leadIdentifier: 'email' } });
const noEmail = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Kiran Bedi', mobile: '9810020005', customFields: { property_type: 'Home' } } });
check('email mode: email is required', noEmail.status === 400 && noEmail.body.code === 'EMAIL_REQUIRED', noEmail.body);
const emailOnly = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Kiran Bedi', email: 'kiran@example.com', customFields: { property_type: 'Home' } } });
check('email mode: a lead without mobile is fine', emailOnly.status === 201, emailOnly.body);
const sameEmail = await call('/api/v1/leads', { token: admin, workspace: COURSE, method: 'POST', body: { name: 'Kiran B', email: 'KIRAN@example.com', mobile: '9810020006', customFields: { course: 'Numerology Basic' } } });
const k1 = (await call(`/api/v1/leads/${emailOnly.body.id}`, { token: admin, workspace: VASTU })).body;
const k2 = (await call(`/api/v1/leads/${sameEmail.body.id}`, { token: admin, workspace: COURSE })).body;
check('email mode: the same email links to the same customer in another business line', sameEmail.status === 201 && k1.customerId === k2.customerId, [k1.customerId, k2.customerId]);
await call('/api/v1/settings/lead-identifier', { token: admin, method: 'PUT', body: { leadIdentifier: 'mobile' } });
const backToMobile = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Lalit Jain', email: 'lalit@example.com', customFields: { property_type: 'Home' } } });
check('mobile mode again: mobile is required', backToMobile.status === 400 && backToMobile.body.code === 'MOBILE_REQUIRED', backToMobile.body);

// ── Custom actions ──
const actionBody = {
  name: 'Site visit report', description: 'After visiting the property', workspaceId: VASTU, score: 20,
  fields: [{ label: 'Visit outcome', type: 'dropdown', options: ['Ready to buy', 'Thinking', 'Not interested'], required: true }, { label: 'Notes', type: 'textarea' }],
};
const rmAction = await call('/api/v1/custom-actions', { token: rm, workspace: VASTU, method: 'POST', body: actionBody });
const mgrAction = await call('/api/v1/custom-actions', { token: manager, workspace: VASTU, method: 'POST', body: actionBody });
check('RM and Manager cannot create custom actions', rmAction.status === 403 && mgrAction.status === 403, [rmAction.status, mgrAction.status]);
const noOptions = await call('/api/v1/custom-actions', { token: admin, workspace: VASTU, method: 'POST', body: { ...actionBody, fields: [{ label: 'Pick', type: 'dropdown' }] } });
check('dropdown questions need options', noOptions.status === 400 && noOptions.body.code === 'OPTIONS_REQUIRED', noOptions.body);
const created = await call('/api/v1/custom-actions', { token: admin, workspace: VASTU, method: 'POST', body: actionBody });
const action = created.body;
check('admin creates an action with a numeric code and question keys', created.status === 201 && action.code >= 1001 && action.fields[0].key === 'visit_outcome', action);
const rmList = await call(`/api/v1/custom-actions?workspaceId=${VASTU}`, { token: rm, workspace: VASTU });
check('RM sees the action (to run it) but cannot manage it', rmList.body.some((x) => x.id === action.id && !x.canManage), rmList.body.map((x) => [x.name, x.canManage]));
const missing = await call(`/api/v1/leads/${gaurav.id}/actions/${action.id}`, { token: rm, workspace: VASTU, method: 'POST', body: { answers: { notes: 'Nice place' } } });
check('required answers are enforced', missing.status === 400 && missing.body.code === 'INVALID_ANSWERS', missing.body);
const wrongOption = await call(`/api/v1/leads/${gaurav.id}/actions/${action.id}`, { token: rm, workspace: VASTU, method: 'POST', body: { answers: { visit_outcome: 'Maybe' } } });
check('answers must be one of the options', wrongOption.status === 400, wrongOption.body);
const ran = await call(`/api/v1/leads/${gaurav.id}/actions/${action.id}`, { token: rm, workspace: VASTU, method: 'POST', body: { answers: { visit_outcome: 'Ready to buy', notes: 'Wants report in a week' } } });
const afterRun = (await call(`/api/v1/leads/${gaurav.id}`, { token: rm, workspace: VASTU })).body;
check('running an action adds its score and puts the answers on the journey',
  ran.status === 201 && ran.body.leadScore === 20 && afterRun.score === 20 && afterRun.activities.some((a) => a.type === 'action' && a.data.answers.visit_outcome === 'Ready to buy'), [ran.body, afterRun.score]);
const scoreFilter = await list('scoreMin=10&sort=score_desc');
check('score filter and "highest score" sort', scoreFilter.body[0]?.id === gaurav.id && scoreFilter.body.every((l) => l.score >= 10), scoreFilter.body.map((l) => [l.name, l.score]));
const otherWs = await call('/api/v1/leads', { token: admin, workspace: COURSE });
const courseLead = otherWs.body[0];
const wrongWs = await call(`/api/v1/leads/${courseLead.id}/actions/${action.id}`, { token: admin, workspace: COURSE, method: 'POST', body: { answers: { visit_outcome: 'Thinking' } } });
check('a business-line action cannot run on a lead of another line', wrongWs.status === 400 && wrongWs.body.code === 'ACTION_NOT_FOR_WORKSPACE', wrongWs.body);
const notMine = await call(`/api/v1/leads/${hema.id}/actions/${action.id}`, { token: rm, workspace: VASTU, method: 'POST', body: { answers: { visit_outcome: 'Thinking' } } });
check('RM cannot run an action on a lead they do not own', notMine.status === 404, notMine.status);
const dup = await call(`/api/v1/custom-actions/${action.id}/duplicate`, { token: admin, workspace: VASTU, method: 'POST' });
check('duplicate gives a new code', (dup.status === 201 || dup.status === 200) && dup.body.code > action.code && /copy/i.test(dup.body.name), dup.body);
const edit = await call(`/api/v1/custom-actions/${action.id}`, { token: admin, workspace: VASTU, method: 'PATCH', body: { ...actionBody, score: 25, fields: [{ ...action.fields[0] }, { key: action.fields[1].key, label: 'Visit notes', type: 'textarea' }] } });
check('editing keeps question keys so old answers still match', edit.status === 200 && edit.body.fields[1].key === 'notes' && edit.body.score === 25, edit.body);
await call(`/api/v1/custom-actions/${action.id}`, { token: admin, workspace: VASTU, method: 'PATCH', body: { isArchived: true } });
const active = await call(`/api/v1/custom-actions?workspaceId=${VASTU}`, { token: admin, workspace: VASTU });
const archived = await call(`/api/v1/custom-actions?workspaceId=${VASTU}&archived=true`, { token: admin, workspace: VASTU });
check('archived actions move to the Archived tab and keep their usage count', !active.body.some((x) => x.id === action.id) && archived.body.find((x) => x.id === action.id)?.timesUsed === 1, archived.body);
const runArchived = await call(`/api/v1/leads/${gaurav.id}/actions/${action.id}`, { token: rm, workspace: VASTU, method: 'POST', body: { answers: { visit_outcome: 'Thinking' } } });
check('archived actions cannot be run', runArchived.status === 400 && runArchived.body.code === 'ACTION_ARCHIVED', runArchived.body);

// ── Users: licences, export, bulk add ──
const lic = await call('/api/v1/users/licences', { token: admin });
check('licence summary', lic.status === 200 && lic.body.licences >= lic.body.used && lic.body.used >= 5, lic.body);
const csv = await call('/api/v1/users/export', { token: admin });
check('admin exports users as CSV with roles and licence columns', csv.status === 200 && /Licence expiry/.test(csv.body) && /Arjun \(RM\)/.test(csv.body) && !/passwordHash/.test(csv.body), String(csv.body).slice(0, 160));
const rmCsv = await call('/api/v1/users/export', { token: rm });
check('RM cannot export users', rmCsv.status === 403, rmCsv.status);

const abc = await login('admin@abc.local', 'abc');
const abcLic = (await call('/api/v1/users/licences', { token: abc, tenant: 'abc' })).body;
const bulkRows = [
  { name: 'Asha Nair', email: 'asha@abc.local', mobile: '9811200001', role: 'RM', workspace: 'Education' },
  { name: 'Bharat Singh', email: 'bharat@abc.local', role: 'Manager', workspace: 'All' },
  { name: 'Chitra Das', email: 'chitra@abc.local', role: 'Wizard', workspace: 'Education' },
  { name: 'Dev Anand', email: 'asha@abc.local', role: 'RM', workspace: 'Education' },
  { name: 'Esha Gupta', email: 'esha@abc.local', role: 'RM', workspace: 'Space Travel' },
  { name: 'Farhan Ali', email: 'admin@abc.local', role: 'RM', workspace: 'Education' },
  { name: 'Gita Rao', email: 'gita@abc.local', mobile: '12345', role: 'RM', workspace: 'Education' },
  { name: 'Hari Om', email: 'hari@abc.local', role: 'RM', workspace: 'Real Estate' },
  { name: 'Indu Sen', email: 'indu@abc.local', role: 'RM', workspace: 'Real Estate' },
  { name: 'Jatin Roy', email: 'jatin@abc.local', role: 'RM', workspace: 'Real Estate' },
];
const dry = await call('/api/v1/users/bulk', { token: abc, tenant: 'abc', method: 'POST', body: { dryRun: true, sendInvite: false, rows: bulkRows } });
const msgOf = (row) => dry.body.results?.find((r) => r.row === row)?.message ?? '';
check('bulk check explains each problem row', dry.status === 200 && /Unknown role/.test(msgOf(4)) && /earlier in this file/.test(msgOf(5)) && /Unknown workspace/.test(msgOf(6)) && /already/i.test(msgOf(7)) && /valid mobile/.test(msgOf(8)), dry.body.results);
check('bulk check stops at the free licences', abcLic.available === 4 && dry.body.ok === 4 && /licence/.test(msgOf(11)), [abcLic, dry.body.ok, msgOf(11)]);
const stillSame = (await call('/api/v1/users', { token: abc, tenant: 'abc' })).body.length;
check('a check creates nobody', stillSame === 1, stillSame);
const rmBulk = await call('/api/v1/users/bulk', { token: rm, method: 'POST', body: { dryRun: true, rows: bulkRows } });
check('RM cannot bulk add users', rmBulk.status === 403, rmBulk.status);
const commit = await call('/api/v1/users/bulk', { token: abc, tenant: 'abc', method: 'POST', body: { dryRun: false, sendInvite: false, rows: bulkRows } });
const abcUsers = (await call('/api/v1/users', { token: abc, tenant: 'abc' })).body;
const asha = abcUsers.find((u) => u.email === 'asha@abc.local');
check('bulk add creates the valid people with their roles and no password in the reply',
  commit.body.ok === 4 && abcUsers.length === 5 && asha?.roles[0]?.role === 'RM' && asha.roles[0].workspace === 'Education' && asha.mustChangePassword && !JSON.stringify(commit.body).includes('temporaryPassword'), [commit.body.ok, abcUsers.length, asha?.roles]);

// ── Billing ──
const cat = await call('/api/v1/billing/catalog', { token: abc, tenant: 'abc' });
const core = cat.body.licences?.find((l) => l.code === 'core_crm');
check('catalogue: licences with quarterly / annual prices and services', cat.status === 200 && cat.body.gstPct === 18 && core.quarterlyPaise === core.monthlyPaise * 3 && core.annualPaise === Math.round((core.monthlyPaise * 12 * (100 - core.annualDiscountPct)) / 100) && cat.body.services.length >= 3, core);
const rmBilling = await call('/api/v1/billing/catalog', { token: rm });
check('billing needs billing access', rmBilling.status === 403, rmBilling.status);
const twoPlans = await call('/api/v1/billing/orders', { token: abc, tenant: 'abc', method: 'POST', body: { cycle: 'annual', items: [{ productCode: 'core_crm', quantity: 2 }, { productCode: 'core_crm_whatsapp', quantity: 2 }] } });
check('one licence type per order', twoPlans.status === 400 && twoPlans.body.code === 'ONE_PLAN', twoPlans.body);
const unknown = await call('/api/v1/billing/orders', { token: abc, tenant: 'abc', method: 'POST', body: { cycle: 'annual', items: [{ productCode: 'free_money', quantity: 1 }] } });
check('unknown products are refused', unknown.status === 400 && unknown.body.code === 'UNKNOWN_PRODUCT', unknown.body);
const first = await call('/api/v1/billing/orders', { token: abc, tenant: 'abc', method: 'POST', body: { cycle: 'quarterly', items: [{ productCode: 'core_crm', quantity: 3 }] } });
const cancel = await call(`/api/v1/billing/orders/${first.body.id}/cancel`, { token: abc, tenant: 'abc', method: 'POST' });
const cancelAgain = await call(`/api/v1/billing/orders/${first.body.id}/cancel`, { token: abc, tenant: 'abc', method: 'POST' });
check('a pending order can be cancelled once', first.status === 201 && cancel.status === 200 && cancelAgain.status === 409, [first.status, cancel.status, cancelAgain.status]);
const order = await call('/api/v1/billing/orders', { token: abc, tenant: 'abc', method: 'POST', body: { cycle: 'annual', items: [{ productCode: 'core_crm', quantity: 10 }, { productCode: 'whatsapp_setup', quantity: 1 }] } });
const setup = cat.body.services.find((x) => x.code === 'whatsapp_setup');
const expectSub = core.annualPaise * 10 + setup.pricePaise;
check('order totals: licences × cycle price + services + 18% GST', order.status === 201 && order.body.status === 'pending' && order.body.subtotalPaise === expectSub && order.body.gstPaise === Math.round(expectSub * 0.18) && order.body.totalPaise === expectSub + order.body.gstPaise && /^UB-\d{6}-[A-Z0-9]{5}$/.test(order.body.number), order.body);
const hist = await call('/api/v1/billing/orders?status=pending', { token: abc, tenant: 'abc' });
const histCancelled = await call('/api/v1/billing/orders?status=cancelled&cycle=quarterly', { token: abc, tenant: 'abc' });
check('transaction history filters by status and cycle', hist.body.some((o) => o.id === order.body.id) && hist.body.every((o) => o.status === 'pending') && histCancelled.body.length === 1 && histCancelled.body[0].id === first.body.id, [hist.body.length, histCancelled.body.length]);
const ownOrders = await call('/api/v1/billing/orders', { token: admin });
check('organizations only see their own orders', ownOrders.status === 200 && !ownOrders.body.some((o) => o.id === order.body.id), ownOrders.body.length);
const tenantMarks = await call(`/platform/v1/orders/${order.body.id}/mark-paid`, { token: abc, tenant: null, method: 'POST', body: { paymentRef: 'UTR123' } });
check('an organization cannot mark its own order paid', tenantMarks.status === 401 || tenantMarks.status === 403, tenantMarks.status);
const owner = (await call('/platform/v1/auth/login', { tenant: null, method: 'POST', body: { email: 'owner@ubos.local', password: PASSWORD } })).body.accessToken;
const pOrders = await call('/platform/v1/orders', { token: owner, tenant: null });
check('Platform Console lists orders of every organization with the company name', pOrders.status === 200 && pOrders.body.find((o) => o.id === order.body.id)?.tenant?.slug === 'abc', pOrders.body.length);
const products = await call('/platform/v1/products', { token: owner, tenant: null });
check('Platform Console lists products and prices', products.status === 200 && products.body.some((p) => p.code === 'core_crm'), products.body.length);
const noRef = await call(`/platform/v1/orders/${order.body.id}/mark-paid`, { token: owner, tenant: null, method: 'POST', body: {} });
check('marking paid needs a payment reference', noRef.status === 400, noRef.status);
const paid = await call(`/platform/v1/orders/${order.body.id}/mark-paid`, { token: owner, tenant: null, method: 'POST', body: { paymentRef: 'UTR-2026-0001' } });
const abcAfter = (await call('/api/v1/users/licences', { token: abc, tenant: 'abc' })).body;
check('paying a trial order activates the plan with the bought licences for a year',
  paid.status === 200 && abcAfter.status === 'active' && abcAfter.licences === 10 && abcAfter.available === 5 && new Date(abcAfter.expiresAt) > new Date(Date.now() + 360 * 86_400_000), abcAfter);
const paidTwice = await call(`/platform/v1/orders/${order.body.id}/mark-paid`, { token: owner, tenant: null, method: 'POST', body: { paymentRef: 'UTR-2026-0001' } });
check('an order is applied only once', paidTwice.status === 409, paidTwice.status);
const more = await call('/api/v1/billing/orders', { token: abc, tenant: 'abc', method: 'POST', body: { cycle: 'annual', items: [{ productCode: 'core_crm', quantity: 2 }] } });
await call(`/platform/v1/orders/${more.body.id}/mark-paid`, { token: owner, tenant: null, method: 'POST', body: { paymentRef: 'UTR-2026-0002' } });
const abcMore = (await call('/api/v1/users/licences', { token: abc, tenant: 'abc' })).body;
check('a later order on an active plan adds licences', abcMore.licences === 12, abcMore);
const paidHist = (await call('/api/v1/billing/orders?status=paid', { token: abc, tenant: 'abc' })).body;
check('paid orders show the payment reference in the history', paidHist.some((o) => o.paymentRef === 'UTR-2026-0001' && o.paidAt), paidHist.map((o) => o.paymentRef));
const audit = (await call('/api/v1/audit-logs', { token: abc, tenant: 'abc' })).body;
const chain = (await call('/api/v1/audit-logs/verify', { token: abc, tenant: 'abc' })).body;
check('orders are on the audit log and the chain is intact', JSON.stringify(audit).includes('billing.order_placed') && chain.valid, chain);

// ── Isolation ──
const abcActions = await call('/api/v1/custom-actions?archived=true', { token: abc, tenant: 'abc' });
check('custom actions never leak across organizations', abcActions.status === 200 && !abcActions.body.some((x) => x.id === action.id), abcActions.body.length);
const abcLead = (await call('/api/v1/leads', { token: abc, tenant: 'abc' })).body[0];
const crossRun = await call(`/api/v1/leads/${abcLead.id}/actions/${dup.body.id}`, { token: abc, tenant: 'abc', method: 'POST', body: { answers: { visit_outcome: 'Thinking' } } });
check('an action of another organization cannot be run', crossRun.status === 404, crossRun.status);
const crossFilter = await call(`/api/v1/leads?owners=${ARJUN}`, { token: abc, tenant: 'abc' });
check('owner filters cannot reach another organization', crossFilter.status === 200 && crossFilter.body.length === 0, crossFilter.body.length);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll settings & admin checks passed.');
process.exit(failures ? 1 : 0);
