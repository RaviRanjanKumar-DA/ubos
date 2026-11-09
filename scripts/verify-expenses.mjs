// End-to-end checks for slice 3.4: expenses, categories, profit and loss by month, business line and basis, access.
// Usage: npm run verify:expenses   (API running, freshly seeded; run `npm run db:seed` afterwards).

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
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const WS = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = WS['Vastu Consultation / Audit'], COURSE = WS['Course / Software'];
const users = (await call('/api/v1/users', { token: admin })).body;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local').id;
const post = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'POST', body: body ?? {} });
const put = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'PUT', body });
const get = (p, token, workspace = VASTU) => call(p, { token, workspace });
const stamp = Date.now();

const cats = (await get('/api/v1/expense-categories', manager)).body;
check('common categories are there to start with', cats.some((c) => c.name === 'Rent') && cats.length >= 8, cats.length);
const rent = cats.find((c) => c.name === 'Rent').id, ads = cats.find((c) => c.name === 'Marketing and ads').id;
check('a salesperson cannot see expenses', (await get('/api/v1/expense-categories', rm)).status === 403);
check('a duplicate category is refused', (await post('/api/v1/expense-categories', manager, { name: 'rent' })).body.code === 'DUPLICATE');
const nc = await post('/api/v1/expense-categories', manager, { name: `Courier ${stamp}` });
check('a category can be added', nc.status === 201, nc.body);
check('and archived', (await call(`/api/v1/expense-categories/${nc.body.id}`, { token: manager, workspace: VASTU, method: 'PATCH', body: { isArchived: true } })).body.isArchived === true);
const exp = (b, token = manager, w = VASTU) => post('/api/v1/expenses', token, { categoryId: rent, spentOn: '2026-06-15', amountPaise: 1_180_000, gstPaise: 180_000, description: 'Office rent', ...b }, w);
check('GST cannot exceed the amount', (await exp({ gstPaise: 9_999_999 })).status === 400);
check('an archived category is refused', (await exp({ categoryId: nc.body.id })).body.code === 'CATEGORY_NOT_FOUND');
check('a manager cannot record organization-wide costs', (await exp({ orgWide: true })).status === 403);
const e1 = await exp({ vendor: 'Landlord' });
check('an expense is recorded', e1.status === 201, e1.body);
const e2 = (await exp({ categoryId: ads, spentOn: '2026-07-10', amountPaise: 500_000, gstPaise: 0, description: 'Facebook ads' })).body;
await exp({ categoryId: ads, spentOn: '2026-07-11', amountPaise: 300_000, gstPaise: 0, description: 'Course ads' }, admin, COURSE);
const org = await post('/api/v1/expenses', admin, { categoryId: rent, spentOn: '2026-07-20', amountPaise: 200_000, description: 'Head office', orgWide: true }, null);
check('an admin records organization-wide costs', org.status === 201 && org.body.workspaceId === null, org.body);
const list = (qs, token = manager, w = VASTU) => get(`/api/v1/expenses?from=2026-06-01&to=2026-07-31${qs}`, token, w);
let l = (await list('')).body;
check('a business line sees only its own expenses', l.rows.length === 2 && l.totalPaise === 1_680_000 && l.gstPaise === 180_000, l.totalPaise);
check('a category filter works', (await list(`&categoryId=${ads}`)).body.rows.length === 1);
check('search works', (await list('&q=landlord')).body.rows.length === 1);
const allAdmin = (await call('/api/v1/expenses?from=2026-06-01&to=2026-07-31', { token: admin })).body;
check('an admin with all business lines sees everything', allAdmin.rows.length === 4, allAdmin.rows?.length);
check('a start date after the end date is refused', (await get('/api/v1/expenses?from=2026-07-01&to=2026-06-01', manager)).body.code === 'INVALID_RANGE');
check('dates count on the IST day', (await get('/api/v1/expenses?from=2026-06-15&to=2026-06-15', manager)).body.rows.length === 1);
const edited = await put(`/api/v1/expenses/${e2.id}`, manager, { categoryId: ads, spentOn: '2026-07-10', amountPaise: 600_000, gstPaise: 0, description: 'Facebook ads' });
check('an expense can be corrected', edited.body.amountPaise === 600_000, edited.body);
const other = await put(`/api/v1/expenses/${e2.id}`, await login('rm2@mycompany.local'), { categoryId: ads, spentOn: '2026-07-10', amountPaise: 1, description: 'no way' });
check('someone else cannot change it', other.status === 403 || other.status === 404, other.status);
const csv = String((await get('/api/v1/expenses.csv?from=2026-06-01&to=2026-07-31', manager)).body).split('\n');
check('expenses can be downloaded', csv.length === 3 && csv[0].startsWith('Date (IST),Category'), csv.length);

