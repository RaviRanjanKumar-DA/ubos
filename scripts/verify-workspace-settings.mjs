// End-to-end checks for Phase 1.3: pipelines & stages, custom lead fields, lead sources, lost reasons.
// Usage: npm run verify:settings   (API running, freshly seeded; run `npm run db:seed` afterwards to reset)

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 220)}` : ''}`);
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
const LOGO = ws['Logo Designing'];

// ── Read settings ──
const s = await call(`/api/v1/workspaces/${VASTU}/settings`, { token: admin });
check('settings show pipelines, fields, sources and lost reasons of a business line',
  s.status === 200 && s.body.pipelines.length === 2 && s.body.fields.length === 3 && s.body.sources.length >= 10 && s.body.lostReasons.length >= 5 && s.body.canManage === true,
  { p: s.body.pipelines?.length, f: s.body.fields?.length, src: s.body.sources?.length, lr: s.body.lostReasons?.length });
const rm = await login('arjun');
const rmS = await call(`/api/v1/workspaces/${VASTU}/settings`, { token: rm, workspace: VASTU });
const rmField = await call(`/api/v1/workspaces/${VASTU}/fields`, { token: rm, workspace: VASTU, method: 'POST', body: { label: 'X', type: 'text' } });
check('RM can read settings (for forms) but cannot change them', rmS.status === 200 && rmS.body.canManage === false && rmField.status === 403, [rmS.status, rmField.status]);
const rmOther = await call(`/api/v1/workspaces/${LOGO}/settings`, { token: rm, workspace: VASTU });
check('…and cannot read another business line', rmOther.status === 403);

// ── Custom fields ──
const facing = await call(`/api/v1/workspaces/${VASTU}/fields`, { token: admin, method: 'POST', body: { label: 'Facing direction', type: 'dropdown', options: ['East', 'West', 'North', 'South'] } });
check('admin adds a dropdown field (key generated from label)', facing.status === 201 && facing.body.key === 'facing_direction', facing.body);
const dupF = await call(`/api/v1/workspaces/${VASTU}/fields`, { token: admin, method: 'POST', body: { label: 'facing direction', type: 'text' } });
const noOpt = await call(`/api/v1/workspaces/${VASTU}/fields`, { token: admin, method: 'POST', body: { label: 'Zone', type: 'dropdown', options: [] } });
check('duplicate field names and dropdowns without options are refused', dupF.status === 409 && noOpt.status === 400, [dupF.body, noOpt.body]);

const missing = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Field Test', mobile: '9000022221', source: 'website' } });
check('a required custom field must be filled', missing.status === 400 && missing.body.code === 'INVALID_FIELDS' && !!missing.body.details?.property_type, missing.body);
const badOpt = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Field Test', mobile: '9000022221', source: 'website', customFields: { property_type: 'Castle' } } });
check('dropdown values must be one of the options', badOpt.status === 400 && !!badOpt.body.details?.property_type);
const badSrc = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Field Test', mobile: '9000022221', source: 'tiktok', customFields: { property_type: 'Office' } } });
check('source must be one of the workspace sources', badSrc.status === 400 && badSrc.body.code === 'INVALID_SOURCE', badSrc.body);
const ok = await call('/api/v1/leads', {
  token: admin, workspace: VASTU, method: 'POST',
  body: { name: 'Field Test', mobile: '9000022221', source: 'website', customFields: { property_type: 'Office', city: ' Noida ', site_visit_date: '2026-11-05', facing_direction: 'East', junk: 'x' } },
});
const listed = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body.find((l) => l.id === ok.body.id);
check('valid custom fields are saved (trimmed, unknown keys dropped)', ok.status === 201 && listed?.customFields?.city === 'Noida' && listed.customFields.facing_direction === 'East' && !('junk' in listed.customFields), listed?.customFields);
const upd = await call(`/api/v1/leads/${ok.body.id}/fields`, { token: admin, workspace: VASTU, method: 'PATCH', body: { customFields: { city: 'Gurugram' } } });
check('editing one field keeps the others', upd.status === 200 && upd.body.customFields.city === 'Gurugram' && upd.body.customFields.property_type === 'Office', upd.body);
const propType = s.body.fields.find((f) => f.key === 'property_type');
const dropUsed = await call(`/api/v1/fields/${propType.id}`, { token: admin, method: 'PATCH', body: { options: ['Home', 'Shop', 'Factory', 'Plot'] } });
check('a dropdown option that leads use cannot be removed', dropUsed.status === 409 && dropUsed.body.code === 'OPTION_IN_USE', dropUsed.body);
await call(`/api/v1/fields/${propType.id}`, { token: admin, method: 'PATCH', body: { isArchived: true } });
const afterArchive = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'No Type', mobile: '9000022222', source: 'website' } });
check('an archived field is no longer required', afterArchive.status === 201, afterArchive.body);
await call(`/api/v1/fields/${propType.id}`, { token: admin, method: 'PATCH', body: { isArchived: false } });

