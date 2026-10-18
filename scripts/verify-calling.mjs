// End-to-end checks for slice 2.1 (calling core): phone pairing, the phone app's API (sync, calls batch with
// idempotency and edits, reconcile, resumable recording upload), unmatched / unknown callers, recordings with permission
// and audit, retention, dialing from the web, CallerDesk webhooks and click-to-call, manual calls in the log, live
// updates. The phone app and CallerDesk are simulated (a local server plays CallerDesk).
// Usage: npm run verify:calling   (API running, freshly seeded; run `npm run db:seed` afterwards)

import { createServer } from 'node:http';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const PORT = Number(process.env.VERIFY_CALL_PORT ?? 4598);
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers = {}, raw = false, redirect = 'follow' } = {}) {
  const h = { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(path.startsWith('http') ? path : API + path, { method, headers: h, redirect, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json;
  try { json = JSON.parse(buf.toString()); } catch { json = buf; }
  return { status: res.status, body: json, headers: res.headers };
}
const login = async (identifier, tenant = 'mycompany') =>
  (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

// ── Stand-in for CallerDesk: serves a recording file and answers click-to-call ──
const recording = Buffer.from('ID3' + 'fake-mp3-audio-'.repeat(400));
const clicks = [];
const server = createServer((req, res) => {
  if (req.url.startsWith('/rec.mp3')) { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': recording.length }); return res.end(recording); }
  if (req.url.startsWith('/api/click_to_call_v2')) { clicks.push(new URL(req.url, 'http://x').searchParams); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"type":"success","message":"Call initiated"}'); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(PORT, r));
const LOCAL = `http://localhost:${PORT}`;

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const simran = await login('rm2@mycompany.local');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const users = (await call('/api/v1/users', { token: admin })).body;
const ARJUN = users.find((u) => u.email === 'rm@mycompany.local').id;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local').id;
const vastu = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body;
const arjunLead = vastu.find((l) => l.ownerId === ARJUN);
const nehaLead = vastu.find((l) => l.ownerId === NEHA);
const arjunLeadD = (await call(`/api/v1/leads/${arjunLead.id}`, { token: admin, workspace: VASTU })).body;
const DEV = (t) => ({ tenant: null, headers: { Authorization: `Device ${t}` } });

try {
  // ── Pairing ──
  const code = await call('/api/v1/devices/pair-code', { token: rm, method: 'POST' });
  check('a person gets a 6-digit pairing code (10 minutes)', code.status === 201 && /^\d{6}$/.test(code.body.code) && code.body.org === 'mycompany', code.body);
  const wrong = await call('/mobile/v1/pair', { tenant: null, method: 'POST', body: { org: 'mycompany', code: code.body.code === '000000' ? '111111' : '000000', deviceName: 'Arjun Redmi' } });
  const pair = await call('/mobile/v1/pair', { tenant: null, method: 'POST', body: { org: 'mycompany', code: code.body.code, deviceName: 'Arjun Redmi', platform: 'android', appVersion: '0.1.0' } });
  const reuse = await call('/mobile/v1/pair', { tenant: null, method: 'POST', body: { org: 'mycompany', code: code.body.code, deviceName: 'Copy' } });
  check('the phone pairs with the code once (wrong or reused codes fail)', wrong.status === 401 && pair.status === 200 && /^dev_/.test(pair.body.token) && pair.body.user.id === ARJUN && reuse.status === 401, [wrong.status, pair.body, reuse.status]);
  const T = pair.body.token;
  const noTok = await call('/mobile/v1/sync', { tenant: null });
  check('the phone API needs the device token', noTok.status === 401, noTok.status);

  // ── Sync ──
  const sync = await call('/mobile/v1/sync', DEV(T));
  check('sync gives the person’s own open leads, outcomes and scripts', sync.status === 200 && sync.body.leads.length > 0 && sync.body.leads.every((l) => vastu.find((v) => v.id === l.id)?.ownerId === ARJUN || !vastu.find((v) => v.id === l.id)) && sync.body.leads.some((l) => l.id === arjunLead.id && l.dialNumber) && sync.body.dispositions.some((d) => d.value === 'interested'), { n: sync.body.leads?.length, d: sync.body.dispositions?.length });

  // ── Calls from the phone ──
  const A = { externalId: 'dev1:1001:1760000000', leadId: arjunLead.id, number: arjunLeadD.mobile, direction: 'outbound', startedAt: ago(120), ringSec: 6, talkSec: 125, answered: true, disposition: 'interested', remark: 'Wants an audit next week', updatedAt: ago(119) };
  const b1 = await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [A], pending: 0 } });
  const b2 = await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [A] } });
  check('a call from the phone is stored once (sending it again is a duplicate)', b1.body.results[0].status === 'created' && b1.body.results[0].leadId === arjunLead.id && b2.body.results[0].status === 'duplicate', [b1.body, b2.body]);
  const edited = await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [{ ...A, remark: 'Audit booked for Tuesday', disposition: 'call_back', updatedAt: ago(5) }] } });
  const stale = await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [{ ...A, remark: 'old edit', updatedAt: ago(60) }] } });
  const leadA = (await call(`/api/v1/leads/${arjunLead.id}`, { token: rm, workspace: VASTU })).body;
  const actA = leadA.activities.find((x) => x.type === 'call' && x.durationSec === 125);
  check('an edit made later on the phone updates the call; an older edit does not', edited.body.results[0].status === 'updated' && stale.body.results[0].status === 'duplicate' && actA?.remark === 'Audit booked for Tuesday' && actA.disposition === 'call_back', [edited.body, stale.body, actA]);
  check('the call sits on the journey at the time it happened (not when it synced)', actA && Math.abs(new Date(actA.at).getTime() - new Date(A.startedAt).getTime()) < 2000 && leadA.lastDisposition === 'call_back', actA);
  const future = await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [{ ...A, externalId: 'dev1:9999:future', startedAt: new Date(Date.now() + 86_400_000).toISOString() }] } });
  check('calls dated in the future are refused (phone clock wrong)', future.body.results[0].status === 'rejected', future.body);

  // Unknown numbers
  const U = { externalId: 'dev1:1002:1760000100', number: '+91 98111 22334', direction: 'inbound', startedAt: ago(90), talkSec: 40, answered: true };
  const un = await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [U] } });
  const unList = (await call('/api/v1/calls?view=unmatched', { token: rm, workspace: VASTU })).body;
  const mgrUn = (await call('/api/v1/calls?view=unmatched', { token: manager, workspace: VASTU })).body;
  check('a number not in UBOS is kept as an unmatched call (visible to the caller and managers)', un.body.results[0].status === 'unmatched' && unList.some((c) => c.id === un.body.results[0].callId) && mgrUn.some((c) => c.id === un.body.results[0].callId), [un.body, unList.length]);
  const link = await call(`/api/v1/calls/${un.body.results[0].callId}/link`, { token: rm, workspace: VASTU, method: 'POST', body: { leadId: arjunLead.id } });
  const relink = await call(`/api/v1/calls/${un.body.results[0].callId}/link`, { token: rm, workspace: VASTU, method: 'POST', body: { leadId: arjunLead.id } });
  check('an unmatched call can be put on a lead (once)', link.status === 201 && relink.status === 400, [link.body, relink.body]);
  const setUnknown = await call('/api/v1/settings/calling', { token: admin, method: 'PUT', body: { recordingMode: 'ubos', recordingRetentionDays: null, unknownCallerWorkspaceId: VASTU, dispositionRequired: true } });
  const U2 = { externalId: 'dev1:1003:1760000200', number: '9811122335', direction: 'inbound', startedAt: ago(80), talkSec: 0, answered: false };
  const un2 = await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [U2] } });
  const newLead = un2.body.results[0].leadId ? (await call(`/api/v1/leads/${un2.body.results[0].leadId}`, { token: admin, workspace: VASTU })).body : null;
  check('with “new leads from unknown callers” on, an inbound call from a new number becomes a lead', setUnknown.status === 200 && un2.body.results[0].status === 'created' && newLead?.source === 'phone_call' && newLead.workspace.id === VASTU && newLead.activities.some((a) => a.type === 'call' && a.disposition === 'not_answered'), [un2.body, newLead && { src: newLead.source }]);
  const sync2 = await call('/mobile/v1/sync', DEV(T));
  check('the phone learns that the outcome is required after every call', sync2.body.dispositionRequired === true, sync2.body.dispositionRequired);

  // Reconcile
  const rec = await call('/mobile/v1/calls/reconcile', { ...DEV(T), method: 'POST', body: { since: ago(600), externalIds: [A.externalId, U.externalId, 'dev1:7777:never-sent'] } });
  check('reconciliation returns exactly the calls UBOS does not have', rec.status === 200 && JSON.stringify(rec.body.missing) === JSON.stringify(['dev1:7777:never-sent']), rec.body);

  // ── Recording upload (resumable) ──
  const audio = Buffer.from('ID3' + 'phone-recording-'.repeat(1500));
  const total = audio.length;
  const up = (start, end) => call(`/mobile/v1/calls/${encodeURIComponent(A.externalId)}/recording`, { tenant: null, raw: true, method: 'PUT', body: audio.subarray(start, end + 1), headers: { Authorization: `Device ${T}`, 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${total}` } });
  const c1 = await up(0, 9999);
  const st = await call(`/mobile/v1/calls/${encodeURIComponent(A.externalId)}/recording`, DEV(T));
  const skip = await up(15000, 19999);
  const c2 = await up(10000, 19999);
  const c3 = await up(20000, total - 1);
  check('recordings upload in chunks and resume where they stopped', c1.body.received === 10000 && st.body.received === 10000 && skip.body.received === 10000 && c2.body.received === 20000 && c3.body.status === 'ready', [c1.body, st.body, skip.body, c2.body, c3.body]);
  const notAudio = await call(`/mobile/v1/calls/${encodeURIComponent(U2.externalId)}/recording`, { tenant: null, raw: true, method: 'PUT', body: Buffer.from('x'), headers: { Authorization: `Device ${T}`, 'Content-Type': 'text/plain', 'Content-Range': 'bytes 0-0/1' } });
  check('only audio files are accepted', notAudio.status === 400, notAudio.body);
  const callA = (await call(`/api/v1/calls?leadId=${arjunLead.id}`, { token: rm, workspace: VASTU })).body.find((c) => c.talkSec === 125);
  const play = await call(`/api/v1/calls/${callA.id}/recording`, { token: rm, workspace: VASTU });
  check('the owner plays the recording (decrypted on the fly, not cached)', play.status === 200 && Buffer.compare(play.body, audio) === 0 && play.headers.get('content-type') === 'audio/mpeg' && /no-store/.test(play.headers.get('cache-control')), [play.status, play.body?.length]);
  const audPlay = await call(`/api/v1/calls/${callA.id}/recording`, { token: auditor });
  const simPlay = await call(`/api/v1/calls/${callA.id}/recording`, { token: simran });
  check('people without the listening permission or outside the lead’s scope cannot play it', audPlay.status === 403 && [403, 404].includes(simPlay.status), [audPlay.status, simPlay.status]);
  const audit = (await call('/api/v1/audit-logs', { token: admin })).body;
  check('playing a recording and pairing a phone are in the audit log', audit.some((l) => l.action === 'call.recording_played') && audit.some((l) => l.action === 'device.paired'), audit.slice(0, 6).map((l) => l.action));

  // ── Call log on the web ──
  const myCalls = (await call('/api/v1/calls', { token: rm, workspace: VASTU })).body;
  const mgrCalls = (await call('/api/v1/calls', { token: manager, workspace: VASTU })).body;
  const answered = (await call('/api/v1/calls?answered=false', { token: rm, workspace: VASTU })).body;
  const abcCalls = (await call('/api/v1/calls', { token: abc, tenant: 'abc' })).body;
  check('call log: own calls, the manager sees the team’s, filters work, other organizations see nothing', myCalls.some((c) => c.id === callA.id && c.recording === 'ready' && c.canListen && c.channel === 'sim') && mgrCalls.some((c) => c.id === callA.id) && answered.every((c) => !c.answered) && abcCalls.length === 0, [myCalls.length, mgrCalls.length, abcCalls.length]);
  await call(`/api/v1/leads/${arjunLead.id}/activities`, { token: rm, workspace: VASTU, method: 'POST', body: { type: 'call', disposition: 'connected', durationSec: 60, remark: 'Logged by hand' } });
  const manual = (await call(`/api/v1/calls?leadId=${arjunLead.id}&channel=manual`, { token: rm, workspace: VASTU })).body;
  check('calls logged by hand appear in the same call log', manual.length === 1 && manual[0].talkSec === 60 && manual[0].remark === 'Logged by hand', manual);

  // ── Live updates ──
  const events = [];
  const ctrl = new AbortController();
  const sse = fetch(`${API}/api/v1/stream?tenant=mycompany`, { headers: { Authorization: `Bearer ${manager}` }, signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(new TextDecoder().decode(value)); }
  }).catch(() => undefined);
  await sleep(400);
  await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [{ ...A, externalId: 'dev1:1004:live', startedAt: ago(1), talkSec: 30, remark: null, disposition: null, updatedAt: null }] } });
  await sleep(800);
  ctrl.abort(); await sse;
  check('open browsers get a live “call.logged” event within a second', events.join('').includes('event: call.logged') && events.join('').includes(arjunLead.id), events.join('').slice(0, 300));

  // ── Dialing from the web ──
  const dial = await call(`/api/v1/leads/${arjunLead.id}/dial`, { token: rm, workspace: VASTU, method: 'POST', body: {} });
  const s3 = await call('/mobile/v1/sync', DEV(T));
  const s4 = await call('/mobile/v1/sync', DEV(T));
  check('“Call” on the web makes the paired phone dial (picked up once)', dial.status === 201 && dial.body.via === 'phone' && s3.body.dial.length === 1 && s3.body.dial[0].leadId === arjunLead.id && s4.body.dial.length === 0, [dial.body, s3.body.dial, s4.body.dial]);
  const COURSE = ws['Course / Software'];
  const simLead = (await call('/api/v1/leads', { token: simran, workspace: COURSE })).body[0];
  const simDial = await call(`/api/v1/leads/${simLead.id}/dial`, { token: simran, workspace: COURSE, method: 'POST', body: {} });
  check('without a paired phone or cloud calling, the web says how to set it up', simDial.status === 400 && simDial.body.code === 'NO_CALLING', simDial.body);

  // ── CallerDesk (cloud) ──
  await call('/api/v1/integrations/callerdesk/setup', { token: admin, method: 'PUT', body: { values: { apiKey: 'cd-auth-123', callerId: '08069000000', apiBase: `${LOCAL}/api`, businessLine: '' }, activate: true } });
  const cdUrl = (await call('/api/v1/integrations/callerdesk/setup', { token: admin })).body.webhookUrl;
  const cdCall = { call_id: 'CD-5001', customer_number: arjunLeadD.mobile, agent_number: '9876511111', call_type: 'outbound', start_time: new Date(Date.now() - 30 * 60_000).toISOString(), talk_duration: '00:01:30', call_status: 'ANSWER', recording_url: `${LOCAL}/rec.mp3` };
  const cd1 = await call(cdUrl, { tenant: null, method: 'POST', body: cdCall });
  const cd2 = await call(cdUrl, { tenant: null, method: 'POST', body: cdCall });
  const cdRow = (await call(`/api/v1/calls?leadId=${arjunLead.id}&channel=cloud`, { token: rm, workspace: VASTU })).body[0];
  check('a CallerDesk webhook becomes a call on the lead (agent matched by mobile; resent = duplicate)', cd1.status === 200 && cd1.body.results[0].status === 'created' && cd2.body.results[0].status === 'duplicate' && cdRow?.userId === ARJUN && cdRow.talkSec === 90 && cdRow.provider === 'callerdesk', [cd1.body, cd2.body, cdRow]);
  const cdPlay = cdRow ? await call(`/api/v1/calls/${cdRow.id}/recording`, { token: rm, workspace: VASTU }) : { status: 0 };
  check('“copy recordings into UBOS”: the provider’s file is stored (encrypted) and plays from UBOS', cdRow?.recording === 'ready' && cdPlay.status === 200 && Buffer.compare(cdPlay.body, recording) === 0, [cdRow?.recording, cdPlay.status]);
  await call('/api/v1/settings/calling', { token: admin, method: 'PUT', body: { recordingMode: 'provider', recordingRetentionDays: null, unknownCallerWorkspaceId: VASTU, dispositionRequired: false } });
  await call(cdUrl, { tenant: null, method: 'POST', body: { ...cdCall, call_id: 'CD-5002' } });
  const linkRow = (await call(`/api/v1/calls?leadId=${arjunLead.id}&channel=cloud`, { token: rm, workspace: VASTU })).body.find((c) => c.recording === 'link');
  const linkPlay = linkRow ? await call(`/api/v1/calls/${linkRow.id}/recording`, { token: rm, workspace: VASTU, redirect: 'manual' }) : { status: 0, headers: new Headers() };
  check('“keep at the provider”: UBOS stores only the link and redirects to it', linkPlay.status === 302 && linkPlay.headers.get('location') === `${LOCAL}/rec.mp3`, [linkRow?.recording, linkPlay.status]);
  const missed = await call(cdUrl, { tenant: null, method: 'POST', body: { call_id: 'CD-5003', customer_number: '9811122399', agent_number: '9876511111', call_type: 'inbound', talk_duration: '0', call_status: 'NOANSWER' } });
  check('a missed call from a new number becomes a lead (unknown-caller setting)', missed.body.results[0].status === 'created' && !!missed.body.results[0].leadId, missed.body);
  const click = await call(`/api/v1/leads/${arjunLead.id}/dial`, { token: rm, workspace: VASTU, method: 'POST', body: { via: 'cloud' } });
  check('click-to-call through CallerDesk rings the agent, then the customer', click.status === 201 && click.body.via === 'cloud' && clicks.length === 1 && clicks[0].get('calling_party_a') === '9876511111' && clicks[0].get('authcode') === 'cd-auth-123' && clicks[0].get('calling_party_b') === arjunLeadD.mobile.replace(/^\+91/, ''), [click.body, clicks.map((c) => Object.fromEntries(c))]);

  // ── Retention ──
  const OLD = { externalId: 'dev1:1005:old', leadId: arjunLead.id, number: arjunLeadD.mobile, direction: 'outbound', startedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(), talkSec: 20, answered: true };
  await call('/mobile/v1/calls', { ...DEV(T), method: 'POST', body: { calls: [OLD] } });
  const small = Buffer.from('ID3old');
  await call(`/mobile/v1/calls/${encodeURIComponent(OLD.externalId)}/recording`, { tenant: null, raw: true, method: 'PUT', body: small, headers: { Authorization: `Device ${T}`, 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes 0-${small.length - 1}/${small.length}` } });
  const oldRow = (await call(`/api/v1/calls?leadId=${arjunLead.id}&channel=sim`, { token: rm, workspace: VASTU, })).body.find((c) => c.talkSec === 20);
  await call('/api/v1/automation/run-now', { token: admin, method: 'POST' });
  const oldAfter = (await call(`/api/v1/calls?leadId=${arjunLead.id}&channel=sim`, { token: rm, workspace: VASTU })).body.find((c) => c.talkSec === 20);
  const oldPlay = oldRow ? await call(`/api/v1/calls/${oldRow.id}/recording`, { token: rm, workspace: VASTU }) : { status: 0 };
  const recent = await call(`/api/v1/calls/${callA.id}/recording`, { token: rm, workspace: VASTU });
  check('recordings older than the retention are deleted (the call itself stays); recent ones stay', oldRow?.recording === 'ready' && oldAfter?.recording === 'deleted' && oldPlay.status === 404 && recent.status === 200, [oldRow?.recording, oldAfter?.recording, oldPlay.status, recent.status]);

  // ── Phones admin & revoke ──
  const myPhones = (await call('/api/v1/devices', { token: rm })).body;
  const allPhones = (await call('/api/v1/devices?all=true', { token: admin })).body;
  check('people see their phone; admins see every phone (last sync, app version)', myPhones.length === 1 && !!myPhones[0].lastSyncAt && myPhones[0].appVersion === '0.1.0' && allPhones.some((d) => d.userName.startsWith('Arjun')) && !('tokenHash' in myPhones[0]), myPhones);
  const otherRevoke = await call(`/api/v1/devices/${myPhones[0].id}/revoke`, { token: simran, method: 'POST' });
  check('someone else cannot unpair your phone', otherRevoke.status === 403, otherRevoke.status);
  const code2 = (await call('/api/v1/devices/pair-code', { token: rm, method: 'POST' })).body;
  const pair2 = await call('/mobile/v1/pair', { tenant: null, method: 'POST', body: { org: 'mycompany', code: code2.code, deviceName: 'Arjun new phone' } });
  const oldTok = await call('/mobile/v1/sync', DEV(T));
  check('pairing a new phone retires the old one', pair2.status === 200 && oldTok.status === 401, [pair2.status, oldTok.status]);
  await call(`/api/v1/devices/${(await call('/api/v1/devices', { token: rm })).body.find((d) => !d.revokedAt).id}/revoke`, { token: rm, method: 'POST' });
  const revoked = await call('/mobile/v1/sync', DEV(pair2.body.token));
  check('an unpaired phone stops syncing at once', revoked.status === 401 && revoked.body.code === 'DEVICE_REVOKED', revoked.body);

  // ── Plan ──
  const abcCode = await call('/api/v1/devices/pair-code', { token: abc, tenant: 'abc', method: 'POST' });
  const abcHasSim = (await call('/api/v1/settings/calling', { token: abc, tenant: 'abc' })).body.simCalling;
  check('pairing follows the plan (SIM calling module)', abcHasSim ? abcCode.status === 201 : abcCode.status === 403, [abcHasSim, abcCode.status]);
} finally {
  server.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll calling checks passed');
process.exit(failures ? 1 : 0);