// Income
await put('/api/v1/billing-profile', manager, { legalName: 'Batraa Vastu Pvt Ltd', gstin: '27AAPFU0939F1ZV', stateCode: '27', address: '12 MG Road, Pune', invoicePrefix: 'VA' });
const lead = (await post('/api/v1/leads', manager, { name: `Pnl Lead ${stamp}`, mobile: `9${String(stamp).slice(-9)}`, customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const leadId = lead.id ?? lead.lead?.id;
const d = (await post('/api/v1/invoices', manager, { leadId, items: [{ description: 'Audit', qty: 1, unitPaise: 2_000_000, gstBp: 1800 }], placeOfSupply: '27' })).body;
const inv = (await post(`/api/v1/invoices/${d.id}/issue`, manager)).body;
await post(`/api/v1/invoices/${inv.id}/payments`, manager, { amountPaise: 1_000_000 });
const d2 = (await post('/api/v1/invoices', manager, { leadId, items: [{ description: 'Wrong', qty: 1, unitPaise: 5_000_000, gstBp: 1800 }], placeOfSupply: '27' })).body;
await post(`/api/v1/invoices/${d2.id}/issue`, manager);
await post(`/api/v1/invoices/${d2.id}/cancel`, manager, { reason: 'typed wrongly' });
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const pnl = (qs, token = manager, w = VASTU) => get(`/api/v1/pnl?from=2026-04-01&to=${today}${qs}`, token, w);
let p = (await pnl('')).body;
check('income is invoices before GST, leaving out cancelled ones', p.incomePaise === 2_000_000, p.incomePaise);
check('expenses are before claimable GST', p.expensePaise === 1_000_000 + 600_000, p.expensePaise);
check('profit is income less expenses', p.profitPaise === 400_000 && p.marginPct === 20, [p.profitPaise, p.marginPct]);
check('months are in order', p.months[0].month === '2026-06' && p.months[0].expensePaise === 1_000_000 && p.months[0].profitPaise === -1_000_000, p.months);
check('categories are ranked', p.categories[0].name === 'Rent' && p.categories[0].paise === 1_000_000, p.categories);
p = (await pnl('&basis=received')).body;
check('income can be counted as money received', p.basis === 'received' && p.incomePaise === 1_000_000, p.incomePaise);
const whole = (await call(`/api/v1/pnl?from=2026-04-01&to=${today}`, { token: admin })).body;
check('the organization view includes every line and head office', whole.expensePaise === 1_000_000 + 600_000 + 300_000 + 200_000 && whole.businessLines.some((x) => x.id === null), whole.expensePaise);
check('it shows profit per business line', whole.businessLines.find((x) => x.id === VASTU).profitPaise === 400_000, whole.businessLines);
check('a business line view leaves out head office costs', !(await pnl('')).body.businessLines.some((x) => x.id === null));
check('a salesperson cannot see profit and loss', (await pnl('', rm)).status === 403);
check('an auditor can', (await call(`/api/v1/pnl?from=2026-04-01&to=${today}`, { token: auditor })).status === 200);
const pc = String((await get(`/api/v1/pnl.csv?from=2026-04-01&to=${today}`, manager)).body).split('\n');
check('profit and loss can be downloaded', pc[0] === 'Month,Income,Expenses,Profit' && pc.at(-1) === 'Total,20000.00,16000.00,4000.00', pc.at(-1));

// Void
check('a reason is needed to void', (await post(`/api/v1/expenses/${e2.id}/void`, manager, { reason: '' })).status === 400);
check('an expense can be voided', (await post(`/api/v1/expenses/${e2.id}/void`, manager, { reason: 'duplicate entry' })).status === 200);
check('it stays on the list, marked', (await list('')).body.rows.find((r) => r.id === e2.id).voidReason === 'duplicate entry');
check('it drops out of the totals', (await list('')).body.totalPaise === 1_180_000);
check('and out of profit and loss', (await pnl('')).body.expensePaise === 1_000_000);
check('a voided expense cannot be changed', (await put(`/api/v1/expenses/${e2.id}`, manager, { categoryId: ads, spentOn: '2026-07-10', amountPaise: 1000, description: 'again' })).body.code === 'VOIDED');
check('it cannot be voided twice', (await post(`/api/v1/expenses/${e2.id}/void`, manager, { reason: 'duplicate entry' })).body.code === 'ALREADY_VOIDED');
check('a plan without Finance cannot open expenses', (await call('/api/v1/expense-categories', { tenant: 'abc', token: abc })).status === 403);
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('changes are audited', audit.includes('expense.recorded') && audit.includes('expense.voided') && audit.includes('expense.updated'));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