// ── Stages ──
const consult = s.body.pipelines.find((p) => p.name === 'Consultation');
const st = Object.fromEntries(consult.stages.map((x) => [x.name, x]));
const newStages = [
  { id: st.New.id, name: 'New' }, { id: st.Contacted.id, name: 'Contacted' }, { id: st.Interested.id, name: 'Interested' },
  { id: st['Follow-up'].id, name: 'Follow-up' }, { id: st.Demo.id, name: 'Consultation booked' }, { name: 'Report shared' },
  { id: st.Won.id, name: 'Won', isWon: true }, { id: st.Lost.id, name: 'Lost', isLost: true },
]; // "Negotiation" removed (no leads in it)
const saved = await call(`/api/v1/pipelines/${consult.id}/stages`, { token: admin, method: 'PUT', body: { stages: newStages } });
const after = (await call(`/api/v1/workspaces/${VASTU}/settings`, { token: admin })).body.pipelines.find((p) => p.id === consult.id);
check('stages can be renamed, added and removed in one save', saved.status === 200 && after.stages.map((x) => x.name).join('|') === 'New|Contacted|Interested|Follow-up|Consultation booked|Report shared|Won|Lost', after?.stages?.map((x) => x.name));
const withLeads = newStages.filter((x) => x.name !== 'New');
const inUse = await call(`/api/v1/pipelines/${consult.id}/stages`, { token: admin, method: 'PUT', body: { stages: withLeads } });
check('a stage that still has leads cannot be removed', inUse.status === 409 && inUse.body.code === 'STAGE_IN_USE', inUse.body);
const wonFirst = await call(`/api/v1/pipelines/${consult.id}/stages`, { token: admin, method: 'PUT', body: { stages: [{ name: 'Won', isWon: true }, ...newStages.slice(1, 3)] } });
check('the first stage must be open', wonFirst.status === 400);

// ── Lost reasons ──
const lostId = st.Lost.id;
const noReason = await call(`/api/v1/leads/${ok.body.id}/stage`, { token: admin, workspace: VASTU, method: 'PATCH', body: { stageId: lostId } });
check('moving a lead to Lost needs a reason', noReason.status === 400 && noReason.body.code === 'LOST_REASON_REQUIRED', noReason.body);
const withReason = await call(`/api/v1/leads/${ok.body.id}/stage`, { token: admin, workspace: VASTU, method: 'PATCH', body: { stageId: lostId, lostReason: 'Budget issue' } });
check('…and saves the reason', withReason.status === 200 && withReason.body.lostReason === 'Budget issue', withReason.body);
const reopen = await call(`/api/v1/leads/${ok.body.id}/stage`, { token: admin, workspace: VASTU, method: 'PATCH', body: { stageId: st.Contacted.id } });
check('re-opening a lead clears the lost reason', reopen.body.lostReason === null);
const reasons = s.body.lostReasons;
const saveReasons = await call(`/api/v1/workspaces/${VASTU}/options/lost_reason`, {
  token: admin, method: 'PUT', body: { options: [...reasons.slice(0, 2).map((r) => ({ id: r.id, label: r.label })), { label: 'Price too high' }] },
});
const newReasons = (await call(`/api/v1/workspaces/${VASTU}/settings`, { token: admin })).body.lostReasons.map((r) => r.label);
check('lost reasons can be edited (removed ones are archived, not deleted)', saveReasons.status === 200 && newReasons.length === 3 && newReasons.includes('Price too high'), newReasons);

