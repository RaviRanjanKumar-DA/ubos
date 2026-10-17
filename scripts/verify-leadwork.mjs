// End-to-end checks for Phase 1.5a: bulk upload, bulk actions, calls & dispositions, remarks, status,
// follow-ups, assignment rules and lead detail.
// Usage: npm run verify:leadwork   (API running, freshly seeded; run `npm run db:seed` afterwards to reset)

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 240)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Tenant': tenant };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers['X-Workspace'] = workspace;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') =>
  (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;

const admin = await login('admin@mycompany.local');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const settings = (await call(`/api/v1/workspaces/${VASTU}/settings`, { token: admin })).body;
const consult = settings.pipelines.find((p) => p.name === 'Consultation');
const stage = Object.fromEntries(consult.stages.map((s) => [s.name, s.id]));
const users = (await call('/api/v1/users', { token: admin })).body;
const uid = (email) => users.find((u) => u.email === email).id;
const ARJUN = uid('rm@mycompany.local');
const NEHA = uid('manager@mycompany.local');

check('workspace settings include lead statuses, call dispositions and assignment rules',
  settings.statuses?.length >= 4 && settings.dispositions?.some((d) => d.connected) && settings.assignment?.mode === 'round_robin', settings.assignment);
const assignees = (await call(`/api/v1/workspaces/${VASTU}/assignees`, { token: admin })).body;
check('assignees are only people who work in Vastu', assignees.some((u) => u.id === ARJUN) && !assignees.some((u) => u.email === 'rm2@mycompany.local'), assignees.map?.((u) => u.name));
check('read-only roles (Auditor) are never offered as lead owners', !assignees.some((u) => u.email === 'auditor@mycompany.local'), assignees.map?.((u) => u.name));

// ── Bulk upload ──
const rows = [
  { name: 'Anil Kapoor', mobile: '98100 10001', email: 'anil@example.com', 'cf:property_type': 'office', 'cf:city': 'Delhi', status: 'Hot', remark: 'Wants office audit', follow_up: '05/11/2026' },
  { name: 'Bina Shah', mobile: '9810010002', 'cf:property_type': 'Home', source: 'Facebook' },
  { name: 'Priya Verma', mobile: '9876500002', 'cf:property_type': 'Shop' }, // existing customer (Course & Logo) → linked
  { name: 'Meera Joshi', mobile: '9876500020', 'cf:property_type': 'Home' }, // already has an open Vastu lead → duplicate
  { name: 'Anil again', mobile: '+91 98100 10001', 'cf:property_type': 'Home' }, // repeated in the file
  { name: 'No Phone', mobile: '' },
  { name: 'Bad Type', mobile: '9810010003', 'cf:property_type': 'Castle' },
  { name: 'Bad Date', mobile: '9810010004', 'cf:property_type': 'Home', follow_up: 'next week' },
  { name: 'Owned', mobile: '9810010005', 'cf:property_type': 'Plot', owner: 'manager@mycompany.local' },
  { name: 'Not In Vastu', mobile: '9810010006', 'cf:property_type': 'Plot', owner: 'rm2@mycompany.local' },
];
const body = { fileName: 'expo-leads.csv', pipelineId: consult.id, defaultSource: 'walk_in', assign: { mode: 'users', userIds: [ARJUN, NEHA] }, skipDuplicates: true, rows };
const rm = await login('arjun');
const rmImport = await call('/api/v1/leads/import/preview', { token: rm, workspace: VASTU, method: 'POST', body });
check('RM cannot bulk upload', rmImport.status === 403);
const preview = await call('/api/v1/leads/import/preview', { token: admin, workspace: VASTU, method: 'POST', body });
const st = (row) => preview.body.rows?.find((r) => r.row === row);
check('preview classifies rows: new / existing customer / duplicate / error',
  preview.status === 200 && st(2).status === 'new' && st(4).status === 'linked' && st(5).status === 'duplicate' && st(6).status === 'duplicate'
  && st(7).status === 'error' && st(8).status === 'error' && st(9).status === 'error' && st(11).status === 'error',
  preview.body.rows?.map((r) => `${r.row}:${r.status}`));
check('preview explains errors in plain words', /Property type/.test(st(8).message) && /not understood/.test(st(9).message) && /not a user of this business line/.test(st(11).message), [st(8).message, st(9).message, st(11).message]);
check('preview summary counts', preview.body.summary.willImport === 4 && preview.body.summary.errors === 4, preview.body.summary);
const noWs = await call('/api/v1/leads/import/preview', { token: admin, method: 'POST', body });
check('upload needs a business line to be selected', noWs.status === 400 && noWs.body.code === 'WORKSPACE_REQUIRED');

const commit = await call('/api/v1/leads/import/commit', { token: admin, workspace: VASTU, method: 'POST', body });
check('import creates the good rows and reports the rest', commit.status === 200 && commit.body.created === 4 && commit.body.linked === 1 && commit.body.skipped === 2 && commit.body.failed === 4, commit.body);
const vastuLeads = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body;
const anil = vastuLeads.find((l) => l.mobile === '+919810010001');
const owned = vastuLeads.find((l) => l.mobile === '+919810010005');
check('imported lead keeps status, custom fields and follow-up', anil?.status === 'hot' && anil.customFields.property_type === 'Office' && !!anil.nextFollowUpAt, anil);
check('owner column wins over round-robin', owned?.ownerId === NEHA, owned);
const imported = vastuLeads.filter((l) => ['+919810010001', '+919810010002', '+919876500002'].includes(l.mobile));
check('round-robin spreads the other rows over the chosen people', new Set(imported.map((l) => l.ownerId)).size === 2 && imported.every((l) => [ARJUN, NEHA].includes(l.ownerId)), imported.map((l) => l.owner));
const hist = (await call('/api/v1/leads/import/history', { token: admin, workspace: VASTU })).body;
check('upload history is kept with its errors', hist[0]?.fileName === 'expo-leads.csv' && hist[0].errors.length === 4, hist[0]);

// ── Calls, remarks, follow-ups ──
const leadId = anil.id;
const badDisp = await call(`/api/v1/leads/${leadId}/activities`, { token: admin, workspace: VASTU, method: 'POST', body: { type: 'call', disposition: 'teleported' } });
check('call needs a valid disposition', badDisp.status === 400 && badDisp.body.code === 'INVALID_DISPOSITION');
const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
const logged = await call(`/api/v1/leads/${leadId}/activities`, {
  token: admin, workspace: VASTU, method: 'POST',
  body: { type: 'call', disposition: 'interested', durationSec: 240, remark: 'Budget approved, wants audit next week', followUpAt: tomorrow, followUpNote: 'Fix audit date' },
});
const detail = (await call(`/api/v1/leads/${leadId}`, { token: admin, workspace: VASTU })).body;
check('logging a call saves disposition, remark and next follow-up', logged.status === 201 && detail.lastDisposition === 'interested' && detail.activities.some((a) => a.type === 'call' && a.connected === true) && detail.followUps.some((f) => !f.doneAt && f.note === 'Fix audit date'), detail.activities?.map((a) => a.type));
check('first response time is recorded on the first call', !!detail.firstResponseAt);
check('lead detail shows the journey: import, call, follow-up', ['import', 'call', 'follow_up'].every((t) => detail.activities.some((a) => a.type === t)));
const remark = await call(`/api/v1/leads/${leadId}/activities`, { token: admin, workspace: VASTU, method: 'POST', body: { type: 'remark', remark: 'Sent brochure on WhatsApp' } });
check('remarks can be added', remark.status === 201);
const open = detail.followUps.find((f) => !f.doneAt);
const done = await call(`/api/v1/follow-ups/${open.id}`, { token: admin, workspace: VASTU, method: 'PATCH', body: { done: true, outcome: 'Audit fixed for Monday' } });
check('a follow-up can be marked done', done.status === 200);

const arjunToday = await call('/api/v1/follow-ups?when=today', { token: rm, workspace: VASTU });
const arjunOverdue = await call('/api/v1/follow-ups?when=overdue', { token: rm, workspace: VASTU });
check("RM's follow-up lists show only their own leads", arjunToday.status === 200 && arjunOverdue.body.every((f) => f.owner === 'Arjun (RM)'), [arjunToday.body.length, arjunOverdue.body.map?.((f) => f.owner)]);
const overdueFilter = await call('/api/v1/leads?followUp=overdue', { token: admin, workspace: VASTU });
check('leads can be filtered by overdue follow-ups', overdueFilter.status === 200 && overdueFilter.body.length >= 1 && overdueFilter.body.every((l) => new Date(l.nextFollowUpAt) < new Date()), overdueFilter.body.length);

// ── Status & owner on one lead ──
const s1 = await call(`/api/v1/leads/${leadId}`, { token: admin, workspace: VASTU, method: 'PATCH', body: { status: 'warm' } });
const s2 = await call(`/api/v1/leads/${leadId}`, { token: admin, workspace: VASTU, method: 'PATCH', body: { status: 'lukewarm' } });
check('status changes; unknown status is refused', s1.status === 200 && s2.status === 400, s2.body);
const rmOwnerChange = await call(`/api/v1/leads/${leadId}`, { token: rm, workspace: VASTU, method: 'PATCH', body: { ownerId: ARJUN } });
check('RM cannot reassign leads', rmOwnerChange.status === 400 || rmOwnerChange.status === 403, rmOwnerChange);

// ── Bulk actions ──
const targets = vastuLeads.filter((l) => l.pipeline === 'Consultation').map((l) => l.id);
const bAssign = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: targets, action: 'assign', ownerIds: [ARJUN] } });
const afterAssign = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body.filter((l) => targets.includes(l.id));
check('bulk assign gives the selected leads to one person', bAssign.body.updated + bAssign.body.skipped.length === targets.length && afterAssign.every((l) => l.ownerId === ARJUN), bAssign.body);
const bWrong = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: targets.slice(0, 2), action: 'assign', ownerIds: [uid('rm2@mycompany.local')] } });
check('bulk assign skips people without access to the business line', bWrong.body.updated === 0 && bWrong.body.skipped.length === 2, bWrong.body);
const bStatus = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: targets, action: 'status', status: 'cold' } });
check('bulk status change', bStatus.body.updated >= 1 && bStatus.body.skipped.length === 0, bStatus.body);
const bLostNoReason = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: targets.slice(0, 2), action: 'stage', stageId: stage.Lost } });
check('bulk move to Lost needs a lost reason', bLostNoReason.body.updated === 0 && bLostNoReason.body.skipped.length === 2, bLostNoReason.body);
const bStage = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: targets.slice(0, 2), action: 'stage', stageId: stage.Interested } });
check('bulk stage change', bStage.body.updated === 2, bStage.body);
const bRemark = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: targets, action: 'remark', remark: 'Diwali offer shared' } });
check('bulk remark', bRemark.body.updated === targets.length, bRemark.body);
const bFollow = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: targets.slice(0, 3), action: 'follow_up', followUpAt: tomorrow, remark: 'Festival follow-up' } });
check('bulk follow-up scheduling', bFollow.body.updated === 3, bFollow.body);

