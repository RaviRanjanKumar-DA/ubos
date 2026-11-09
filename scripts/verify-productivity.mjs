// End-to-end checks for Phase 1.5c: labels, alternate emails, field-level security, smart views, tasks & calendar,
// mentions & notifications, goals, call scripts, reminders / daily summary / dashboard emails, Excel bulk update,
// past-activity import and activity export.
// Usage: npm run verify:productivity   (API + Mailpit running, freshly seeded; run `npm run db:seed` afterwards)

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 260)}` : ''}`);
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
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') =>
  (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
// The API's own scheduler also runs every minute, so emails are checked by arrival time, not by which run sent them.
const suiteStart = Date.now() - 5_000;
const mails = async () => ((await (await fetch(`${MAILPIT}/api/v1/messages?limit=500`)).json()).messages ?? []).filter((m) => new Date(m.Created).getTime() >= suiteStart);
const mailTo = async (addr, re) => (await mails()).filter((m) => m.To.some((t) => t.Address === addr) && re.test(m.Subject));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const rm2 = await login('rm2@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const COURSE = ws['Course / Software'];
const users = (await call('/api/v1/users', { token: admin })).body;
const uid = (email) => users.find((u) => u.email === email).id;
const ARJUN = uid('rm@mycompany.local');
const NEHA = uid('manager@mycompany.local');
const SIMRAN = uid('rm2@mycompany.local');
const roles = (await call('/api/v1/roles', { token: admin })).body;
const RM_ROLE = roles.find((r) => r.name === 'RM').id;
const ADMIN_ROLE = roles.find((r) => r.name === 'Organization Admin').id;
const vastuLeads = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body;
const arjunLead = vastuLeads.find((l) => l.ownerId === ARJUN);
const nehaLead = vastuLeads.find((l) => l.ownerId === NEHA);
const settings = (await call(`/api/v1/workspaces/${VASTU}/settings`, { token: admin, workspace: VASTU })).body;
const consult = settings.pipelines.find((p) => p.name === 'Consultation');

// ── Labels ──
const vip = await call('/api/v1/labels', { token: admin, method: 'POST', body: { name: 'VIP', color: '#d6455d', workspaceId: null } });
const siteDue = await call('/api/v1/labels', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Site visit due', color: '#1f9d55', workspaceId: VASTU } });
const courseLabel = await call('/api/v1/labels', { token: admin, workspace: COURSE, method: 'POST', body: { name: 'Scholarship', workspaceId: COURSE } });
check('admins create organization-wide and business-line labels', vip.status === 201 && siteDue.status === 201 && courseLabel.status === 201, [vip.body, siteDue.body]);
const dupLabel = await call('/api/v1/labels', { token: admin, method: 'POST', body: { name: 'vip', workspaceId: null } });
const rmLabel = await call('/api/v1/labels', { token: rm, workspace: VASTU, method: 'POST', body: { name: 'Mine', workspaceId: VASTU } });
const mgrOrgLabel = await call('/api/v1/labels', { token: manager, workspace: VASTU, method: 'POST', body: { name: 'Everyone', workspaceId: null } });
check('label names are unique; RMs and managers cannot add organization labels', dupLabel.status === 400 && rmLabel.status === 403 && mgrOrgLabel.status === 403, [dupLabel.status, rmLabel.status, mgrOrgLabel.status]);
const vastuLabels = (await call('/api/v1/labels', { token: rm, workspace: VASTU })).body.map((l) => l.name);
check('a business line shows its own and organization labels only', vastuLabels.includes('VIP') && vastuLabels.includes('Site visit due') && !vastuLabels.includes('Scholarship'), vastuLabels);
const setLabels = await call(`/api/v1/leads/${arjunLead.id}/labels`, { token: rm, workspace: VASTU, method: 'PUT', body: { labelIds: [vip.body.id, siteDue.body.id] } });
const wrongLabel = await call(`/api/v1/leads/${arjunLead.id}/labels`, { token: rm, workspace: VASTU, method: 'PUT', body: { labelIds: [courseLabel.body.id] } });
check('labels on a lead; labels of another business line are refused', setLabels.status === 200 && setLabels.body.labelIds.length === 2 && wrongLabel.status === 400, [setLabels.body, wrongLabel.body]);
const notMine = await call(`/api/v1/leads/${nehaLead.id}/labels`, { token: rm, workspace: VASTU, method: 'PUT', body: { labelIds: [vip.body.id] } });
check('an RM cannot label someone else’s lead', notMine.status === 404 || notMine.status === 403, notMine.status);
const bulkLabels = await call('/api/v1/leads/bulk', { token: admin, workspace: VASTU, method: 'POST', body: { leadIds: vastuLeads.slice(0, 3).map((l) => l.id), action: 'labels', addLabelIds: [vip.body.id], removeLabelIds: [siteDue.body.id] } });
const byLabel = (await call(`/api/v1/leads?labelIds=${vip.body.id}`, { token: admin, workspace: VASTU })).body;
check('bulk add / remove labels and filter by label', bulkLabels.body.updated === 3 && byLabel.length >= 3 && byLabel.every((l) => l.labelIds.includes(vip.body.id) && !l.labelIds.includes(siteDue.body.id)), [bulkLabels.body, byLabel.map((l) => l.labelIds)]);
await call(`/api/v1/labels/${courseLabel.body.id}`, { token: admin, workspace: COURSE, method: 'PATCH', body: { isArchived: true } });
const afterArchive = (await call('/api/v1/labels', { token: admin, workspace: COURSE })).body.map((l) => l.name);
check('archived labels leave the picker', !afterArchive.includes('Scholarship'), afterArchive);

// ── Alternate emails ──
const priya = (await call('/api/v1/customers?q=Priya Verma', { token: admin })).body.find((c) => c.code === 'C00002');
const alt = await call(`/api/v1/customers/${priya.id}`, { token: admin, method: 'PATCH', body: { alternateEmails: ['priya.work@example.com', 'PRIYA.Home@example.com'] } });
const priyaAfter = (await call(`/api/v1/customers/${priya.id}`, { token: admin })).body;
check('alternate emails are saved (lower-case)', alt.status === 200 && priyaAfter.alternateEmails.includes('priya.home@example.com'), priyaAfter.alternateEmails);
const taken = await call(`/api/v1/customers/${(await call('/api/v1/customers?q=Rohit', { token: admin })).body[0].id}`, { token: admin, method: 'PATCH', body: { alternateEmails: ['priya.work@example.com'] } });
check('an email already on another customer is refused', taken.status === 409, taken.body);
const viaAlt = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Priya V', mobile: '9810030001', email: 'priya.work@example.com', customFields: { property_type: 'Home' } } });
const viaAltLead = (await call(`/api/v1/leads/${viaAlt.body.id}`, { token: admin, workspace: VASTU })).body;
check('a new enquiry from an alternate email links to the same customer', viaAltLead.customerId === priya.id, [viaAltLead.customerId, priya.id]);

// ── Field-level security ──
const ruleFields = (await call('/api/v1/field-rules/fields', { token: admin })).body;
check('rule fields list contact details and custom fields', ruleFields.some((f) => f.field === 'mobile') && ruleFields.some((f) => f.field === 'cf:property_type'), ruleFields.map((f) => f.field));
const adminRules = await call(`/api/v1/roles/${ADMIN_ROLE}/field-rules`, { token: admin, method: 'PUT', body: { rules: [{ field: 'mobile', visibility: 'hidden' }] } });
const badField = await call(`/api/v1/roles/${RM_ROLE}/field-rules`, { token: admin, method: 'PUT', body: { rules: [{ field: 'cf:nope', visibility: 'hidden' }] } });
const mgrRules = await call(`/api/v1/roles/${RM_ROLE}/field-rules`, { token: manager, workspace: VASTU, method: 'PUT', body: { rules: [] } });
check('admin role cannot be restricted; unknown fields and non-admins refused', adminRules.status === 400 && badField.status === 400 && mgrRules.status === 403, [adminRules.status, badField.status, mgrRules.status]);
await call(`/api/v1/roles/${RM_ROLE}/field-rules`, { token: admin, method: 'PUT', body: { rules: [{ field: 'mobile', visibility: 'masked' }, { field: 'email', visibility: 'hidden' }, { field: 'cf:property_type', visibility: 'read' }] } });
const rmList = (await call('/api/v1/leads', { token: rm, workspace: VASTU })).body;
const rmDetail = (await call(`/api/v1/leads/${arjunLead.id}`, { token: rm, workspace: VASTU })).body;
check('RM sees masked mobiles and no emails', rmList.every((l) => !l.mobile || l.mobile.includes('•')) && rmList.every((l) => l.email === null) && rmDetail.mobile.includes('•') && rmDetail.email === null, [rmList[0].mobile, rmDetail.mobile]);
check('lead detail tells the screen which fields are locked', rmDetail.fieldAccess['cf:property_type'] === 'read' && rmDetail.fieldAccess.mobile === 'masked', rmDetail.fieldAccess);
const lockedEdit = await call(`/api/v1/leads/${arjunLead.id}/fields`, { token: rm, workspace: VASTU, method: 'PATCH', body: { customFields: { property_type: 'Shop' } } });
const freeEdit = await call(`/api/v1/leads/${arjunLead.id}/fields`, { token: rm, workspace: VASTU, method: 'PATCH', body: { customFields: { city: 'Pune' } } });
check('read-only fields cannot be changed; others still can', lockedEdit.status === 403 && lockedEdit.body.code === 'FIELD_LOCKED' && freeEdit.status === 200, [lockedEdit.body, freeEdit.status]);
const mgrDetail = (await call(`/api/v1/leads/${arjunLead.id}`, { token: manager, workspace: VASTU })).body;
check('roles without rules (manager) still see everything', !mgrDetail.mobile.includes('•'), mgrDetail.mobile);
const rmCustomer = (await call(`/api/v1/customers/${rmDetail.customerId}`, { token: rm, workspace: VASTU })).body;
check('the same rules apply on the customer page', !rmCustomer.mobile || rmCustomer.mobile.includes('•'), rmCustomer.mobile);

// ── Smart views ──
const rmView = await call('/api/v1/views', { token: rm, workspace: VASTU, method: 'POST', body: { name: 'My hot leads', workspaceId: VASTU, query: { statuses: ['hot'], sort: 'score_desc' }, columns: ['status', 'stage', 'owner'], layout: 'board' } });
check('a person saves a smart view (filters, columns, board layout)', rmView.status === 201 && rmView.body.layout === 'board', rmView.body);
const mgrSees = (await call('/api/v1/views', { token: manager, workspace: VASTU })).body;
check('views are private until shared', !mgrSees.some((v) => v.id === rmView.body.id), mgrSees.map((v) => v.name));
const rmShare = await call(`/api/v1/views/${rmView.body.id}/sharing`, { token: rm, workspace: VASTU, method: 'PATCH', body: { sharedRoleIds: [RM_ROLE] } });
check('sharing views needs the share permission', rmShare.status === 403, rmShare.status);
const mgrView = await call('/api/v1/views', { token: manager, workspace: VASTU, method: 'POST', body: { name: 'Stuck in Vastu', workspaceId: VASTU, query: { stuck: 'yes' } } });
await call(`/api/v1/views/${mgrView.body.id}/sharing`, { token: manager, workspace: VASTU, method: 'PATCH', body: { sharedRoleIds: [RM_ROLE] } });
const rmViews = (await call('/api/v1/views', { token: rm, workspace: VASTU })).body;
check('a manager shares a view with the RM role', rmViews.some((v) => v.id === mgrView.body.id && !v.isMine && v.owner === 'Neha (Manager)'), rmViews.map((v) => [v.name, v.isMine]));
const rmEditsShared = await call(`/api/v1/views/${mgrView.body.id}`, { token: rm, workspace: VASTU, method: 'PATCH', body: { name: 'Hacked' } });
check('only the owner changes a view', rmEditsShared.status === 403, rmEditsShared.status);
const delView = await call(`/api/v1/views/${rmView.body.id}`, { token: rm, workspace: VASTU, method: 'DELETE' });
check('the owner removes their view', delView.status === 200 && !(await call('/api/v1/views', { token: rm, workspace: VASTU })).body.some((v) => v.id === rmView.body.id), delView.status);

// ── Tasks, meetings, calendar, mentions ──
const soon = new Date(Date.now() + 5 * 60_000).toISOString();
const task = await call('/api/v1/tasks', { token: rm, workspace: VASTU, method: 'POST', body: { type: 'meeting', title: 'Site visit with family', dueAt: soon, durationMin: 60, location: 'Sector 21, Noida', leadId: arjunLead.id } });
check('an RM plans a meeting on their lead (assigned to them)', task.status === 201 && task.body.assigneeId === ARJUN && task.body.leadId === arjunLead.id, task.body);
const onLead = (await call(`/api/v1/leads/${arjunLead.id}`, { token: rm, workspace: VASTU })).body;
check('the meeting appears on the lead journey', onLead.activities.some((a) => a.type === 'task' && a.data.title === 'Site visit with family'), onLead.activities.map((a) => a.type));
const rmForOther = await call('/api/v1/tasks', { token: rm, workspace: VASTU, method: 'POST', body: { title: 'Call back', dueAt: soon, assigneeId: NEHA } });
check('RMs cannot give tasks to others', rmForOther.status === 403, rmForOther.status);
const mgrTask = await call('/api/v1/tasks', { token: manager, workspace: VASTU, method: 'POST', body: { title: 'Send audit report', dueAt: new Date(Date.now() + 86_400_000).toISOString(), assigneeId: ARJUN, notes: 'Use the new format', mentionIds: [SIMRAN] } });
const mgrToCourse = await call('/api/v1/tasks', { token: manager, workspace: VASTU, method: 'POST', body: { title: 'Out of reach', dueAt: soon, assigneeId: SIMRAN } });
check('a manager assigns tasks within their business line only', mgrTask.status === 201 && mgrToCourse.status === 400, [mgrTask.status, mgrToCourse.body]);
const rmTasks = (await call('/api/v1/tasks', { token: rm, workspace: VASTU })).body;
const simranTasks = (await call('/api/v1/tasks', { token: rm2, workspace: COURSE })).body;
check('people see their own tasks; others’ tasks stay private unless mentioned', rmTasks.some((t) => t.id === mgrTask.body.id) && rmTasks.some((t) => t.id === task.body.id) && simranTasks.every((t) => t.id === mgrTask.body.id), [rmTasks.length, simranTasks.map((t) => t.title)]);
const done = await call(`/api/v1/tasks/${mgrTask.body.id}`, { token: rm, workspace: VASTU, method: 'PATCH', body: { done: true } });
const outsiderEdit = await call(`/api/v1/tasks/${task.body.id}`, { token: rm2, workspace: COURSE, method: 'PATCH', body: { title: 'Taken over' } });
check('the assignee completes a task; outsiders cannot touch it', done.status === 200 && !!done.body.doneAt && outsiderEdit.status === 404, [done.status, outsiderEdit.status]);
const from = new Date(Date.now() - 3 * 86_400_000).toISOString();
const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
const cal = (await call(`/api/v1/calendar?from=${from}&to=${to}`, { token: rm, workspace: VASTU })).body;
check('calendar combines meetings, tasks and lead follow-ups', cal.some((e) => e.kind === 'meeting') && cal.some((e) => e.kind === 'follow_up') && cal.every((e, i) => i === 0 || new Date(e.at) >= new Date(cal[i - 1].at)), cal.map((e) => e.kind));
const longCal = await call(`/api/v1/calendar?from=${from}&to=${new Date(Date.now() + 90 * 86_400_000).toISOString()}`, { token: rm, workspace: VASTU });
check('calendar ranges are limited', longCal.status === 400, longCal.status);
await call(`/api/v1/leads/${arjunLead.id}/activities`, { token: rm, workspace: VASTU, method: 'POST', body: { type: 'remark', remark: '@Neha please join the visit', mentionIds: [NEHA, '00000000-0000-4000-8000-000000000000'] } });
const nehaN = (await call('/api/v1/notifications', { token: manager, workspace: VASTU })).body;
const arjunN = (await call('/api/v1/notifications', { token: rm, workspace: VASTU })).body;
check('mentions notify the person with a link to the lead', nehaN.items.some((n) => n.type === 'mention' && n.link === `/app/leads/${arjunLead.id}`) && nehaN.unread >= 1, nehaN.items.map((n) => n.title));
check('being given a task notifies the assignee', arjunN.items.some((n) => n.type === 'assignment' && /Send audit report/.test(n.title)), arjunN.items.map((n) => n.title));
const remarkMention = (await call(`/api/v1/leads/${arjunLead.id}`, { token: rm, workspace: VASTU })).body.activities.find((a) => a.type === 'remark' && /join the visit/.test(a.remark ?? ''));
check('the remark shows who was mentioned (unknown people are dropped)', remarkMention?.mentions?.length === 1 && /Neha/.test(remarkMention.mentions[0]), remarkMention?.mentions);
await call('/api/v1/notifications/read', { token: manager, workspace: VASTU, method: 'POST', body: { all: true } });
check('notifications can be marked read', (await call('/api/v1/notifications', { token: manager, workspace: VASTU })).body.unread === 0);

// ── Goals ──
const goal = await call('/api/v1/goals', { token: manager, workspace: VASTU, method: 'POST', body: { metric: 'calls', period: 'week', target: 5, userId: ARJUN } });
const rmGoal = await call('/api/v1/goals', { token: rm, workspace: VASTU, method: 'POST', body: { metric: 'calls', target: 5, userId: ARJUN } });
const outGoal = await call('/api/v1/goals', { token: manager, workspace: VASTU, method: 'POST', body: { metric: 'won', target: 3, userId: SIMRAN } });
const badMetric = await call('/api/v1/goals', { token: manager, workspace: VASTU, method: 'POST', body: { metric: 'win_rate', target: 50, userId: ARJUN } });
check('managers set goals for their people; RMs and out-of-reach targets refused', goal.status === 201 && rmGoal.status === 403 && outGoal.status === 403 && badMetric.status === 400, [goal.status, rmGoal.status, outGoal.status, badMetric.status]);
const g1 = (await call('/api/v1/goals', { token: rm, workspace: VASTU })).body.find((g) => g.id === goal.body.id);
await call(`/api/v1/leads/${arjunLead.id}/activities`, { token: rm, workspace: VASTU, method: 'POST', body: { type: 'call', disposition: 'not_answered' } });
const g2 = (await call('/api/v1/goals', { token: rm, workspace: VASTU })).body.find((g) => g.id === goal.body.id);
check('an RM sees their goal and progress moves with work', g1 && g2.value === g1.value + 1 && g2.isMine && g2.periodLabel === 'This week', [g1, g2]);
const goalWidget = (await call('/api/v1/analytics/batch', { token: rm, workspace: VASTU, method: 'POST', body: { widgets: [{ id: 'g', type: 'goals', title: '', w: 12, h: 1 }] } })).body;
check('goals widget on dashboards', goalWidget.g.rows.some((r) => r.id === goal.body.id), goalWidget.g);
const simranGoals = (await call('/api/v1/goals', { token: rm2, workspace: COURSE })).body;
check('other people do not see someone else’s goal', !simranGoals.some((g) => g.id === goal.body.id), simranGoals.length);

// ── Call scripts ──
const interested = consult.stages.find((s) => s.name === 'Interested');
const script = await call('/api/v1/call-scripts', { token: admin, workspace: VASTU, method: 'POST', body: { workspaceId: VASTU, stageId: interested.id, title: 'Book the site visit', body: '1. Confirm the property type\n2. Offer two visit slots\n3. Share the fee' } });
const general = await call('/api/v1/call-scripts', { token: admin, workspace: VASTU, method: 'POST', body: { workspaceId: VASTU, title: 'First call', body: 'Introduce yourself and ask about the property.' } });
const badStage = await call('/api/v1/call-scripts', { token: admin, workspace: VASTU, method: 'POST', body: { workspaceId: VASTU, stageId: (await call(`/api/v1/workspaces/${COURSE}/settings`, { token: admin, workspace: COURSE })).body.pipelines[0].stages[0].id, title: 'Wrong', body: 'x' } });
const rmScript = await call('/api/v1/call-scripts', { token: rm, workspace: VASTU, method: 'POST', body: { workspaceId: VASTU, title: 'Mine', body: 'x' } });
check('call scripts per stage or general; checked and admin-managed', script.status === 201 && general.status === 201 && badStage.status === 400 && rmScript.status === 403, [script.status, general.status, badStage.status, rmScript.status]);
const rmScripts = (await call(`/api/v1/call-scripts?workspaceId=${VASTU}`, { token: rm, workspace: VASTU })).body;
check('RMs read the scripts of their business line', rmScripts.length === 2 && rmScripts.some((s) => s.stageId === interested.id), rmScripts.map((s) => s.title));
const crossScripts = await call(`/api/v1/call-scripts?workspaceId=${COURSE}`, { token: rm, workspace: VASTU });
check('scripts of other business lines stay hidden', crossScripts.status === 403, crossScripts.status);

// ── Reminders, daily summary, dashboard emails ──
const rmNotif = await call('/api/v1/settings/notifications', { token: rm, workspace: VASTU, method: 'PUT', body: { digestHour: 0, reminderMinutes: 30 } });
const orgNotif = await call('/api/v1/settings/notifications', { token: admin, method: 'PUT', body: { digestHour: 0, reminderMinutes: 30 } });
check('only security admins change reminder / summary settings', rmNotif.status === 403 && orgNotif.status === 200, [rmNotif.status, orgNotif.status]);
await call('/api/v1/me/notifications', { token: rm2, workspace: COURSE, method: 'PUT', body: { digestEnabled: false } });
// The API scheduler also runs every minute and may have sent her summary before she switched it off; count only later ones.
const switchedOffAt = Date.now() - 1_000;
const sub = await call('/api/v1/dashboards/tpl:my_day/subscription', { token: rm, workspace: VASTU, method: 'PUT', body: { frequency: 'daily', hour: 0 } });
const privateDash = await call('/api/v1/dashboards', { token: admin, method: 'POST', body: { name: 'Admin only', widgets: [{ id: 'k', type: 'kpi', title: 'Leads', metric: 'leads', groupBy: 'none', w: 3, h: 1 }] } });
const subPrivate = await call(`/api/v1/dashboards/${privateDash.body.id}/subscription`, { token: rm, workspace: VASTU, method: 'PUT', body: { hour: 0 } });
check('people subscribe only to dashboards they can open', sub.status === 200 && subPrivate.status === 400, [sub.status, subPrivate.status]);
const rmRun = await call('/api/v1/automation/run-now', { token: rm, workspace: VASTU, method: 'POST' });
const run1 = await call('/api/v1/automation/run-now', { token: admin, method: 'POST' });
check('admins run reminders & summaries now (RMs cannot)', rmRun.status === 403 && run1.status === 200 && typeof run1.body.digests === 'number', [rmRun.status, run1.body]);
await new Promise((r) => setTimeout(r, 800));
check('reminder email and in-app reminder for the meeting', (await mailTo('rm@mycompany.local', /Reminder — Meeting: Site visit with family/)).length === 1
  && (await call('/api/v1/notifications', { token: rm, workspace: VASTU })).body.items.some((n) => n.type === 'reminder'), (await mails()).map((m) => m.Subject));
check('daily summary email per person', (await mailTo('rm@mycompany.local', /Your day at My Company/)).length === 1 && (await mailTo('manager@mycompany.local', /Your day at My Company/)).length === 1, (await mails()).map((m) => [m.To[0]?.Address, m.Subject]));
check('people who switched the summary off get none', (await mailTo('rm2@mycompany.local', /Your day/)).filter((m) => new Date(m.Created).getTime() >= switchedOffAt).length === 0);
const dashMail = await mailTo('rm@mycompany.local', /^My day — Yesterday/);
check('subscribed dashboard arrives by email', dashMail.length === 1, (await mails()).map((m) => m.Subject));
const run2 = await call('/api/v1/automation/run-now', { token: admin, method: 'POST' });
check('nothing is sent twice', run2.body.reminders === 0 && run2.body.digests === 0 && run2.body.dashboards === 0, run2.body);

// ── Excel bulk update of existing leads ──
const vastuMobiles = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body;
const target = vastuMobiles.find((l) => l.ownerId === ARJUN);
const rows = [
  { key: target.mobile, status: 'Hot', labels: 'VIP', fields: { city: 'Agra' }, remark: 'Updated from sheet', followUp: '25/10/2026' },
  { key: '9999900000', status: 'Hot' },
  { key: target.mobile, status: 'Boiling' },
  { key: target.mobile, owner: 'nobody@example.com' },
  { key: target.mobile, stage: 'Interested' },
];
const rmBulk = await call('/api/v1/leads/bulk-update', { token: rm, workspace: VASTU, method: 'POST', body: { rows } });
check('bulk update from a file needs upload rights', rmBulk.status === 403, rmBulk.status);
const preview = await call('/api/v1/leads/bulk-update', { token: admin, workspace: VASTU, method: 'POST', body: { dryRun: true, rows } });
const r = (n) => preview.body.results.find((x) => x.row === n);
check('preview explains every row', preview.body.ok === 2 && r(2).changes.some((c) => /status → Hot/.test(c)) && /No lead/.test(r(3).message) && /Unknown status/.test(r(4).message) && /not a user/.test(r(5).message), preview.body.results);
const unchanged = (await call(`/api/v1/leads/${target.id}`, { token: admin, workspace: VASTU })).body;
check('a preview changes nothing', unchanged.status !== 'hot' || target.status === 'hot', unchanged.status);
const commit = await call('/api/v1/leads/bulk-update', { token: admin, workspace: VASTU, method: 'POST', body: { dryRun: false, rows } });
const after = (await call(`/api/v1/leads/${target.id}`, { token: admin, workspace: VASTU })).body;
check('commit updates status, labels, fields, stage, remark and follow-up', commit.body.updated === 2 && after.status === 'hot' && after.labelIds.includes(vip.body.id) && after.customFields.city === 'Agra'
  && after.stageId === interested.id && after.activities.some((a) => a.remark === 'Updated from sheet') && after.followUps.some((f) => f.dueAt.startsWith('2026-10-25')), [commit.body.updated, after.status, after.customFields]);

// ── Past calls & remarks from another CRM ──
const actRows = [
  { key: target.mobile, type: 'Call', date: '2026-09-01 11:30', disposition: 'Connected', durationMin: '4', remark: 'Old CRM call', user: 'rm@mycompany.local' },
  { key: target.mobile, type: 'remark', date: '02/09/2026', remark: 'Old CRM note' },
  { key: target.mobile, type: 'email', date: '2026-09-01' },
  { key: target.mobile, type: 'call', date: '2099-01-01', disposition: 'Connected' },
  { key: target.mobile, type: 'call', date: '2026-09-01', disposition: 'Teleported' },
];
const actPreview = await call('/api/v1/leads/activities-import', { token: admin, workspace: VASTU, method: 'POST', body: { dryRun: true, rows: actRows } });
check('past-activity preview checks type, date and call outcome', actPreview.body.ok === 2 && actPreview.body.errors === 3, actPreview.body.results);
await call('/api/v1/leads/activities-import', { token: admin, workspace: VASTU, method: 'POST', body: { dryRun: false, rows: actRows } });
const withHistory = (await call(`/api/v1/leads/${target.id}`, { token: admin, workspace: VASTU })).body;
const imported = withHistory.activities.filter((a) => a.data?.imported);
check('imported calls & remarks keep their original dates and authors', imported.length === 2 && imported.some((a) => a.at.startsWith('2026-09-01') && a.user === 'Arjun (RM)' && a.durationSec === 240), imported);

// ── Activity export ──
const today = new Date().toISOString().slice(0, 10);
const exp = await call(`/api/v1/activities/export?from=2026-09-01&to=${today}&types=call,remark`, { token: admin });
check('calls & remarks export as CSV', exp.status === 200 && /Old CRM call/.test(exp.body) && !/,stage,/.test(exp.body), String(exp.body).slice(0, 200));
const rmExp = await call(`/api/v1/activities/export?from=2026-09-01&to=${today}`, { token: rm, workspace: VASTU });
check('people without export rights cannot export activities', rmExp.status === 403, rmExp.status);

// ── Integration setup ──
const rz = (await call('/api/v1/integrations/razorpay/setup', { token: admin })).body;
check('setup panel lists steps, fields and the webhook need', rz.steps.length >= 2 && rz.fields.some((f) => f.key === 'apiSecret' && f.type === 'secret') && rz.needsWebhook && rz.webhookUrl === null, rz);
const missing = await call('/api/v1/integrations/razorpay/setup', { token: admin, method: 'PUT', body: { values: { keyId: 'rzp_test_abc' } } });
check('required settings are enforced', missing.status === 400 && missing.body.code === 'FIELD_REQUIRED', missing.body);
const saved = await call('/api/v1/integrations/razorpay/setup', { token: admin, method: 'PUT', body: { values: { keyId: 'rzp_test_abc', apiSecret: 'supersecretvalue1234', webhookSecret: 'whsec-for-tests', mode: 'test' }, activate: true } });
const rz2 = (await call('/api/v1/integrations/razorpay/setup', { token: admin })).body;
check('saving activates it; secrets come back masked; a private webhook URL is issued', saved.body.status === 'active' && rz2.values.apiSecret === '••••1234' && rz2.values.keyId === 'rzp_test_abc' && /\/hooks\/mycompany\/razorpay\/[A-Za-z0-9]{12,}/.test(rz2.webhookUrl ?? ''), rz2);
await call('/api/v1/integrations/razorpay/setup', { token: admin, method: 'PUT', body: { values: { keyId: 'rzp_test_xyz', apiSecret: '••••1234', mode: 'test' } } });
const rz3 = (await call('/api/v1/integrations/razorpay/setup', { token: admin })).body;
check('saving again without retyping the secret keeps it (and the same webhook URL)', rz3.values.apiSecret === '••••1234' && rz3.values.keyId === 'rzp_test_xyz' && rz3.webhookUrl === rz2.webhookUrl, rz3.values);
const intAudit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body.filter((a) => a.action === 'integration.configured'));
check('secrets never reach the audit log', intAudit.length > 2 && !intAudit.includes('supersecretvalue1234'), intAudit.slice(0, 200));
const rmSetup = await call('/api/v1/integrations/razorpay/setup', { token: rm, workspace: VASTU, method: 'PUT', body: { values: {} } });
const badUrl = await call('/api/v1/integrations/google_sheets/setup', { token: admin, method: 'PUT', body: { values: { sheetUrl: 'not a url' } } });
check('only admins configure; values are validated', rmSetup.status === 403 && badUrl.status === 400, [rmSetup.status, badUrl.body]);
const abcRz = (await call('/api/v1/integrations/razorpay/setup', { token: abc, tenant: 'abc' })).body;
check('settings belong to one organization only', abcRz.configured === false && abcRz.values.apiSecret === '', abcRz.values);

// ── Field mapping (step 2) ──
const im0 = (await call('/api/v1/integrations/indiamart/setup', { token: admin })).body;
check('lead sources get a mapping step with the service’s own field names and a first guess', im0.mapping && im0.mapping.sourceFields.includes('SENDER_MOBILE') && im0.mapping.map.SENDER_MOBILE === 'mobile' && im0.mapping.map.SENDER_NAME === 'name' && !im0.mapping.businessLineSet, im0.mapping);
const noLine = await call('/api/v1/integrations/indiamart/mapping', { token: admin, method: 'PUT', body: { sourceFields: ['SENDER_NAME'], map: { SENDER_NAME: 'name' }, duplicateMode: 'add_remark' } });
check('mapping needs the business line from step 1', noLine.status === 400 && noLine.body.code === 'BUSINESS_LINE_REQUIRED', noLine.body);
await call('/api/v1/integrations/indiamart/setup', { token: admin, method: 'PUT', body: { values: { apiKey: 'im-key-123456', businessLine: VASTU } } });
const im1 = (await call('/api/v1/integrations/indiamart/setup', { token: admin })).body;
check('after choosing the business line its custom fields become targets', im1.mapping.businessLineSet && im1.mapping.targets.some((t) => t.value === 'cf:property_type' && t.required), im1.mapping.targets.map((t) => t.value));
const srcs = ['SENDER_NAME', 'SENDER_MOBILE', 'SENDER_EMAIL', 'SENDER_CITY', 'QUERY_PRODUCT_NAME', 'QUERY_MESSAGE'];
const base = { SENDER_NAME: 'name', SENDER_MOBILE: 'mobile', SENDER_EMAIL: 'email', SENDER_CITY: 'cf:city', QUERY_PRODUCT_NAME: 'cf:property_type', QUERY_MESSAGE: 'remark' };
const noName = await call('/api/v1/integrations/indiamart/mapping', { token: admin, method: 'PUT', body: { sourceFields: srcs, map: { ...base, SENDER_NAME: 'ignore' }, duplicateMode: 'add_remark' } });
const twice = await call('/api/v1/integrations/indiamart/mapping', { token: admin, method: 'PUT', body: { sourceFields: srcs, map: { ...base, SENDER_EMAIL: 'mobile' }, duplicateMode: 'add_remark' } });
const unknownT = await call('/api/v1/integrations/indiamart/mapping', { token: admin, method: 'PUT', body: { sourceFields: srcs, map: { ...base, SENDER_CITY: 'cf:nope' }, duplicateMode: 'add_remark' } });
check('mapping rules: name and Lead ID required, one source per field, real fields only', noName.body.code === 'NAME_REQUIRED' && twice.body.code === 'DUPLICATE_TARGET' && unknownT.body.code === 'UNKNOWN_TARGET', [noName.body.code, twice.body.code, unknownT.body.code]);
const rmMap = await call('/api/v1/integrations/indiamart/mapping', { token: rm, workspace: VASTU, method: 'PUT', body: { sourceFields: srcs, map: base, duplicateMode: 'add_remark' } });
const okMap = await call('/api/v1/integrations/indiamart/mapping', { token: admin, method: 'PUT', body: { sourceFields: srcs, map: base, duplicateMode: 'add_remark', defaultSource: 'indiamart' } });
check('admins save the mapping (RMs cannot)', rmMap.status === 403 && okMap.status === 200, [rmMap.status, okMap.body]);
const keysKept = (await call('/api/v1/integrations/indiamart/setup', { token: admin })).body;
// (IndiaMART now pushes to the webhook URL, so its only setting is the business line.)
check('saving the mapping keeps the settings and vice versa', keysKept.values.businessLine === VASTU && keysKept.mapping.saved && !!keysKept.webhookUrl, keysKept.values);
const pNew = (await call('/api/v1/integrations/indiamart/mapping/preview', { token: admin, method: 'POST', body: { sample: { SENDER_NAME: 'Kunal Shah', SENDER_MOBILE: '9811122233', SENDER_CITY: 'Surat', QUERY_PRODUCT_NAME: 'Office', QUERY_MESSAGE: 'Need vastu for new office' } } })).body;
check('preview: a new person becomes a new customer and lead with mapped fields', pNew.outcome === 'new_lead_new_customer' && pNew.lead.mobile === '+919811122233' && pNew.lead.customFields.property_type === 'Office' && pNew.lead.remark === 'Need vastu for new office' && pNew.lead.source === 'indiamart', pNew);
const pDup = (await call('/api/v1/integrations/indiamart/mapping/preview', { token: admin, method: 'POST', body: { sample: { SENDER_NAME: 'Meera J', SENDER_MOBILE: '9876500020', QUERY_PRODUCT_NAME: 'Home' } } })).body;
check('preview: a returning person with an open lead follows the duplicate rule', pDup.outcome === 'add_remark' && pDup.existing?.openLeadId, pDup);
const pBad = (await call('/api/v1/integrations/indiamart/mapping/preview', { token: admin, method: 'POST', body: { sample: { SENDER_NAME: 'No Phone', QUERY_PRODUCT_NAME: 'Castle' } } })).body;
check('preview: problems are listed and the record would be rejected', pBad.outcome === 'rejected' && pBad.errors.length >= 2, pBad.errors);
const noMapAi = await call('/api/v1/integrations/openai/mapping', { token: admin, method: 'PUT', body: { sourceFields: ['x'], map: { x: 'name' }, duplicateMode: 'skip' } });
check('services that do not bring leads have no mapping', noMapAi.status === 400 && noMapAi.body.code === 'NO_MAPPING' && (await call('/api/v1/integrations/openai/setup', { token: admin })).body.mapping === null, noMapAi.body);
const hubspot = (await call('/api/v1/integrations/hubspot/setup', { token: admin })).body;
check('specific setups with field help (e.g. HubSpot private app token)', hubspot.fields.some((f) => f.key === 'apiKey' && /Private apps/.test(f.help ?? '')) && hubspot.steps.length >= 3, hubspot.fields);

// ── Isolation ──
const abcLabels = (await call('/api/v1/labels', { token: abc, tenant: 'abc' })).body;
const abcTasks = (await call('/api/v1/tasks?status=all', { token: abc, tenant: 'abc' })).body;
const abcLead = (await call('/api/v1/leads', { token: abc, tenant: 'abc' })).body[0];
const abcWs = (await call('/api/v1/auth/me', { token: abc, tenant: 'abc' })).body.workspaces[0].id;
const crossLabel = await call(`/api/v1/leads/${abcLead.id}/labels`, { token: abc, tenant: 'abc', workspace: abcLead.workspaceId ?? abcWs, method: 'PUT', body: { labelIds: [vip.body.id] } });
const abcGoals = (await call('/api/v1/goals', { token: abc, tenant: 'abc' })).body;
check('labels, tasks, goals and scripts never cross organizations', abcLabels.length === 0 && abcTasks.length === 0 && crossLabel.status === 400 && abcGoals.length === 0, [abcLabels.length, abcTasks.length, crossLabel.status, abcGoals.length]);

// reset the settings this suite changed
await call(`/api/v1/roles/${RM_ROLE}/field-rules`, { token: admin, method: 'PUT', body: { rules: [] } });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll productivity checks passed.');
process.exit(failures ? 1 : 0);
