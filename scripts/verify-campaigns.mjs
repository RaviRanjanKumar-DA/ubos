// End-to-end checks for slice 2.6 (calling campaigns): who can create and see campaigns, the dialer queue with a required
// outcome, retries, access limits, racing claims, phone-reported calls counted once, reports, CSV and coaching comments.
// Usage: npm run verify:campaigns   (API running, freshly seeded; run `npm run db:seed` afterwards)

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const simran = await login('rm2@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]))['Vastu Consultation / Audit'];
const users = (await call('/api/v1/users', { token: admin })).body;
const ARJUN = users.find((u) => u.email === 'rm@mycompany.local').id;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local').id;
const ADMIN = users.find((u) => u.email === 'admin@mycompany.local').id;
const post = (path, token, body) => call(path, { token, workspace: VASTU, method: 'POST', body: body ?? {} });
const get = (path, token) => call(path, { token, workspace: VASTU });
const next = (id, token) => post(`/api/v1/call-campaigns/${id}/next`, token);
const dialed = (i, token) => post(`/api/v1/call-campaigns/items/${i}/dialed`, token);
const skip = (i, token) => post(`/api/v1/call-campaigns/items/${i}/skip`, token);
const outcome = (i, token, body) => post(`/api/v1/call-campaigns/items/${i}/outcome`, token, body);
const leadCalls = async (leadId) => (await get(`/api/v1/calls?leadId=${leadId}`, admin)).body;
const make = async (name, filter, agentIds, extra = {}) => (await post('/api/v1/call-campaigns', manager, { name, filter, agentIds, ...extra })).body.id;

// The seed has few leads; give each caller a working list.
for (let i = 0; i < 12; i++) await post('/api/v1/leads', admin, { name: `Campaign Lead ${i + 1}`, mobile: `98207${String(10000 + i).slice(1)}0`.slice(0, 10), ownerId: ARJUN, customFields: { property_type: 'Home' } });
for (let i = 0; i < 2; i++) await post('/api/v1/leads', admin, { name: `Neha Lead ${i + 1}`, mobile: `98208${String(10000 + i).slice(1)}0`.slice(0, 10), ownerId: NEHA, customFields: { property_type: 'Home' } });

// ── Who can do what ──
const optM = (await get('/api/v1/call-campaigns/options', manager)).body;
const optR = (await get('/api/v1/call-campaigns/options', rm)).body;
check('managers can manage campaigns, callers cannot', optM.canManage === true && optR.canManage === false && optM.users.length > 0 && optM.stages.length > 0, [optM.canManage, optR.canManage]);
check('auditors are not offered as callers', optM.users.every((u) => !/auditor/i.test(u.label)), optM.users);
const prev = await post('/api/v1/call-campaigns/preview', manager, { owners: [ARJUN, NEHA] });
check('the list size can be previewed before saving', prev.body.leads > 5, prev.body);
const rmPrev = await post('/api/v1/call-campaigns/preview', rm, { owners: [ARJUN] });
const rmMake = await post('/api/v1/call-campaigns', rm, { name: 'Mine', filter: {}, agentIds: [ARJUN] });
check('a caller cannot preview or create campaigns', rmPrev.status === 403 && rmMake.status === 403, [rmPrev.status, rmMake.status]);
const noAgent = await post('/api/v1/call-campaigns', manager, { name: 'Bad', filter: {}, agentIds: ['00000000-0000-4000-8000-000000000000'] });
const noLeads = await post('/api/v1/call-campaigns', manager, { name: 'Empty', filter: { statuses: ['no_such_status'] }, agentIds: [ARJUN] });
check('unknown callers and empty lists are refused', noAgent.body.code === 'INVALID_AGENT' && noLeads.body.code === 'NO_LEADS', [noAgent.body, noLeads.body]);
const created = await post('/api/v1/call-campaigns', manager, { name: 'Evening list', filter: { owners: [ARJUN, NEHA] }, agentIds: [ARJUN, NEHA], maxAttempts: 2, retryAfterMin: 5 });
const A = created.body.id;
check('a manager creates a campaign from a filtered list', created.status === 201 && created.body.leads === prev.body.leads, created.body);
const listR = (await get('/api/v1/call-campaigns', rm)).body;
const listS = (await get('/api/v1/call-campaigns', simran)).body;
check('callers see only campaigns they are on', listR.some((c) => c.id === A && c.isAgent) && !(Array.isArray(listS) && listS.some((c) => c.id === A)), listS);
check('another organization cannot reach the campaign', (await call(`/api/v1/call-campaigns/${A}/next`, { tenant: 'abc', token: abc, method: 'POST', body: {} })).status === 404);
check('someone not on the campaign cannot take calls', (await next(A, admin)).body.code === 'NOT_ON_CAMPAIGN');

// ── Dialer: required outcome ──
const first = (await next(A, rm)).body;
const firstLead = (await get(`/api/v1/leads/${first.item.leadId}`, admin)).body;
check('the caller gets a lead with the outcome choices', first.item.attempt === 1 && first.item.maxAttempts === 2 && first.dispositions.length > 0 && first.total === created.body.leads && first.item.name.length > 0 && first.item.status !== 'fresh' && first.item.source !== 'manual', first);
check('a campaign does not widen access: the caller gets their own lead', firstLead.owner?.id === ARJUN, firstLead.owner);
check('asking again returns the same open lead', (await next(A, rm)).body.item.id === first.item.id);
check('a lead not yet dialed can be skipped', (await skip(first.item.id, rm)).status === 201);
const second = (await next(A, rm)).body;
check('after a skip the next lead comes, with no attempt counted', second.item.id !== first.item.id && second.item.attempt === 1, second.item);
await dialed(second.item.id, rm);
const skipped = await skip(second.item.id, rm);
check('a dialed lead cannot be skipped', skipped.status === 409 && skipped.body.code === 'OUTCOME_REQUIRED', skipped.body);
check('a dialed lead stays until its outcome is saved', (await next(A, rm)).body.item.id === second.item.id);
const B = await make('Second list', { owners: [ARJUN] }, [ARJUN]);
const blocked = await next(B, rm);
check('another campaign is blocked while an outcome is owed', blocked.status === 409 && blocked.body.code === 'OUTCOME_REQUIRED', blocked.body);
check('an unknown outcome is refused', (await outcome(second.item.id, rm, { disposition: 'nope' })).body.code === 'INVALID_DISPOSITION');
check('an outcome is required', (await outcome(second.item.id, rm, {})).status === 400);
const missed = await outcome(second.item.id, rm, { disposition: 'not_answered' });
check('a call not connected comes back for a retry', missed.body.willRetry === true, missed.body);
const c2 = await leadCalls(second.item.leadId);
check('the call is in the call log with its outcome', c2.length === 1 && c2[0].channel === 'manual' && c2[0].disposition === 'not_answered' && c2[0].answered === false, c2);
check('the outcome of someone else’s call cannot be saved', (await outcome(second.item.id, manager, { disposition: 'interested' })).status === 404);

const third = (await next(A, rm)).body;
check('the retry waits for its time; the next lead comes meanwhile', third.item.leadId !== second.item.leadId, third.item);
const conn = await outcome(third.item.id, rm, { disposition: 'interested', remark: 'Wants a visit', durationSec: 90 });
const thirdLead = (await get(`/api/v1/leads/${third.item.leadId}`, admin)).body;
check('a connected call finishes the lead and updates it', conn.body.willRetry === false && thirdLead.lastDisposition === 'interested', [conn.body, thirdLead.lastDisposition]);
check('the call appears once on the lead’s journey', thirdLead.activities.filter((x) => x.type === 'call').length === 1, thirdLead.activities.map((x) => x.type));

const fourth = (await next(A, rm)).body;
const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
const fu = await outcome(fourth.item.id, rm, { disposition: 'not_answered', followUpAt: due, followUpNote: 'Try after lunch' });
const fourthLead = (await get(`/api/v1/leads/${fourth.item.leadId}`, admin)).body;
check('a planned follow-up ends the retries and is saved on the lead', fu.body.willRetry === false && new Date(fourthLead.nextFollowUpAt).toISOString() === due, [fu.body, fourthLead.nextFollowUpAt]);

// ── Calls reported by the phone count once ──
const code = (await call('/api/v1/devices/pair-code', { token: rm, method: 'POST' })).body.code;
const T = (await call('/mobile/v1/pair', { tenant: null, method: 'POST', body: { org: 'mycompany', code, deviceName: 'Test phone', platform: 'android', appVersion: '0.1.0' } })).body.token;
const phone = (calls) => call('/mobile/v1/calls', { tenant: null, headers: { Authorization: `Device ${T}` }, method: 'POST', body: { calls } });
const number = async (leadId) => (await get(`/api/v1/leads/${leadId}`, admin)).body.mobile;
const fifth = (await next(A, rm)).body;
await dialed(fifth.item.id, rm);
await phone([{ externalId: 'camp:1', leadId: fifth.item.leadId, number: await number(fifth.item.leadId), direction: 'outbound', startedAt: ago(0.2), ringSec: 4, talkSec: 75, answered: true, updatedAt: ago(0.2) }]);
await outcome(fifth.item.id, rm, { disposition: 'interested', remark: 'From the phone' });
const c5 = await leadCalls(fifth.item.leadId);
check('a call the phone reported first gets the outcome (no second call)', c5.length === 1 && c5[0].channel === 'sim' && c5[0].disposition === 'interested' && c5[0].talkSec === 75, c5);
const sixth = (await next(A, rm)).body;
await dialed(sixth.item.id, rm);
await outcome(sixth.item.id, rm, { disposition: 'interested', remark: 'Saved before sync' });
await phone([{ externalId: 'camp:2', leadId: sixth.item.leadId, number: await number(sixth.item.leadId), direction: 'outbound', startedAt: ago(1), ringSec: 3, talkSec: 44, answered: true, updatedAt: ago(1) }]);
const c6 = await leadCalls(sixth.item.leadId);
const l6 = (await get(`/api/v1/leads/${sixth.item.leadId}`, admin)).body;
check('a call the phone reports later merges with the saved outcome', c6.length === 1 && c6[0].channel === 'sim' && c6[0].disposition === 'interested' && c6[0].talkSec === 44, c6);
check('the merged call is once on the journey, with the real talk time', l6.activities.filter((x) => x.type === 'call').length === 1 && l6.activities.find((x) => x.type === 'call').durationSec === 44, l6.activities.filter((x) => x.type === 'call'));

// ── Racing claims ──
const race = await Promise.all(Array.from({ length: 6 }, () => next(A, rm)));
const raceIds = new Set(race.map((r) => r.body.item?.id));
check('six clicks at once give one open lead', race.every((r) => r.status === 201) && raceIds.size === 1 && !raceIds.has(undefined), race.map((r) => [r.status, r.body.item?.id ?? r.body.code]));
await skip([...raceIds][0], rm);
const Wide = await make('Shared list', { owners: [ARJUN, NEHA] }, [NEHA, ADMIN], { retryAfterMin: 5 });
let clash = 0;
for (let i = 0; i < 5; i++) {
  const [a, b] = await Promise.all([next(Wide, manager), next(Wide, admin)]);
  if (!a.body.item || !b.body.item || a.body.item.id === b.body.item.id) clash++;
  if (a.body.item) await skip(a.body.item.id, manager);
  if (b.body.item) await skip(b.body.item.id, admin);
}
check('two callers never get the same lead', clash === 0, clash);

// ── Pause, release, access limits, completion ──
const openN = (await next(Wide, manager)).body.item;
await dialed(openN.id, manager);
const repOpen = (await get(`/api/v1/call-campaigns/${Wide}/report`, admin)).body.open;
check('the report lists open calls and who has them', repOpen.some((o) => o.id === openN.id && o.dialedAt), repOpen);
check('a caller cannot release a call', (await post(`/api/v1/call-campaigns/items/${openN.id}/release`, rm)).status === 403);
const noArch = await call(`/api/v1/call-campaigns/${Wide}`, { token: manager, workspace: VASTU, method: 'PATCH', body: { archived: true } });
check('a campaign with an open call cannot be archived', noArch.body.code === 'CALLS_OPEN', noArch.body);
check('a manager releases a call someone left open', (await post(`/api/v1/call-campaigns/items/${openN.id}/release`, admin)).status === 201);
const patch = (id, token, body) => call(`/api/v1/call-campaigns/${id}`, { token, workspace: VASTU, method: 'PATCH', body });
check('a caller cannot pause a campaign', (await patch(B, rm, { status: 'paused' })).status === 403);
await patch(B, manager, { status: 'paused' });
const paused = (await next(B, rm)).body;
check('a paused campaign gives no leads', paused.item === null && paused.reason === 'paused', paused);
await patch(B, manager, { status: 'active' });
check('a resumed campaign gives leads again', (await next(B, rm)).body.item !== null);

const nehaLeads = (await get('/api/v1/leads', admin)).body.filter((l) => l.ownerId === NEHA);
await skip((await next(B, rm)).body.item.id, rm);
const NotMine = await make('Others', { owners: [NEHA] }, [ARJUN]);
const notMine = (await next(NotMine, rm)).body;
check('a caller receives nothing outside their access, and is told why', notMine.item === null && notMine.reason === 'not_your_leads', notMine);
const D = await make('Short list', { owners: [NEHA] }, [NEHA], { maxAttempts: 1 });
const stages = firstLead.pipeline.stages;
const won = stages.find((x) => x.isWon).id;
const closedIds = stages.filter((x) => x.isWon || x.isLost).map((x) => x.id);
const nehaOpen = nehaLeads.filter((l) => !closedIds.includes(l.stageId));
const keep = nehaOpen[nehaOpen.length - 1];
await post('/api/v1/leads/bulk', admin, { leadIds: nehaOpen.filter((l) => l.id !== keep.id).map((l) => l.id), action: 'stage', stageId: won });
const onlyOne = (await next(D, manager)).body;
check('a lead won meanwhile leaves the queue', onlyOne.item.leadId === keep.id && onlyOne.total === nehaOpen.length, [onlyOne.item, onlyOne.total, nehaOpen.length]);
const last = await outcome(onlyOne.item.id, manager, { disposition: 'not_answered' });
check('attempts run out at the limit', last.body.willRetry === false, last.body);
const list2 = (await get('/api/v1/call-campaigns', manager)).body.find((c) => c.id === D);
check('the campaign completes when nothing is left', list2.status === 'completed' && list2.done === 1 && list2.closed === nehaOpen.length - 1, list2);
check('a completed campaign cannot be restarted', (await patch(D, manager, { status: 'active' })).body.code === 'CAMPAIGN_COMPLETED');

// ── Reports ──
const rep = (await get(`/api/v1/call-campaigns/${A}/report`, manager)).body;
const arjunRow = rep.byAgent?.find((x) => x.userId === ARJUN);
check('the report counts calls, connections and talk time by person', rep.totals.calls === 5 && rep.totals.connected === 3 && rep.totals.talkSec === 90 + 75 + 44 && arjunRow.calls === 5 && rep.totals.connectRate === 60, rep.totals);
check('the report counts each outcome', rep.byOutcome.find((x) => x.value === 'interested').count === 3 && rep.byOutcome.find((x) => x.value === 'not_answered').count === 2, rep.byOutcome);
check('a caller cannot open the report', (await get(`/api/v1/call-campaigns/${A}/report`, rm)).status === 403);
const csv = await get(`/api/v1/call-campaigns/${A}/export`, manager);
check('the list exports to CSV with India times', csv.status === 200 && String(csv.body).includes('Last called (IST)') && String(csv.body).includes('Interested'), String(csv.body).slice(0, 200));
check('a caller cannot export it', (await get(`/api/v1/call-campaigns/${A}/export`, rm)).status === 403);
check('archiving hides the campaign, keeping its data', (await patch(NotMine, manager, { archived: true })).status === 200 && !(await get('/api/v1/call-campaigns', manager)).body.some((c) => c.id === NotMine));

// ── Coaching ──
const callId = c6[0].id;
const add = await post(`/api/v1/calls/${callId}/comments`, manager, { body: 'Good opening. Ask about the budget here.', atSec: 12 });
const add2 = await post(`/api/v1/calls/${callId}/comments`, rm, { body: 'Thanks, will do' });
const add3 = await post(`/api/v1/calls/${callId}/comments`, manager, { body: 'Strong start', atSec: 3 });
check('coaches and the caller can comment on a call', add.status === 201 && add2.status === 201 && add3.status === 201, [add.body, add2.body]);
const notes = (await get(`/api/v1/calls/${callId}/comments`, rm)).body;
check('comments run in recording order, general notes last', notes.map((n) => n.atSec).join() === '3,12,' && notes[0].authorName.length > 0, notes);
const bell = (await get('/api/v1/notifications', rm)).body;
check('the caller is told about a comment, with a link to the call', JSON.stringify(bell).includes(`/app/calls?coach=${callId}`), bell);
check('the comment count shows in the call log', (await leadCalls(sixth.item.leadId))[0].comments === 3);
const hidden = await call(`/api/v1/calls/${callId}/comments`, { token: simran });
check('people who cannot see the call cannot read its comments', [403, 404].includes(hidden.status), [hidden.status, hidden.body]);
check('another organization cannot read them', (await call(`/api/v1/calls/${callId}/comments`, { tenant: 'abc', token: abc })).status === 404);
check('an empty comment is refused', (await post(`/api/v1/calls/${callId}/comments`, manager, { body: '  ' })).status === 400);
check('a caller cannot remove a coach’s comment', (await post(`/api/v1/calls/comments/${add.body.id}/archive`, rm)).status === 403);
check('a coach removes their own comment', (await post(`/api/v1/calls/comments/${add.body.id}/archive`, manager)).status === 201 && (await get(`/api/v1/calls/${callId}/comments`, rm)).body.length === 2);
const logs = (await call('/api/v1/audit-logs', { token: admin })).body;
const acts = new Set((logs.items ?? logs).map((l) => l.action));
check('campaign and coaching actions are audited', ['campaign.created', 'campaign.call_released', 'campaign.exported', 'call.comment_added', 'call.comment_removed'].every((a) => acts.has(a)), [...acts].slice(0, 20));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll campaign checks passed');
process.exit(failures ? 1 : 0);
