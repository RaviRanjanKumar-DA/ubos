// End-to-end checks for Phase 1.2: users, multi-role assignment, custom roles, org structure, licences.
// Usage: npm run verify:users   (API running, freshly seeded; run `npm run db:seed` afterwards to reset)

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
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
const login = async (identifier, password = PASSWORD, tenant = 'mycompany') =>
  (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password } })).body;

const admin = (await login('admin@mycompany.local')).accessToken;
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const roles = Object.fromEntries((await call('/api/v1/roles', { token: admin })).body.map((r) => [r.name, r.id]));

// ── Listing & visibility ──
const all = await call('/api/v1/users', { token: admin });
check('admin lists all users with their roles per workspace', all.status === 200 && all.body.length >= 5 && all.body.some((u) => u.roles.some((r) => r.workspace === 'Logo Designing')), all.body.length);
const neha = (await login('manager@mycompany.local')).accessToken;
const nehaList = await call('/api/v1/users', { token: neha, workspace: ws['Vastu Consultation / Audit'] });
check('workspace manager sees only people of their workspace', nehaList.status === 200 && nehaList.body.every((u) => u.roles.some((r) => r.workspace === 'Vastu Consultation / Audit')) && nehaList.body.length === 2, nehaList.body.map?.((u) => u.name));
const rm = (await login('arjun')).accessToken;
const rmList = await call('/api/v1/users', { token: rm, workspace: ws['Vastu Consultation / Audit'] });
check('RM cannot list users', rmList.status === 403);
const cat = await call('/api/v1/permissions', { token: admin });
check('permission catalogue is grouped for the role editor', cat.status === 200 && cat.body.groups.length >= 4 && cat.body.scopes.includes('WORKSPACE'));

// ── Custom role ──
const cc = await call('/api/v1/roles', {
  token: admin, method: 'POST',
  body: { name: 'Content Creator', grants: [
    { key: 'dashboard.view', scope: 'OWN' }, { key: 'crm.lead.view', scope: 'OWN' }, { key: 'crm.lead.create', scope: 'WORKSPACE' }, { key: 'org.workspace.view', scope: 'WORKSPACE' },
  ] },
});
check('admin creates a custom role (Content Creator)', cc.status === 201, cc.body);
const dupRole = await call('/api/v1/roles', { token: admin, method: 'POST', body: { name: 'content creator', grants: [] } });
check('role names are unique (case-insensitive)', dupRole.status === 409);
const editAdmin = await call(`/api/v1/roles/${roles['Organization Admin']}`, { token: admin, method: 'PUT', body: { name: 'Organization Admin', grants: [] } });
check('built-in Organization Admin role cannot be edited', editAdmin.status === 403 && editAdmin.body.code === 'ROLE_PROTECTED');

// ── Create user with multiple roles ──
await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
const created = await call('/api/v1/users', {
  token: admin, method: 'POST',
  body: {
    name: 'Pooja (Content)', email: 'pooja@mycompany.local', username: 'pooja', mobile: '98765 22222',
    roles: [{ roleId: cc.body.id, workspaceId: ws['Logo Designing'] }, { roleId: roles.RM, workspaceId: ws['Course / Software'] }],
  },
});
check('admin adds a user with two roles in two workspaces', created.status === 201 && !!created.body.temporaryPassword && created.body.inviteSent === true, created.body);
await new Promise((r) => setTimeout(r, 600));
const inbox = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
check('invitation email arrives (local inbox)', inbox.messages?.some((m) => m.To?.[0]?.Address === 'pooja@mycompany.local'));
const dupUser = await call('/api/v1/users', { token: admin, method: 'POST', body: { name: 'Test User', email: 'pooja@mycompany.local', roles: [{ roleId: roles.RM, workspaceId: null }] } });
const dupName = await call('/api/v1/users', { token: admin, method: 'POST', body: { name: 'Test User', email: 'x@mycompany.local', username: 'arjun', roles: [{ roleId: roles.RM, workspaceId: null }] } });
check('duplicate email / username are refused', dupUser.body.code === 'EMAIL_TAKEN' && dupName.body.code === 'USERNAME_TAKEN', [dupUser.body, dupName.body]);

