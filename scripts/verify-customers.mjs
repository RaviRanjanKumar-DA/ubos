// End-to-end checks for Phase 1.4: Customer Master — matching, duplicates, merge/undo, Customer 360°, PAN.
// Usage: npm run verify:customers   (API running, freshly seeded; run `npm run db:seed` afterwards to reset)

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const PAN = 'ABCPV1234K'; // dummy test PAN
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
const all = (await call('/api/v1/customers', { token: admin })).body;
const byCode = Object.fromEntries(all.map((c) => [c.code, c]));
const priya = byCode.C00002;
const varma = byCode.C00009;
const rohit = byCode.C00001;

// ── Duplicates ──
const dups = await call('/api/v1/customers/duplicates', { token: admin });
const priyaPair = dups.body.find?.((p) => [p.a, p.b].includes(priya.id) && [p.a, p.b].includes(varma.id));
const rohitPair = dups.body.find?.((p) => [p.a, p.b].includes(rohit.id));
check('same email is flagged as an exact duplicate', priyaPair?.confidence === 'exact' && priyaPair.reasons.includes('Same email'), priyaPair);
check('similar names are flagged as possible duplicates', rohitPair?.confidence === 'possible', rohitPair);
const rm = await login('arjun');
const rmDup = await call('/api/v1/customers/duplicates', { token: rm, workspace: VASTU });
check('RM cannot review or merge duplicates', rmDup.status === 403);

// ── Listing & visibility ──
check('admin sees all customers, including those without leads yet', all.length >= 9 && !!varma, all.length);
const rmList = await call('/api/v1/customers', { token: rm, workspace: VASTU });
check('RM sees only customers of their own leads', rmList.status === 200 && rmList.body.length === 2 && rmList.body.every((c) => ['Meera Joshi', 'Vikram Rao'].includes(c.name)), rmList.body.map?.((c) => c.name));
const rmPriya = await call(`/api/v1/customers/${priya.id}`, { token: rm, workspace: VASTU });
check('RM cannot open a customer they have no lead for', rmPriya.status === 404);
const search = await call('/api/v1/customers?q=98765%2000002', { token: admin });
check('search finds a customer by mobile number', search.body.some?.((c) => c.id === priya.id), search.body.map?.((c) => c.code));

// ── Customer 360 ──
const c360 = await call(`/api/v1/customers/${priya.id}`, { token: admin });
check('Customer 360 shows leads from every business line', c360.status === 200 && new Set(c360.body.leads.map((l) => l.workspace)).size === 2, c360.body.leads?.map((l) => l.workspace));
check('…with an activity timeline', c360.body.timeline.some((e) => e.action === 'lead.created'));

// ── Edit & PAN ──
const badPan = await call(`/api/v1/customers/${priya.id}`, { token: admin, method: 'PATCH', body: { pan: 'ABC123' } });
check('invalid PAN format is refused', badPan.status === 400);
const setPan = await call(`/api/v1/customers/${priya.id}`, { token: admin, method: 'PATCH', body: { pan: PAN.toLowerCase(), city: 'New Delhi' } });
const afterPan = await call(`/api/v1/customers/${priya.id}`, { token: admin });
check('PAN is saved but only shown masked', setPan.status === 200 && afterPan.body.pan === '••••••234K' && !JSON.stringify(afterPan.body).includes(PAN), afterPan.body.pan);
const panClash = await call(`/api/v1/customers/${rohit.id}`, { token: admin, method: 'PATCH', body: { pan: PAN } });
check('the same PAN cannot be put on a second customer', panClash.status === 409 && panClash.body.code === 'PAN_BELONGS_TO_OTHER', panClash.body);
const altClash = await call(`/api/v1/customers/${rohit.id}`, { token: admin, method: 'PATCH', body: { alternateMobiles: ['98765 00003'] } });
check("a number already on another customer cannot be added", altClash.status === 409 && altClash.body.code === 'MOBILE_BELONGS_TO_OTHER', altClash.body);

// ── Matching when new leads arrive ──
const byEmail = await call('/api/v1/leads', {
  token: admin, workspace: VASTU, method: 'POST',
  body: { name: 'Priya V', mobile: '9811122233', email: 'PRIYA.VERMA@example.com', source: 'website', customFields: { property_type: 'Home' } },
});
check('a new lead with the same email links to the existing customer', byEmail.body.existingCustomer === true && byEmail.body.matchedBy === 'email' && byEmail.body.customerId === priya.id, byEmail.body);
const p2 = await call(`/api/v1/customers/${priya.id}`, { token: admin });
check('…and the new number is kept as an alternate mobile', p2.body.alternateMobiles.includes('+919811122233'), p2.body.alternateMobiles);
const byAlt = await call('/api/v1/leads', {
  token: admin, workspace: VASTU, method: 'POST', body: { name: 'Someone', mobile: '+91 98111 22233', source: 'whatsapp', customFields: { property_type: 'Shop' } },
});
check('a lead from that alternate number also links to the same customer', byAlt.body.customerId === priya.id && byAlt.body.matchedBy === 'mobile', byAlt.body);

