// End-to-end checks for Phase 1.6: analytics engine (KPIs, groupings, trends, funnel, leaderboard, forecast),
// data scope per role, saved & shared dashboards, deal value field and isolation.
// Usage: npm run verify:dashboards   (API running, freshly seeded; run `npm run db:seed` afterwards to reset)

const API = process.env.API_URL ?? 'http://localhost:4000';
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
  return { status: res.status, body: json, total: Number(res.headers.get('x-total-count') ?? NaN) };
}
const login = async (identifier, tenant = 'mycompany') =>
  (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const LOGO = ws['Logo Designing'];
const users = (await call('/api/v1/users', { token: admin })).body;
const ARJUN = users.find((u) => u.email === 'rm@mycompany.local').id;

const batch = (token, widgets, extra = {}, opts = {}) => call('/api/v1/analytics/batch', { token, method: 'POST', body: { range: 'this_month', widgets, ...extra }, ...opts });
const kpi = (id, metric, more = {}) => ({ id, type: 'kpi', title: id, metric, groupBy: 'none', w: 3, h: 1, ...more });
const localDay = (iso, back = 0) => new Date(new Date(iso).getTime() - back).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// ── Catalogue & validation ──
const cat = await call('/api/v1/analytics/catalog', { token: admin });
check('catalogue lists 35+ metrics in categories, groupings, ranges, widgets and 7 templates', cat.status === 200 && Object.keys(cat.body.metrics).length >= 35 && Object.values(cat.body.metrics).every((m) => m.category) && cat.body.templates.length === 7, Object.keys(cat.body.metrics).length);
const badMetric = await batch(admin, [kpi('x', 'happiness')]);
check('unknown metrics are refused', badMetric.status === 400, badMetric.status);
const tooMany = await batch(admin, Array.from({ length: 31 }, (_, i) => kpi(`k${i}`, 'leads')));
check('at most 30 widgets per dashboard', tooMany.status === 400, tooMany.status);
const badSize = await batch(admin, [{ ...kpi('k', 'leads'), w: 5 }]);
check('widget sizes are limited to the grid', badSize.status === 400, badSize.status);
const noMetric = await batch(admin, [{ id: 'b', type: 'bar', title: 'Bars', groupBy: 'stage', w: 6, h: 2 }]);
check('chart widgets need a metric', noMetric.status === 400 && noMetric.body.code === 'METRIC_REQUIRED', noMetric.body);

// ── Numbers match the lead list ──
const month = (await batch(admin, [kpi('leads', 'leads'), { id: 'byOwner', type: 'bar', title: '', metric: 'leads', groupBy: 'owner', w: 6, h: 2 }, { id: 'byDay', type: 'line', title: '', metric: 'leads', groupBy: 'day', w: 6, h: 2 }], { range: 'last_30_days' })).body;
const from = localDay(month.leads.from);
const to = localDay(month.leads.to, 1);
const listed = await call(`/api/v1/leads?createdFrom=${from}&createdTo=${to}`, { token: admin });
check('“New leads” equals the leads list for the same dates', month.leads.value === listed.total && month.leads.value > 0, [month.leads.value, listed.total]);
check('split by person adds up to the total', month.byOwner.series.reduce((n, p) => n + p.value, 0) === month.leads.value, month.byOwner.series);
check('daily trend covers every day of the range, including empty days', month.byDay.series.length === 30 && month.byDay.series.reduce((n, p) => n + p.value, 0) === month.leads.value, month.byDay.series.length);
check('KPI compares with the previous period', typeof month.leads.previous === 'number', month.leads);

const snap = (await batch(admin, [kpi('open', 'open_leads'), { id: 'openStage', type: 'bar', title: '', metric: 'open_leads', groupBy: 'stage', w: 6, h: 2 }, kpi('stuck', 'stuck_leads'), kpi('wr', 'win_rate'), kpi('cr', 'contact_rate'), kpi('fr', 'first_response')])).body;
check('open leads by stage add up and come in pipeline order with colours', snap.openStage.series.reduce((n, p) => n + p.value, 0) === snap.open.value && snap.openStage.series.every((p) => 'color' in p), snap.openStage.series.map((p) => p.label));
check('snapshot metrics ignore the period and have no comparison', snap.open.previous === null && snap.stuck.previous === null, [snap.open, snap.stuck]);
check('percent metrics stay between 0 and 100', [snap.wr.value, snap.cr.value].every((v) => v === null || (v >= 0 && v <= 100)), [snap.wr.value, snap.cr.value]);

// ── Data scope per role ──
const rmView = (await batch(rm, [kpi('open', 'open_leads'), { id: 'lb', type: 'leaderboard', title: '', w: 12, h: 2 }], {}, { workspace: VASTU })).body;
const rmList = await call('/api/v1/leads?stageIds=' + (await call(`/api/v1/workspaces/${VASTU}/settings`, { token: admin, workspace: VASTU })).body.pipelines.flatMap((p) => p.stages.filter((s) => !s.isWon && !s.isLost).map((s) => s.id)).join(','), { token: rm, workspace: VASTU });
check('an RM only sees their own numbers', rmView.open.value === rmList.total && rmList.body.every((l) => l.ownerId === ARJUN), [rmView.open.value, rmList.total]);
check('an RM’s leaderboard has only themselves', rmView.lb.rows.every((r) => r.userId === ARJUN), rmView.lb.rows.map((r) => r.name));
const mgrView = (await batch(manager, [kpi('open', 'open_leads')], {}, { workspace: VASTU })).body;
const adminVastu = (await batch(admin, [kpi('open', 'open_leads')], {}, { workspace: VASTU })).body;
const adminAll = (await batch(admin, [kpi('open', 'open_leads')])).body;
check('a manager sees the whole business line; the organization view adds every line', mgrView.open.value === adminVastu.open.value && adminAll.open.value > adminVastu.open.value && mgrView.open.value >= rmView.open.value, [mgrView.open.value, adminVastu.open.value, adminAll.open.value]);
const personFilter = (await batch(admin, [kpi('open', 'open_leads')], { filters: { ownerIds: [ARJUN] } }, { workspace: VASTU })).body;
check('the person filter narrows the numbers', personFilter.open.value === rmView.open.value, [personFilter.open.value, rmView.open.value]);
const auditor = await login('auditor@mycompany.local');
const audView = await batch(auditor, [kpi('open', 'open_leads')]);
check('read-only roles with dashboard access see organization numbers', audView.status === 200 && audView.body.open.value === adminAll.open.value, audView.body);

// ── Calls & follow-ups react to work ──
const fuList = (await batch(admin, [{ id: 'fu', type: 'followups', title: '', w: 6, h: 2 }, kpi('over', 'overdue_followups')])).body;
check('follow-up list shows overdue first and matches the overdue count', fuList.fu.rows.length >= 1 && fuList.fu.rows.filter((r) => r.overdue).length === Math.min(fuList.over.value, fuList.fu.rows.length) && fuList.fu.rows[0].overdue, fuList.fu.rows.map((r) => r.overdue));
const comp1 = (await batch(admin, [kpi('c', 'followup_compliance', { range: 'last_7_days' })])).body.c.value;
const overdueRow = fuList.fu.rows.find((r) => r.overdue);
await call(`/api/v1/follow-ups/${overdueRow.id}`, { token: admin, method: 'PATCH', body: { done: true } });
const comp2 = (await batch(admin, [kpi('c', 'followup_compliance', { range: 'last_7_days' })])).body.c.value;
check('follow-ups done late do not count as on time', comp2 === comp1, [comp1, comp2]);

const before = (await batch(rm, [kpi('calls', 'calls', { range: 'today' }), kpi('conn', 'connected_calls', { range: 'today' }), { id: 'heat', type: 'heatmap', title: '', metric: 'calls', groupBy: 'heatmap', w: 6, h: 2 }], {}, { workspace: VASTU })).body;
const myLead = rmList.body[0];
await call(`/api/v1/leads/${myLead.id}/activities`, { token: rm, workspace: VASTU, method: 'POST', body: { type: 'call', disposition: 'connected', durationSec: 300 } });
await call(`/api/v1/leads/${myLead.id}/activities`, { token: rm, workspace: VASTU, method: 'POST', body: { type: 'call', disposition: 'not_answered' } });
const after = (await batch(rm, [kpi('calls', 'calls', { range: 'today' }), kpi('conn', 'connected_calls', { range: 'today' }), kpi('rate', 'connect_rate', { range: 'today' }), kpi('talk', 'talk_time', { range: 'today' }), { id: 'heat', type: 'heatmap', title: '', metric: 'calls', groupBy: 'heatmap', w: 6, h: 2 }], {}, { workspace: VASTU })).body;
check('logged calls show up at once (calls, connected, talk time)', after.calls.value === before.calls.value + 2 && after.conn.value === before.conn.value + 1 && after.talk.value >= 5, [before.calls.value, after.calls.value, after.conn.value, after.talk.value]);
check('heatmap places calls on weekday × hour', after.heat.series.reduce((n, p) => n + p.value, 0) >= 2 && after.heat.series.every((p) => p.x >= 0 && p.x <= 6 && p.y >= 0 && p.y <= 23), after.heat.series);
// ── Revenue, SLA, productivity and audit KPIs ──
const nonAudit = Object.entries(cat.body.metrics).filter(([, m]) => !m.audit).map(([k]) => k);
const auditKeys = Object.entries(cat.body.metrics).filter(([, m]) => m.audit).map(([k]) => k);
const allKpis = { ...(await batch(admin, nonAudit.slice(0, 20).map((k) => kpi(k, k)), { range: 'last_30_days' })).body, ...(await batch(admin, nonAudit.slice(20).map((k) => kpi(k, k)), { range: 'last_30_days' })).body };
check('every KPI computes for management', nonAudit.every((k) => allKpis[k] && !allKpis[k].error && (allKpis[k].value === null || typeof allKpis[k].value === 'number')), nonAudit.filter((k) => !allKpis[k] || allKpis[k].error));
check('percent KPIs stay between 0 and 100', ['conversion_rate', 'response_1h', 'sla_breach_rate'].every((k) => allKpis[k].value === null || (allKpis[k].value >= 0 && allKpis[k].value <= 100)), ['conversion_rate', 'response_1h', 'sla_breach_rate'].map((k) => allKpis[k].value));
check('activities include the calls; leads worked never exceed activities', allKpis.activities.value >= allKpis.calls.value && allKpis.leads_worked.value <= allKpis.activities.value, [allKpis.activities.value, allKpis.calls.value, allKpis.leads_worked.value]);
const openStageIds = (await Promise.all(Object.values(ws).map((id) => call(`/api/v1/workspaces/${id}/settings`, { token: admin, workspace: id })))).flatMap((r) => r.body.pipelines.flatMap((p) => p.stages.filter((x) => !x.isWon && !x.isLost).map((x) => x.id)));
const unassignedList = await call(`/api/v1/leads?owners=unassigned&stageIds=${openStageIds.join(',')}`, { token: admin });
check('unassigned leads match the lead list', allKpis.unassigned_leads.value === unassignedList.total, [allKpis.unassigned_leads.value, unassignedList.total]);
const byType = (await batch(admin, [{ id: 't', type: 'pie', title: '', metric: 'activities', groupBy: 'activity_type', w: 6, h: 2 }], { range: 'last_30_days' })).body.t;
check('activities split by type (calls, remarks, stage moves…)', byType.series.some((p) => p.key === 'call') && byType.series.reduce((n, p) => n + p.value, 0) === byType.value, byType.series.map((p) => p.key));
const adminAudit = (await batch(admin, auditKeys.map((k) => kpi(k, k)), { range: 'today' })).body;
check('management sees the audit KPIs (sign-ins, exports, data changes)', auditKeys.every((k) => typeof adminAudit[k].value === 'number') && adminAudit.logins.value >= 1, auditKeys.map((k) => [k, adminAudit[k].value]));
await call('/api/v1/leads/export', { token: admin });
const afterExport = (await batch(admin, [kpi('exports', 'exports', { range: 'today' })])).body;
check('an export shows up in the audit KPIs at once', afterExport.exports.value === adminAudit.exports.value + 1, [adminAudit.exports.value, afterExport.exports.value]);
const rmAudit = (await batch(rm, [kpi('logins', 'logins')], {}, { workspace: VASTU })).body;
const mgrAudit = (await batch(manager, [kpi('exports', 'exports')], {}, { workspace: VASTU })).body;
check('RMs and managers cannot see audit KPIs', /audit access/.test(rmAudit.logins.error ?? '') && /audit access/.test(mgrAudit.exports.error ?? ''), [rmAudit.logins, mgrAudit.exports]);
const teams = (await call('/api/v1/org/structure', { token: admin })).body.branches.flatMap((b) => b.departments.flatMap((d) => d.teams));
const vastuTeam = teams.find((t) => t.name === 'Vastu Team');
const teamMembers = users.filter((u) => u.team?.id === vastuTeam.id).map((u) => u.id);
const byTeam = (await batch(admin, [kpi('open', 'open_leads')], { filters: { teamIds: [vastuTeam.id] } })).body;
const byPeople = (await batch(admin, [kpi('open', 'open_leads')], { filters: { ownerIds: teamMembers } })).body;
check('team filter = the people in that team', teamMembers.length >= 2 && byTeam.open.value === byPeople.open.value, [byTeam.open.value, byPeople.open.value]);
const byLine = (await batch(admin, [kpi('open', 'open_leads')], { filters: { workspaceIds: [VASTU] } })).body;
const hotOpen = (await batch(admin, [kpi('open', 'open_leads')], { filters: { statuses: ['hot'] } })).body;
const hotList = await call(`/api/v1/leads?statuses=hot&stageIds=${openStageIds.join(',')}`, { token: admin });
check('status filter matches the lead list', hotOpen.open.value === hotList.total, [hotOpen.open.value, hotList.total]);
const tplRm = (await call('/api/v1/dashboards', { token: rm, workspace: VASTU })).body.templates.map((t) => t.key);
const tplMgr = (await call('/api/v1/dashboards', { token: manager, workspace: VASTU })).body.templates.map((t) => t.key);
const tplAdmin = (await call('/api/v1/dashboards', { token: admin })).body.templates.map((t) => t.key);
check('each person gets the dashboard tabs that fit their level', tplRm.join() === 'my_day' && tplMgr.includes('team_audit') && !tplMgr.includes('management') && tplAdmin.includes('management') && tplAdmin.length === 7, [tplRm, tplMgr, tplAdmin]);
check('business line filter from the organization view', byLine.open.value === adminVastu.open.value, [byLine.open.value, adminVastu.open.value]);

// ── Funnel, leaderboard, forecast ──
const special = (await batch(admin, [{ id: 'f', type: 'funnel', title: '', w: 6, h: 2 }, { id: 'lb', type: 'leaderboard', title: '', w: 12, h: 2 }, { id: 'fc', type: 'forecast', title: '', w: 4, h: 2 }], {}, { workspace: VASTU })).body;
const steps = special.f.steps.map((s) => s.value);
check('funnel starts with all new leads and never grows', steps.length >= 3 && steps[0] === special.f.total && steps.slice(0, -1).every((v, i) => i === 0 || v <= steps[i - 1]), [special.f.total, steps]);
check('per-person audit table: results, activity, speed & SLA, pipeline hygiene', special.lb.rows.length >= 2 && special.lb.rows.every((r) => ['calls', 'activities', 'wonValue', 'staleLeads', 'stuckLeads', 'overdueFollowups', 'openLeads', 'leadsWorked', 'followupsDone'].every((k) => typeof r[k] === 'number') && 'answered1h' in r && 'followupOnTime' in r), special.lb.rows[0]);
check('forecast gives wins so far, run-rate and pipeline projection', ['wonSoFar', 'runRateWins', 'pipelineWins', 'openLeads', 'daysLeft'].every((k) => typeof special.fc[k] === 'number') && special.fc.pipelineWins >= special.fc.wonSoFar, special.fc);

// ── Deal value & win probability ──
const logoSettings = (await call(`/api/v1/workspaces/${LOGO}/settings`, { token: admin, workspace: LOGO })).body;
const textField = logoSettings.fields.find((f) => f.type === 'text');
const badValue = await call(`/api/v1/workspaces/${LOGO}/value-field`, { token: admin, workspace: LOGO, method: 'PUT', body: { key: textField.key } });
check('only amount or number fields can be the deal value', badValue.status === 400 && badValue.body.code === 'INVALID_VALUE_FIELD', badValue.body);
const rmValue = await call(`/api/v1/workspaces/${LOGO}/value-field`, { token: rm, workspace: LOGO, method: 'PUT', body: { key: 'budget' } });
check('RM cannot set the deal value field', rmValue.status === 403, rmValue.status);
await call(`/api/v1/workspaces/${LOGO}/value-field`, { token: admin, workspace: LOGO, method: 'PUT', body: { key: 'budget' } });
const logoLeads = (await call('/api/v1/leads', { token: admin, workspace: LOGO })).body;
for (const [i, l] of logoLeads.entries()) await call(`/api/v1/leads/${l.id}/fields`, { token: admin, workspace: LOGO, method: 'PATCH', body: { customFields: { ...l.customFields, budget: 10000 * (i + 1) } } });
const pipe = logoSettings.pipelines[0];
await call(`/api/v1/pipelines/${pipe.id}/stages`, { token: admin, workspace: LOGO, method: 'PUT', body: { stages: pipe.stages.map((s) => ({ id: s.id, name: s.name, isWon: s.isWon, isLost: s.isLost, color: s.color, slaDays: s.slaDays, requiredFieldKeys: s.requiredFieldKeys, setStatus: s.setStatus, followUpDays: s.followUpDays, winProbability: s.isWon || s.isLost ? null : 50 })) } });
const logoAfter = (await call(`/api/v1/workspaces/${LOGO}/settings`, { token: admin, workspace: LOGO })).body;
check('stage win probability is saved', logoAfter.valueFieldKey === 'budget' && logoAfter.pipelines[0].stages.filter((s) => !s.isWon && !s.isLost).every((s) => s.winProbability === 50), logoAfter.pipelines[0].stages);
const val = (await batch(admin, [kpi('pv', 'pipeline_value'), kpi('wp', 'weighted_pipeline')], {}, { workspace: LOGO })).body;
const openLogo = logoLeads.filter((l) => !['Won', 'Lost'].includes(l.stage));
const expected = logoLeads.reduce((n, l, i) => n + (openLogo.includes(l) ? 10000 * (i + 1) * 100 : 0), 0);
check('pipeline value sums open deals; weighted pipeline applies the stage probability', val.pv.value === expected && val.wp.value === Math.round(expected / 2), [val.pv.value, expected, val.wp.value]);

// ── Saved & shared dashboards ──
const tpl = await call('/api/v1/dashboards/tpl:company', { token: admin });
const noTpl = await call('/api/v1/dashboards/tpl:nope', { token: admin });
check('ready-made dashboards open by key', tpl.status === 200 && tpl.body.widgets.length >= 8 && tpl.body.isTemplate && noTpl.status === 404, [tpl.status, noTpl.status]);
const lists = { admin: (await call('/api/v1/dashboards', { token: admin })).body, rm: (await call('/api/v1/dashboards', { token: rm, workspace: VASTU })).body, mgr: (await call('/api/v1/dashboards', { token: manager, workspace: VASTU })).body };
check('each person lands on the dashboard for their level', lists.admin.defaultId === 'tpl:management' && lists.rm.defaultId === 'tpl:my_day' && lists.mgr.defaultId === 'tpl:business_line', [lists.admin.defaultId, lists.rm.defaultId, lists.mgr.defaultId]);
const created = await call('/api/v1/dashboards', { token: admin, method: 'POST', body: { name: 'Sales review', range: 'last_30_days', widgets: [kpi('k1', 'leads'), { id: 'b1', type: 'bar', title: 'By stage', metric: 'open_leads', groupBy: 'stage', w: 6, h: 2 }] } });
const dash = created.body;
const rmSees = await call(`/api/v1/dashboards/${dash.id}`, { token: rm, workspace: VASTU });
check('a new dashboard is private to its owner', created.status === 201 && rmSees.status === 404, [created.status, rmSees.status]);
const roles = (await call('/api/v1/roles', { token: admin })).body;
const RM_ROLE = roles.find((r) => r.name === 'RM').id;
const mgrShare = await call(`/api/v1/dashboards/${dash.id}/sharing`, { token: manager, workspace: VASTU, method: 'PUT', body: { sharedRoleIds: [RM_ROLE] } });
check('sharing needs the “share dashboards” permission', mgrShare.status === 403, mgrShare.status);
const shared = await call(`/api/v1/dashboards/${dash.id}/sharing`, { token: admin, method: 'PUT', body: { sharedRoleIds: [RM_ROLE], defaultForRoleIds: [RM_ROLE], isLocked: true } });
const rmList2 = (await call('/api/v1/dashboards', { token: rm, workspace: VASTU })).body;
check('shared with the RM role: RMs see it and land on it', shared.status === 200 && rmList2.shared.some((d) => d.id === dash.id) && rmList2.defaultId === dash.id, rmList2);
const rmEdit = await call(`/api/v1/dashboards/${dash.id}`, { token: rm, workspace: VASTU, method: 'PATCH', body: { name: 'Hacked' } });
const rmDelete = await call(`/api/v1/dashboards/${dash.id}`, { token: rm, workspace: VASTU, method: 'DELETE' });
check('viewers cannot change or delete a shared dashboard', rmEdit.status === 403 && rmDelete.status === 403, [rmEdit.status, rmDelete.status]);
const rmCopy = await call('/api/v1/dashboards', { token: rm, workspace: VASTU, method: 'POST', body: { name: 'My sales review', widgets: rmSees.status === 404 ? (await call(`/api/v1/dashboards/${dash.id}`, { token: rm, workspace: VASTU })).body.widgets : [] } });
check('viewers can duplicate it to customise', rmCopy.status === 201 && rmCopy.body.widgets.length === 2, rmCopy.body);
const sharedData = (await batch(rm, (await call(`/api/v1/dashboards/${dash.id}`, { token: rm, workspace: VASTU })).body.widgets, {}, { workspace: VASTU })).body;
const adminData = (await batch(admin, dash.widgets)).body;
check('the same shared dashboard shows each person only their own numbers', sharedData.k1.value <= adminData.k1.value && sharedData.b1.value === rmView.open.value, [sharedData.k1.value, adminData.k1.value, sharedData.b1.value]);
const second = await call('/api/v1/dashboards', { token: admin, method: 'POST', body: { name: 'Second', widgets: [kpi('k1', 'calls')] } });
await call(`/api/v1/dashboards/${second.body.id}/sharing`, { token: admin, method: 'PUT', body: { defaultForRoleIds: [RM_ROLE] } });
const afterSecond = (await call(`/api/v1/dashboards/${dash.id}`, { token: admin })).body;
check('a role has one default dashboard at a time', !afterSecond.sharing.defaultForRoleIds.includes(RM_ROLE) && (await call('/api/v1/dashboards', { token: rm, workspace: VASTU })).body.defaultId === second.body.id, afterSecond.sharing);
const badTarget = await call(`/api/v1/dashboards/${dash.id}/sharing`, { token: admin, method: 'PUT', body: { sharedUserIds: ['00000000-0000-4000-8000-000000000000'] } });
check('sharing targets must exist', badTarget.status === 400 && badTarget.body.code === 'INVALID_TARGET', badTarget.body);
const edited = await call(`/api/v1/dashboards/${dash.id}`, { token: admin, method: 'PATCH', body: { name: 'Sales review v2', widgets: [kpi('k1', 'won')] } });
check('the owner edits name and widgets', edited.status === 200 && edited.body.name === 'Sales review v2' && edited.body.widgets[0].metric === 'won', edited.body);

// ── Isolation ──
const abcSees = await call(`/api/v1/dashboards/${dash.id}`, { token: abc, tenant: 'abc' });
check('dashboards never cross organizations', abcSees.status === 404, abcSees.status);
const abcNums = (await batch(abc, [kpi('open', 'open_leads'), kpi('leads', 'leads', { range: 'this_year' })], {}, { tenant: 'abc' })).body;
const abcLeads = await call('/api/v1/leads', { token: abc, tenant: 'abc' });
check('numbers only count the organization’s own leads', abcNums.open.value <= abcLeads.total && abcNums.open.value < adminAll.open.value, [abcNums.open.value, abcLeads.total]);
const abcFilter = (await batch(abc, [kpi('open', 'open_leads')], { filters: { ownerIds: [ARJUN] } }, { tenant: 'abc' })).body;
check('filters cannot reach another organization’s people', abcFilter.open.value === 0, abcFilter.open.value);
const del = await call(`/api/v1/dashboards/${dash.id}`, { token: admin, method: 'DELETE' });
check('the owner deletes a dashboard', del.status === 200 && (await call(`/api/v1/dashboards/${dash.id}`, { token: admin })).status === 404, del.status);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll dashboard checks passed.');
process.exit(failures ? 1 : 0);
