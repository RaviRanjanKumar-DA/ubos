// End-to-end checks for slice 4.2: deleting and restoring leads, the Deleted leads report, the Excel round trip,
// bulk task upload (IST dates) and bulk task cancel.
// Usage: npm run verify:bulk   (API running, freshly seeded; run `npm run db:seed` afterwards).
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
  return { status: res.status, body: json, text };
}
const login = async (id, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier: id, password: PASSWORD } })).body.accessToken;
const admin = await login('admin@mycompany.local');
const manager = await login('manager@mycompany.local');
const rm = await login('arjun');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = me.workspaces.find((w) => w.name === 'Vastu Consultation / Audit').id;
const A = { token: admin, workspace: VASTU }, M = { token: manager, workspace: VASTU }, R = { token: rm, workspace: VASTU };
let n = 0;
const mobile = () => `98407${String(100000 + ++n).slice(1)}`;
const mkLead = async (name) => { const mob = mobile(); const l = (await call('/api/v1/leads', { ...R, method: 'POST', body: { name, mobile: mob, source: 'website', customFields: { property_type: 'Home' } } })).body; return { ...l, mobile: mob }; };
const listNames = async (who = A) => { const r = (await call('/api/v1/leads?limit=200', who)).body; return (r.rows ?? r.items ?? r).map((l) => l.name ?? l.customer?.name); };

// ---- Delete and restore ----
const d1 = await mkLead('Bulk Delete One'), d2 = await mkLead('Bulk Delete Two'), keep = await mkLead('Bulk Keep');
await call('/api/v1/tasks', { ...R, method: 'POST', body: { title: 'Task on deleted lead', dueAt: new Date(Date.now() + 7_200_000).toISOString(), leadId: d1.id } });
check('a salesperson cannot delete leads', (await call('/api/v1/leads/delete', { ...R, method: 'POST', body: { leadIds: [d1.id], reason: 'test reason' } })).status === 403);
check('deleting needs a reason', (await call('/api/v1/leads/delete', { ...A, method: 'POST', body: { leadIds: [d1.id] } })).status === 400);
const del = await call('/api/v1/leads/delete', { ...A, method: 'POST', body: { leadIds: [d1.id, d2.id], reason: 'Test entries by mistake' } });
check('an admin deletes leads and their open tasks are cancelled', del.status === 200 && del.body.deleted === 2 && del.body.tasksCancelled === 1, del.body);
const names = await listNames();
check('deleted leads leave the list', !names.includes('Bulk Delete One') && !names.includes('Bulk Delete Two') && names.includes('Bulk Keep'), names.slice(0, 5));
check('a deleted lead cannot be opened', (await call(`/api/v1/leads/${d1.id}`, A)).status === 404);
check('deleted leads leave the reports', !(await call('/api/v1/reports/leads', { token: admin })).body.rows.some((r) => r.name === 'Bulk Delete One'));
const delRep = (await call('/api/v1/reports/deleted', { token: admin })).body;
const row = delRep.rows.find((r) => r.name === 'Bulk Delete One');
check('the Deleted leads report shows who, when and why', row?.reason === 'Test entries by mistake' && row.deletedBy === 'Company Admin' && !!row.deletedAt && delRep.rows.length >= 2, row);
check('a salesperson cannot restore', (await call('/api/v1/leads/restore', { ...R, method: 'POST', body: { leadIds: [d1.id] } })).status === 403);
const res = await call('/api/v1/leads/restore', { ...A, method: 'POST', body: { leadIds: [d1.id] } });
check('an admin restores a lead', res.body.restored === 1 && (await listNames()).includes('Bulk Delete One') && !(await call('/api/v1/reports/deleted', { token: admin })).body.rows.some((r) => r.name === 'Bulk Delete One'), res.body);
const detail = (await call(`/api/v1/leads/${d1.id}`, A)).body;
check('the lead timeline records the delete and the restore', JSON.stringify(detail.activities).includes('Lead deleted: Test entries by mistake') && JSON.stringify(detail.activities).includes('Lead restored'));
check('restoring a lead that is not deleted does nothing', (await call('/api/v1/leads/restore', { ...A, method: 'POST', body: { leadIds: [keep.id] } })).body.code === 'NOTHING_TO_RESTORE');