// ── Merge & undo ──
const manager = await login('manager@mycompany.local');
const mgrMerge = await call('/api/v1/customers/merge', { token: manager, workspace: VASTU, method: 'POST', body: { primaryId: priya.id, duplicateId: varma.id } });
check('a manager without merge rights cannot merge', mgrMerge.status === 403);
const merged = await call('/api/v1/customers/merge', { token: admin, method: 'POST', body: { primaryId: priya.id, duplicateId: varma.id, reason: 'Same person, two numbers' } });
check('admin merges the duplicate into the main record', merged.status === 200 && !!merged.body.mergeId, merged.body);
const p3 = await call(`/api/v1/customers/${priya.id}`, { token: admin });
check("the duplicate's number becomes an alternate mobile", p3.body.alternateMobiles.includes('+919876500099') && p3.body.merges.length === 1, p3.body.alternateMobiles);
const gone = await call(`/api/v1/customers/${varma.id}`, { token: admin });
check('the merged record points to the main record', gone.status === 409 && gone.body.code === 'CUSTOMER_MERGED' && gone.body.details?.mergedIntoId === priya.id, gone.body);
const listAfter = (await call('/api/v1/customers', { token: admin })).body;
const dupAfter = (await call('/api/v1/customers/duplicates', { token: admin })).body;
check('merged records leave the list and the duplicate suggestions', !listAfter.some((c) => c.id === varma.id) && !dupAfter.some((p) => [p.a, p.b].includes(varma.id)));
const viaOld = await call('/api/v1/leads', { token: admin, workspace: VASTU, method: 'POST', body: { name: 'Priya Varma', mobile: '9876500099', source: 'referral', customFields: { property_type: 'Plot' } } });
check("a new lead from the duplicate's old number goes to the main record", viaOld.body.customerId === priya.id, viaOld.body);
const again = await call('/api/v1/customers/merge', { token: admin, method: 'POST', body: { primaryId: priya.id, duplicateId: varma.id } });
check('a record cannot be merged twice', again.status === 409);

const undo = await call(`/api/v1/customers/merges/${merged.body.mergeId}/undo`, { token: admin, method: 'POST' });
const back = await call(`/api/v1/customers/${varma.id}`, { token: admin });
const p4 = await call(`/api/v1/customers/${priya.id}`, { token: admin });
check('undo brings the duplicate back and removes its number from the main record', undo.status === 200 && back.status === 200 && !p4.body.alternateMobiles.includes('+919876500099'), [undo.body, p4.body.alternateMobiles]);
const undoTwice = await call(`/api/v1/customers/merges/${merged.body.mergeId}/undo`, { token: admin, method: 'POST' });
check('a merge cannot be undone twice', undoTwice.status === 409);

// ── Not a duplicate ──
const dismiss = await call('/api/v1/customers/duplicates/dismiss', { token: admin, method: 'POST', body: { aId: rohit.id, bId: rohitPair.a === rohit.id ? rohitPair.b : rohitPair.a } });
const dupFinal = (await call('/api/v1/customers/duplicates', { token: admin })).body;
check('"not a duplicate" hides the pair from suggestions', dismiss.status === 200 && !dupFinal.some((p) => [p.a, p.b].includes(rohit.id)));

// ── Isolation & audit ──
const abc = await login('admin@abc.local', 'abc');
const foreign = await call(`/api/v1/customers/${priya.id}`, { tenant: 'abc', token: abc });
const foreignMerge = await call('/api/v1/customers/merge', { tenant: 'abc', token: abc, method: 'POST', body: { primaryId: priya.id, duplicateId: rohit.id } });
check("another organization can neither see nor merge our customers", foreign.status === 404 && foreignMerge.status === 404, [foreign.status, foreignMerge.status]);
const logs = (await call('/api/v1/audit-logs', { token: admin })).body;
const actions = new Set(logs.map((l) => l.action));
check('customer changes are audited', ['customer.updated', 'customer.merged', 'customer.merge_undone', 'customer.not_duplicate'].every((a) => actions.has(a)), [...actions]);
check('the full PAN never appears in the audit log', !JSON.stringify(logs).includes(PAN) && !JSON.stringify(logs).toLowerCase().includes(PAN.toLowerCase()));
const chain = (await call('/api/v1/audit-logs/verify', { token: admin })).body;
check('audit chain still verifies', chain.valid === true, chain);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