// ── Pipelines ──
const renewals = await call(`/api/v1/workspaces/${LOGO}/pipelines`, { token: admin, method: 'POST', body: { name: 'Renewals', stages: ['Due', 'Contacted', 'Renewed', 'Lost'] } });
check('admin adds a second pipeline to a business line', renewals.status === 201);
const logoSales = (await call(`/api/v1/workspaces/${LOGO}/settings`, { token: admin })).body.pipelines.find((p) => p.name === 'Sales');
const delUsed = await call(`/api/v1/pipelines/${logoSales.id}`, { token: admin, method: 'DELETE' });
const delNew = await call(`/api/v1/pipelines/${renewals.body.id}`, { token: admin, method: 'DELETE' });
check('pipelines with leads cannot be deleted; empty ones can', delUsed.status === 409 && delNew.status === 200, [delUsed.body, delNew.status]);

// ── Workspace-level management ──
const roles = Object.fromEntries((await call('/api/v1/roles', { token: admin })).body.map((r) => [r.name, r.id]));
const head = await call('/api/v1/roles', { token: admin, method: 'POST', body: { name: 'Business Line Head', grants: [{ key: 'org.workspace.view', scope: 'WORKSPACE' }, { key: 'org.workspace.manage', scope: 'WORKSPACE' }] } });
const users = (await call('/api/v1/users', { token: admin })).body;
const nehaId = users.find((u) => u.email === 'manager@mycompany.local').id;
await call(`/api/v1/users/${nehaId}/roles`, {
  token: admin, method: 'PUT',
  body: { roles: [{ roleId: roles.Manager, workspaceId: VASTU }, { roleId: head.body.id, workspaceId: VASTU }, { roleId: roles.RM, workspaceId: LOGO }] },
});
const neha = await login('manager@mycompany.local');
const nehaVastu = await call(`/api/v1/workspaces/${VASTU}/fields`, { token: neha, workspace: VASTU, method: 'POST', body: { label: 'Plot size (sq ft)', type: 'number' } });
const nehaLogo = await call(`/api/v1/workspaces/${LOGO}/fields`, { token: neha, workspace: LOGO, method: 'POST', body: { label: 'Colour', type: 'text' } });
const nehaRename = await call(`/api/v1/workspaces/${VASTU}`, { token: neha, workspace: VASTU, method: 'PATCH', body: { name: 'Vastu' } });
check('a business-line head manages only their own workspace settings', nehaVastu.status === 201 && nehaLogo.status === 403 && nehaRename.status === 403, [nehaVastu.status, nehaLogo.status, nehaRename.status]);

// ── Other organization & archiving ──
const abc = await login('admin@abc.local', 'abc');
const foreign = await call(`/api/v1/workspaces/${VASTU}/settings`, { tenant: 'abc', token: abc });
check("another organization cannot see this business line's settings", foreign.status === 403, foreign.status);
const abcWs = (await call('/api/v1/auth/me', { tenant: 'abc', token: abc })).body.workspaces;
const arch = await call(`/api/v1/workspaces/${abcWs[1].id}`, { tenant: 'abc', token: abc, method: 'PATCH', body: { isArchived: true } });
const archLast = await call(`/api/v1/workspaces/${abcWs[0].id}`, { tenant: 'abc', token: abc, method: 'PATCH', body: { isArchived: true } });
check('a workspace can be archived, but never the last one', arch.status === 200 && archLast.status === 403 && archLast.body.code === 'LAST_WORKSPACE', [arch.status, archLast.body]);
await call(`/api/v1/workspaces/${abcWs[1].id}`, { tenant: 'abc', token: abc, method: 'PATCH', body: { isArchived: false } });

const logs = (await call('/api/v1/audit-logs', { token: admin })).body.map((l) => l.action);
check('settings changes are audited', ['field.created', 'pipeline.stages_changed', 'workspace.lost_reasons_changed', 'pipeline.created'].every((a) => logs.includes(a)), [...new Set(logs)].slice(0, 15));
const chain = (await call('/api/v1/audit-logs/verify', { token: admin })).body;
check('audit chain still verifies', chain.valid === true, chain);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