const p1 = await login('pooja', created.body.temporaryPassword);
check('new user must change the temporary password', p1.mustChangePassword === true);
await call('/api/v1/auth/password', { token: p1.accessToken, method: 'POST', body: { currentPassword: created.body.temporaryPassword, newPassword: 'PoojaPass2026' } });
const pooja = (await login('pooja', 'PoojaPass2026')).accessToken;
const pLogo = await call('/api/v1/leads', { token: pooja, workspace: ws['Logo Designing'], method: 'POST', body: { name: 'Bright Studio', mobile: '9000011111', source: 'facebook' } });
const pCourse = await call('/api/v1/leads', { token: pooja, workspace: ws['Course / Software'], method: 'POST', body: { name: 'Course Lead', mobile: '9000011112', customFields: { course: 'Numerology Basic' } } });
const pVastu = await call('/api/v1/leads', { token: pooja, workspace: ws['Vastu Consultation / Audit'] });
check('custom role works in Logo, RM role in Course, no access to Vastu', pLogo.status === 201 && pCourse.status === 201 && pVastu.status === 403, [pLogo.status, pCourse.status, pVastu.status]);

// ── Anti-escalation ──
const mgrCreate = await call('/api/v1/users', { token: neha, workspace: ws['Vastu Consultation / Audit'], method: 'POST', body: { name: 'Y', email: 'y@mycompany.local', roles: [{ roleId: roles.RM, workspaceId: null }] } });
check('a manager without user-management rights cannot add users', mgrCreate.status === 403);
const la = await call('/api/v1/roles', {
  token: admin, method: 'POST',
  body: { name: 'User Manager', grants: [{ key: 'org.user.view', scope: 'ORGANIZATION' }, { key: 'org.user.manage', scope: 'ORGANIZATION' }, { key: 'org.role.manage', scope: 'ORGANIZATION' }] },
});
const poojaId = created.body.id;
await call(`/api/v1/users/${poojaId}/roles`, {
  token: admin, method: 'PUT',
  body: { roles: [{ roleId: cc.body.id, workspaceId: ws['Logo Designing'] }, { roleId: roles.RM, workspaceId: ws['Course / Software'] }, { roleId: la.body.id, workspaceId: null }] },
});
const selfAdmin = await call(`/api/v1/users/${poojaId}/roles`, { token: pooja, method: 'PUT', body: { roles: [{ roleId: roles['Organization Admin'], workspaceId: null }] } });
check('a user manager cannot make themselves Organization Admin', selfAdmin.status === 403 && selfAdmin.body.code === 'ESCALATION_BLOCKED', selfAdmin.body);
const sneaky = await call('/api/v1/roles', { token: pooja, method: 'POST', body: { name: 'Sneaky', grants: [{ key: 'audit.view', scope: 'ORGANIZATION' }] } });
check('…nor create a role with permissions they do not have', sneaky.status === 403 && sneaky.body.code === 'ESCALATION_BLOCKED', sneaky.body);

// ── Last admin protection ──
const adminId = me.user.id;
const dropAdmin = await call(`/api/v1/users/${adminId}/roles`, { token: admin, method: 'PUT', body: { roles: [{ roleId: roles.RM, workspaceId: ws['Course / Software'] }] } });
check('the last Organization Admin cannot lose the role', dropAdmin.status === 403 && dropAdmin.body.code === 'LAST_ADMIN', dropAdmin.body);
const stillAdmin = await call('/api/v1/users', { token: admin });
check('…and the failed change was fully rolled back', stillAdmin.status === 200);
const selfOff = await call(`/api/v1/users/${adminId}`, { token: admin, method: 'PATCH', body: { isActive: false } });
check('admin cannot deactivate their own account', selfOff.body.code === 'CANNOT_DEACTIVATE_SELF');
const inUse = await call(`/api/v1/roles/${cc.body.id}`, { token: admin, method: 'DELETE' });
check('a role in use cannot be deleted', inUse.status === 409 && inUse.body.code === 'ROLE_IN_USE');

