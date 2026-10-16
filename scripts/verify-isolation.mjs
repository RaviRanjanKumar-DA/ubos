// End-to-end checks for the Phase 0 core against a running API seeded with `npm run db:seed`.
// Usage: npm run verify:isolation   (API_URL defaults to http://localhost:4000)
// Note: creates a few records (workspaces, a lead) and toggles one tenant's status; re-seed to reset.

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;

async function call(path, { tenant, token, workspace, method = 'GET', body } = {}) {
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

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  if (!cond) failures++;
}

const login = async (tenant, email) => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { email, password: PASSWORD } })).body.accessToken;

const health = await call('/health');
check('health endpoint', health.status === 200 && health.body.status === 'ok', health);

// ── Tenant isolation ──
const adminA = await login('mycompany', 'admin@mycompany.local');
const adminB = await login('abc', 'admin@abc.local');
check('both organization admins can log in', !!adminA && !!adminB);

const crossToken = await call('/api/v1/leads', { tenant: 'abc', token: adminA });
check('token of one organization is rejected by another', crossToken.status === 401 && crossToken.body.code === 'TOKEN_TENANT_MISMATCH', crossToken);

const leadsA = await call('/api/v1/leads', { tenant: 'mycompany', token: adminA });
const leadsB = await call('/api/v1/leads', { tenant: 'abc', token: adminB });
const idsA = new Set(leadsA.body.map((l) => l.id));
check('each organization sees only its own leads', leadsA.status === 200 && leadsB.status === 200 && leadsB.body.every((l) => !idsA.has(l.id)),
  { a: leadsA.body.length, b: leadsB.body.length });
check('ABC admin never sees My Company workspaces', leadsB.body.every((l) => ['Education', 'Real Estate'].includes(l.workspace)));

const wrongLogin = await call('/api/v1/auth/login', { tenant: 'abc', method: 'POST', body: { email: 'admin@mycompany.local', password: PASSWORD } });
check('a user cannot log in to a different organization', wrongLogin.status === 401, wrongLogin);

// ── Workspaces & multi-role scopes ──
const me = await call('/api/v1/auth/me', { tenant: 'mycompany', token: adminA });
const ws = Object.fromEntries(me.body.workspaces.map((w) => [w.name, w.id]));
check('Tenant #1 has three business-line workspaces', me.body.workspaces.length >= 3, me.body.workspaces);

const rm = await login('mycompany', 'rm@mycompany.local');
const rmVastu = await call('/api/v1/leads', { tenant: 'mycompany', token: rm, workspace: ws['Vastu Consultation / Audit'] });
check('RM sees only own leads in Vastu', rmVastu.status === 200 && rmVastu.body.every((l) => l.owner === 'Arjun (RM)') && rmVastu.body.length === 2, rmVastu.body);
const rmLogo = await call('/api/v1/leads', { tenant: 'mycompany', token: rm, workspace: ws['Logo Designing'] });
check('RM cannot enter a workspace without a role there', rmLogo.status === 403 && rmLogo.body.code === 'WORKSPACE_FORBIDDEN', rmLogo);
const rmExport = await call('/api/v1/leads/export', { tenant: 'mycompany', token: rm, workspace: ws['Vastu Consultation / Audit'] });
check('RM has no CSV export permission', rmExport.status === 403, rmExport.status);

const neha = await login('mycompany', 'manager@mycompany.local');
const nehaVastu = await call('/api/v1/leads', { tenant: 'mycompany', token: neha, workspace: ws['Vastu Consultation / Audit'] });
check('Multi-role: Manager scope in Vastu sees the whole workspace', nehaVastu.status === 200 && nehaVastu.body.length >= 3, nehaVastu.body.length);
const nehaLogo = await call('/api/v1/leads', { tenant: 'mycompany', token: neha, workspace: ws['Logo Designing'] });
check('Multi-role: RM scope in Logo sees only own leads', nehaLogo.status === 200 && nehaLogo.body.every((l) => l.owner === 'Neha (Manager)'), nehaLogo.body);
const nehaCourse = await call('/api/v1/leads', { tenant: 'mycompany', token: neha, workspace: ws['Course / Software'] });
check('Multi-role: no access to a third workspace', nehaCourse.status === 403, nehaCourse.status);