// ---- Excel round trip ----
check('downloading leads for Excel needs a business line', (await call('/api/v1/leads/update-export', { token: admin })).body.code === 'WORKSPACE_REQUIRED');
const exp = await call('/api/v1/leads/update-export?match=mobile', A);
const lines = exp.text.replace(/^﻿/, '').split(/\r?\n/);
check('leads download in the update format', exp.status === 200 && lines[0].startsWith('Mobile,Name,Stage,Status,Owner,Source,Labels') && lines[0].includes('cf:property_type') && exp.text.includes('Bulk Keep'), lines[0]);
check('deleted leads are not in the download', !exp.text.includes('Bulk Delete Two'));
const settings = (await call(`/api/v1/workspaces/${VASTU}/settings`, A)).body;
const contacted = settings.pipelines.find((p) => p.name === 'Consultation').stages.find((s) => s.name === 'Contacted');
const up = await call('/api/v1/leads/bulk-update', { ...A, method: 'POST', body: { dryRun: false, match: 'mobile', rows: [{ key: keep.mobile, stage: contacted.name }] } });
const keepNow = (await call(`/api/v1/leads/${keep.id}`, A)).body;
check('changing a cell and uploading back updates the lead', up.status === 200 && keepNow.stageId === contacted.id, up.body);

// ---- Bulk task upload ----
const rows = [
  { assignee: 'arjun', title: 'Uploaded call', due: '2026-12-01 11:00', type: 'call', lead: keep.mobile },
  { assignee: 'manager@mycompany.local', title: 'Uploaded meeting', due: '02/12/2026 16:30', type: 'meeting', durationMin: '60' },
  { assignee: 'nobody@nowhere', title: 'Bad person', due: '2026-12-01' },
  { assignee: 'arjun', title: 'Bad date', due: '31/02/2026' },
  { assignee: 'arjun', title: 'Bad type', due: '2026-12-01', type: 'party' },
  { assignee: 'arjun', title: 'Unknown lead', due: '2026-12-01', lead: '9999999999' },
];
check('a salesperson cannot upload tasks', (await call('/api/v1/tasks/import', { ...R, method: 'POST', body: { dryRun: true, rows } })).status === 403);
const dry = (await call('/api/v1/tasks/import', { ...M, method: 'POST', body: { dryRun: true, rows } })).body;
check('a check finds every problem and saves nothing', dry.ok === 2 && dry.failed === 4 && dry.results.find((r) => r.row === 4).message.includes('No active user') && dry.results.find((r) => r.row === 5).message.includes('not a date') && dry.results.find((r) => r.row === 6).message.includes('Type') && dry.results.find((r) => r.row === 7).message.includes('No lead'), dry.results);
const before = (await call('/api/v1/tasks?status=open&from=2026-11-30T00:00:00Z&to=2026-12-03T00:00:00Z', M)).body.length;
const made = (await call('/api/v1/tasks/import', { ...M, method: 'POST', body: { dryRun: false, rows: rows.slice(0, 2) } })).body;
const open = (await call('/api/v1/tasks?status=open&from=2026-11-30T00:00:00Z&to=2026-12-03T00:00:00Z', M)).body;
const upCall = open.find((t) => t.title === 'Uploaded call');
check('valid tasks are created', made.ok === 2 && open.length === before + 2, made);
check('due times are India time and the lead is linked', upCall?.dueAt === '2026-12-01T05:30:00.000Z' && upCall.leadId === keep.id && open.find((t) => t.title === 'Uploaded meeting')?.dueAt === '2026-12-02T11:00:00.000Z', upCall);

// ---- Bulk cancel ----
const meeting = open.find((t) => t.title === 'Uploaded meeting');
const rmCancel = await call('/api/v1/tasks/cancel', { ...R, method: 'POST', body: { taskIds: [meeting.id] } });
check('a salesperson cannot cancel someone else\'s task', rmCancel.body.cancelled === 0 && rmCancel.body.skipped === 1, rmCancel.body);
const cx = await call('/api/v1/tasks/cancel', { ...M, method: 'POST', body: { taskIds: [meeting.id, upCall.id] } });
const after = (await call('/api/v1/tasks?status=open&from=2026-11-30T00:00:00Z&to=2026-12-03T00:00:00Z', M)).body;
check('tasks are cancelled together and leave open lists', cx.body.cancelled === 2 && !after.some((t) => t.id === meeting.id || t.id === upCall.id), cx.body);
const tr = (await call('/api/v1/reports/tasks?range=custom&from=2026-11-30&to=2026-12-03', { token: admin })).body;
check('the Tasks report shows them as cancelled', tr.rows.filter((r) => r.state === 'Cancelled').length >= 2, tr.rows.map((r) => r.state));

const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('bulk changes are audited', ['lead.deleted', 'lead.restored', 'lead.update_exported', 'task.bulk_uploaded', 'task.bulk_cancelled'].every((a) => audit.includes(a)));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