// ── Org structure ──
const br = await call('/api/v1/org/branches', { token: admin, method: 'POST', body: { name: 'Delhi Office' } });
const dp = await call('/api/v1/org/departments', { token: admin, method: 'POST', body: { name: 'Design', branchId: br.body.id } });
const tm = await call('/api/v1/org/teams', { token: admin, method: 'POST', body: { name: 'Logo Team', departmentId: dp.body.id, workspaceId: ws['Logo Designing'] } });
check('admin builds Branch → Department → Team (linked to a workspace)', br.status === 201 && dp.status === 201 && tm.status === 201, [br.body, dp.body, tm.body]);
const move = await call(`/api/v1/users/${poojaId}`, { token: admin, method: 'PATCH', body: { teamId: tm.body.id } });
const structure = await call('/api/v1/org/structure', { token: admin });
const logoTeam = structure.body.branches?.find((b) => b.name === 'Delhi Office')?.departments[0]?.teams[0];
check('user moved into the team; structure shows member count', move.status === 200 && logoTeam?.members === 1, logoTeam);
const delTeam = await call(`/api/v1/org/teams/${tm.body.id}`, { token: admin, method: 'DELETE' });
const delBranch = await call(`/api/v1/org/branches/${br.body.id}`, { token: admin, method: 'DELETE' });
check('non-empty team / branch cannot be deleted', delTeam.status === 409 && delBranch.status === 409);
const nehaId = all.body.find((u) => u.email === 'manager@mycompany.local').id;
await call(`/api/v1/users/${poojaId}`, { token: admin, method: 'PATCH', body: { reportsToId: nehaId } });
const loop = await call(`/api/v1/users/${nehaId}`, { token: admin, method: 'PATCH', body: { reportsToId: poojaId } });
check('reporting loops are refused (A → B → A)', loop.status === 400 && loop.body.code === 'INVALID_MANAGER', loop.body);
const rmOrg = await call('/api/v1/org/branches', { token: rm, method: 'POST', body: { name: 'X' } });
check('RM cannot change the org structure', rmOrg.status === 403);

// ── Deactivation ──
const off = await call(`/api/v1/users/${poojaId}`, { token: admin, method: 'PATCH', body: { isActive: false } });
const afterOff = await call('/api/v1/auth/me', { token: pooja });
const reLogin = await call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'pooja', password: 'PoojaPass2026' } });
check('deactivating a user ends their sessions and blocks sign-in', off.status === 200 && afterOff.status === 401 && reLogin.status === 401, [afterOff.body, reLogin.body]);

// ── Licences (SaaS) & cross-tenant ──
const abc = (await login('admin@abc.local', PASSWORD, 'abc')).accessToken;
const abcRoles = Object.fromEntries((await call('/api/v1/roles', { tenant: 'abc', token: abc })).body.map((r) => [r.name, r.id]));
let limit = null;
for (let i = 1; i <= 6 && !limit; i++) {
  const r = await call('/api/v1/users', { tenant: 'abc', token: abc, method: 'POST', body: { name: `ABC User ${i}`, email: `user${i}@abc.local`, sendInvite: false, roles: [{ roleId: abcRoles.RM, workspaceId: null }] } });
  if (r.status === 403) limit = r;
}
check('trial plan stops at its 5 user licences', limit?.body.code === 'LICENCE_LIMIT_REACHED', limit?.body);
const foreign = await call(`/api/v1/users/${poojaId}/roles`, { tenant: 'abc', token: abc, method: 'PUT', body: { roles: [] } });
check('another organization cannot touch our users', foreign.status === 404, foreign.status);
const abcUsers = (await call('/api/v1/users', { tenant: 'abc', token: abc })).body;
const foreignRole = await call(`/api/v1/users/${abcUsers[0].id}/roles`, { tenant: 'abc', token: abc, method: 'PUT', body: { roles: [{ roleId: roles['Organization Admin'], workspaceId: null }] } });
check('…nor assign our roles to their users', foreignRole.status === 400 && foreignRole.body.code === 'ROLE_NOT_FOUND', foreignRole.body);

// ── Audit ──
const logs = (await call('/api/v1/audit-logs', { token: admin })).body;
const actions = new Set(logs.map((l) => l.action));
check('user, role and org changes are audited', ['user.created', 'user.roles_changed', 'user.deactivated', 'role.created', 'org.team_created'].every((a) => actions.has(a)), [...actions]);
const chain = (await call('/api/v1/audit-logs/verify', { token: admin })).body;
check('audit chain still verifies', chain.valid === true, chain);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