const course = await login('rm2@mycompany.local');
const outside = await call('/api/v1/leads/bulk', { token: course, workspace: ws['Course / Software'], method: 'POST', body: { leadIds: targets.slice(0, 2), action: 'remark', remark: 'x' } });
check('bulk actions never touch leads outside your access', outside.body.updated === 0 && outside.body.skipped.every((s) => s.reason === 'Not in your access'), outside.body);
const rmBulkAssign = await call('/api/v1/leads/bulk', { token: rm, workspace: VASTU, method: 'POST', body: { leadIds: targets.slice(0, 2), action: 'assign', ownerIds: [ARJUN] } });
check('RM cannot bulk-assign', rmBulkAssign.body.updated === 0, rmBulkAssign.body);

// ── Assignment rules (sticky RM) ──
const ruleSave = await call(`/api/v1/workspaces/${VASTU}/assignment`, { token: admin, method: 'PUT', body: { mode: 'round_robin', userIds: [NEHA], sticky: true } });
check('admin saves assignment rules', ruleSave.status === 200);
const badRule = await call(`/api/v1/workspaces/${VASTU}/assignment`, { token: admin, method: 'PUT', body: { mode: 'fixed', userIds: [uid('rm2@mycompany.local')], sticky: true } });
check('rules only accept people of this business line', badRule.status === 400);
const stickyBody = { ...body, assign: { mode: 'rules', userIds: [] }, fileName: 'sticky.csv', rows: [{ name: 'Vikram Rao', mobile: '9876500021', 'cf:property_type': 'Office' }, { name: 'Brand New', mobile: '9810010099', 'cf:property_type': 'Home' }], skipDuplicates: false };
const sticky = await call('/api/v1/leads/import/commit', { token: admin, workspace: VASTU, method: 'POST', body: stickyBody });
const sl = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body;
const vik = sl.filter((l) => l.mobile === '+919876500021').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const fresh = sl.find((l) => l.mobile === '+919810010099');
check('returning customer goes back to their RM (sticky); new one follows round-robin pool', sticky.body.created === 2 && vik?.owner === 'Arjun (RM)' && fresh?.ownerId === NEHA, [vik?.owner, fresh?.owner]);

// ── Isolation & audit ──
const abc = await login('admin@abc.local', 'abc');
const foreign = await call(`/api/v1/leads/${leadId}`, { tenant: 'abc', token: abc });
check('another organization cannot open our leads', foreign.status === 404);
const logs = (await call('/api/v1/audit-logs', { token: admin })).body.map((l) => l.action);
check('imports, bulk actions and rule changes are audited', ['lead.imported', 'lead.bulk_assign', 'lead.bulk_stage', 'workspace.assignment_changed'].every((a) => logs.includes(a)), [...new Set(logs)].slice(0, 12));
const chain = (await call('/api/v1/audit-logs/verify', { token: admin })).body;
check('audit chain still verifies', chain.valid === true, chain);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