const auditor = await login('mycompany', 'auditor@mycompany.local');
const audCreate = await call('/api/v1/leads', { tenant: 'mycompany', token: auditor, workspace: ws['Logo Designing'], method: 'POST', body: { name: 'Test', mobile: '9000000000' } });
check('Auditor explicit deny blocks creating leads', audCreate.status === 403 && audCreate.body.code === 'PERMISSION_DENIED', audCreate);
const audExport = await call('/api/v1/leads/export', { tenant: 'mycompany', token: auditor });
check('Auditor can export CSV organization-wide', audExport.status === 200 && String(audExport.body).includes('Customer ID'), audExport.status);

// ── Shared Customer Master across workspaces ──
const crossSell = await call('/api/v1/leads', {
  tenant: 'mycompany', token: adminA, workspace: ws['Vastu Consultation / Audit'], method: 'POST',
  body: { name: 'Priya Verma', mobile: '+91 98765 00002', source: 'cross_sell', customFields: { property_type: 'Home' } },
});
check('Same mobile in another workspace reuses the existing customer', crossSell.status === 201 && crossSell.body.existingCustomer === true, crossSell);

// ── Plan limits ──
let limitHit = null;
for (let i = 0; i < 3 && !limitHit; i++) {
  const r = await call('/api/v1/workspaces', { tenant: 'abc', token: adminB, method: 'POST', body: { name: `Extra Line ${Date.now()}-${i}` } });
  if (r.status === 403) limitHit = r;
}
check('Growth plan blocks a 4th workspace', limitHit?.body.code === 'PLAN_LIMIT_REACHED', limitHit);

// ── Integrations toggle ──
const act = await call('/api/v1/integrations/callerdesk/activate', { tenant: 'mycompany', token: adminA, method: 'POST' });
const list = await call('/api/v1/integrations', { tenant: 'mycompany', token: adminA });
check('Admin activates CallerDesk', act.status === 201 && list.body.find((i) => i.key === 'callerdesk')?.status === 'active', act);
const otherTenant = await call('/api/v1/integrations', { tenant: 'abc', token: adminB });
check('Activation does not leak to another organization', otherTenant.body.find((i) => i.key === 'callerdesk')?.status === 'inactive');
const rmToggle = await call('/api/v1/integrations/callerdesk/deactivate', { tenant: 'mycompany', token: rm, method: 'POST' });
check('RM cannot toggle integrations', rmToggle.status === 403, rmToggle.status);

// ── Platform Console ──
const owner = (await call('/platform/v1/auth/login', { method: 'POST', body: { email: 'owner@ubos.local', password: PASSWORD } })).body.accessToken;
const tenants = await call('/platform/v1/tenants', { token: owner });
check('Platform Owner lists all organizations', tenants.status === 200 && tenants.body.length >= 2, tenants.body.length);
const tenantOnPlatform = await call('/platform/v1/tenants', { token: adminA });
check('Tenant token cannot open the Platform Console', tenantOnPlatform.status === 401, tenantOnPlatform.status);
const abc = tenants.body.find((t) => t.slug === 'abc');
await call(`/platform/v1/tenants/${abc.id}/status`, { token: owner, method: 'PATCH', body: { status: 'suspended' } });
const suspended = await call('/api/v1/auth/login', { tenant: 'abc', method: 'POST', body: { email: 'admin@abc.local', password: PASSWORD } });
check('Suspended organization cannot log in', suspended.status === 403 && suspended.body.code === 'TENANT_SUSPENDED', suspended);
await call(`/platform/v1/tenants/${abc.id}/status`, { token: owner, method: 'PATCH', body: { status: 'active' } });
const back = await login('abc', 'admin@abc.local');
check('Reactivated organization can log in again', !!back);

// ── Audit trail ──
const verify = await call('/api/v1/audit-logs/verify', { tenant: 'mycompany', token: adminA });
check('Audit hash chain verifies', verify.body.valid === true, verify.body);
const logs = await call('/api/v1/audit-logs', { tenant: 'mycompany', token: adminA });
check('Audit log records integration activation', logs.body.some((l) => l.action === 'integration.activated'));
const rmAudit = await call('/api/v1/audit-logs', { tenant: 'mycompany', token: rm });
check('RM cannot read audit log', rmAudit.status === 403, rmAudit.status);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
