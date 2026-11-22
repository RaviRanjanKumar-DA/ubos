// End-to-end checks for slice 3.1: billing details, GST invoices, consecutive numbers, issuing and cancelling, payments, the sales register, access.
// Usage: npm run verify:invoices   (API running, freshly seeded; run `npm run db:seed` afterwards).

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
const VASTU = WS['Vastu Consultation / Audit'];
const users = (await call('/api/v1/users', { token: admin })).body;
const ARJUN = users.find((u) => u.email === 'rm@mycompany.local').id, NEHA = users.find((u) => u.email === 'manager@mycompany.local').id;
const post = (p, token, body) => call(p, { token, workspace: VASTU, method: 'POST', body: body ?? {} });
const put = (p, token, body) => call(p, { token, workspace: VASTU, method: 'PUT', body });
const get = (p, token) => call(p, { token, workspace: VASTU });
const stamp = Date.now();
let n = 0;
const mkLead = async (ownerId = NEHA, token = manager) => { const r = (await post('/api/v1/leads', token, { name: `Inv Lead ${++n} ${stamp}`, mobile: `9${String(stamp).slice(-7)}${String(n).padStart(2, '0')}`, customFields: { property_type: 'Home' }, ownerId })).body; return r.id ?? r.lead?.id; };
const line = { description: 'Vastu audit', hsnSac: '998399', qty: 2, unitPaise: 500_000, discountPaise: 100_000, gstBp: 1800 };
const MH = '27AAPFU0939F1ZV', KA = '29GGGGG1314R9ZA';
const fy = (() => { const [y, m] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number); const s = m >= 4 ? y : y - 1; return `${String(s).slice(2)}-${String(s + 1).slice(2)}`; })();

// Plan and access
check('a plan without Finance cannot open invoices', (await call('/api/v1/invoices', { tenant: 'abc', token: abc })).status === 403);
const lead1 = await mkLead();
check('an invoice needs billing details first', (await post('/api/v1/invoices', manager, { leadId: lead1, items: [line] })).body.code === 'NO_BILLING_PROFILE');
const profile = { legalName: 'Batraa Vastu Pvt Ltd', gstin: MH, stateCode: '27', address: '12 MG Road, Pune', invoicePrefix: 'VA' };
check('a salesperson cannot change billing details', (await put('/api/v1/billing-profile', rm, profile)).status === 403);
check('a wrong GSTIN is refused', (await put('/api/v1/billing-profile', manager, { ...profile, gstin: '27AAPFU0939F1ZA' })).status === 400);
check('a GSTIN from another state is refused', (await put('/api/v1/billing-profile', manager, { ...profile, stateCode: '29' })).status === 400);
check('a manager saves billing details', (await put('/api/v1/billing-profile', manager, profile)).status === 200);

// Drafts and tax
const d1 = (await post('/api/v1/invoices', manager, { leadId: lead1, items: [line], placeOfSupply: '27' })).body;
check('a draft has no number yet', d1.status === 'draft' && d1.number === null, d1);
check('inside the state: CGST and SGST', d1.taxablePaise === 900_000 && d1.cgstPaise === 81_000 && d1.sgstPaise === 81_000 && d1.igstPaise === 0 && d1.totalPaise === 1_062_000, d1);
const d2 = (await post('/api/v1/invoices', manager, { leadId: lead1, items: [line], customerGstin: KA })).body;
check('another state, from the customer GSTIN: IGST', d2.placeOfSupply === '29' && d2.igstPaise === 162_000 && d2.cgstPaise === 0, d2);
check('a wrong customer GSTIN is refused', (await post('/api/v1/invoices', manager, { leadId: lead1, items: [line], customerGstin: 'BAD' })).status === 400);
check('a discount above the amount is refused', (await post('/api/v1/invoices', manager, { leadId: lead1, items: [{ ...line, discountPaise: 99_999_999 }] })).status === 400);
check('an unknown GST rate is refused', (await post('/api/v1/invoices', manager, { leadId: lead1, items: [{ ...line, gstBp: 1700 }] })).status === 400);
check('a total is rounded to the rupee', (await post('/api/v1/invoices', manager, { leadId: lead1, items: [{ description: 'x', qty: 1, unitPaise: 33_333, gstBp: 1800 }], placeOfSupply: '27' })).body.totalPaise % 100 === 0);
const edited = await put(`/api/v1/invoices/${d1.id}`, manager, { items: [{ ...line, qty: 1, discountPaise: 0 }], placeOfSupply: '27', dueAt: new Date(Date.now() - 86_400_000).toISOString() });
check('a draft can be edited', edited.body.totalPaise === 590_000 && edited.body.items.length === 1, edited.body);

// Issuing
check('a salesperson cannot issue', (await post(`/api/v1/invoices/${d1.id}/issue`, rm)).status === 403);
const i1 = (await post(`/api/v1/invoices/${d1.id}/issue`, manager)).body;
check('issuing gives a number for this financial year', i1.status === 'issued' && i1.number === `VA/${fy}/0001`, i1);
check('the number fits the 16 character limit', i1.number.length <= 16);
check('the seller details are frozen on the invoice', i1.seller.gstin === MH);
check('an issued invoice cannot be edited', (await put(`/api/v1/invoices/${d1.id}`, manager, { items: [line] })).body.code === 'NOT_DRAFT');
check('it cannot be issued twice', (await post(`/api/v1/invoices/${d1.id}/issue`, manager)).body.code === 'NOT_DRAFT');
await put('/api/v1/billing-profile', manager, { ...profile, legalName: 'Renamed Pvt Ltd' });
check('later changes do not alter issued invoices', (await get(`/api/v1/invoices/${d1.id}`, manager)).body.seller.legalName === 'Batraa Vastu Pvt Ltd');
await put('/api/v1/billing-profile', manager, profile);
const many = await Promise.all([1, 2, 3, 4, 5].map(async () => (await post('/api/v1/invoices', manager, { leadId: lead1, items: [line], placeOfSupply: '27' })).body.id));
const issued = await Promise.all(many.map((id) => post(`/api/v1/invoices/${id}/issue`, manager)));
const nums = issued.map((r) => Number(r.body.number?.split('/')[2])).sort((a, b) => a - b);
check('issued at the same moment, numbers still run without gaps', JSON.stringify(nums) === JSON.stringify([2, 3, 4, 5, 6]), issued.map((r) => r.body));

// Payments
const pay = (id, body, token = manager) => post(`/api/v1/invoices/${id}/payments`, token, { mode: 'upi', ...body });
check('a draft cannot be paid', (await pay(d2.id, { amountPaise: 100 })).body.code === 'NOT_ISSUED');
check('more than is due is refused', (await pay(d1.id, { amountPaise: 590_001 })).body.code === 'TOO_MUCH');
const p1 = await pay(d1.id, { amountPaise: 200_000, reference: 'UPI123' });
check('a part payment is recorded', p1.status === 201 && p1.body.kind === 'instalment', p1.body);
let cur = (await get(`/api/v1/invoices/${d1.id}`, manager)).body;
check('the amount paid goes up', cur.paidPaise === 200_000 && cur.payments.length === 1);
check('it shows on the lead', JSON.stringify((await get(`/api/v1/leads/${lead1}`, manager)).body.activities).includes(`received on invoice ${i1.number}`));
check('an invoice with payments cannot be cancelled', (await post(`/api/v1/invoices/${d1.id}/cancel`, manager, { reason: 'mistake made' })).body.code === 'HAS_PAYMENTS');
await post(`/api/v1/payments/${p1.body.id}/void`, manager, { reason: 'wrong entry' });
cur = (await get(`/api/v1/invoices/${d1.id}`, manager)).body;
check('voiding a payment takes it off the invoice', cur.paidPaise === 0 && cur.payments[0].isVoided === true, cur.paidPaise);
const racing = await Promise.all([pay(d1.id, { amountPaise: 590_000 }), pay(d1.id, { amountPaise: 590_000 })]);
check('paying twice at once cannot overpay', racing.filter((r) => r.status === 201).length === 1, racing.map((r) => r.body));
const list = async (view) => (await get(`/api/v1/invoices?view=${view}`, manager)).body;
check('a fully paid invoice is under Paid', (await list('paid')).rows.some((r) => r.id === d1.id));
check('it is no longer Unpaid', !(await list('unpaid')).rows.some((r) => r.id === d1.id));
const overdueLead = many[0];
await post(`/api/v1/invoices/${overdueLead}/cancel`, manager, { reason: 'typed wrongly' });
cur = (await get(`/api/v1/invoices/${overdueLead}`, manager)).body;
check('cancelling keeps the number and the reason', cur.status === 'cancelled' && cur.number && cur.cancelReason === 'typed wrongly', cur);
check('a cancelled invoice cannot be paid', (await pay(overdueLead, { amountPaise: 100 })).body.code === 'NOT_ISSUED');
const sum = (await list('all')).summary;
check('the totals leave out cancelled invoices', sum.billedPaise === 590_000 + 1_062_000 * 4 && sum.collectedPaise === 590_000, sum);

// From a quote
const product = (await post('/api/v1/products', admin, { name: `Audit ${stamp}`, mrpPaise: 1_000_000, gstRate: 18 })).body;
const ql = await mkLead();
const q = await post(`/api/v1/leads/${ql}/quotes`, manager, { items: [{ packageId: product.id, qty: 1 }] });
check('(setup) a quote', q.status === 201, q.body);
check('a draft quote cannot be invoiced', (await post(`/api/v1/invoices/from-quote/${q.body.id}`, manager)).body.code === 'QUOTE_NOT_READY');
const sentQ = await post(`/api/v1/quotes/${q.body.id}/send`, manager);
const fromQ = await post(`/api/v1/invoices/from-quote/${q.body.id}`, manager);
check('a sent quote becomes a draft invoice', fromQ.status === 201 && fromQ.body.items[0].gstBp === 1800 && fromQ.body.totalPaise === 1_180_000, { sent: sentQ.status, body: fromQ.body });
check('one quote gets one invoice', (await post(`/api/v1/invoices/from-quote/${q.body.id}`, manager)).body.code === 'ALREADY_INVOICED');

// Not registered
await put('/api/v1/billing-profile', manager, { ...profile, gstin: null });
const noTax = (await post('/api/v1/invoices', manager, { leadId: lead1, items: [line], placeOfSupply: '27' })).body;
check('a seller without GST charges none', noTax.cgstPaise === 0 && noTax.igstPaise === 0 && noTax.totalPaise === 900_000, noTax);
await put('/api/v1/billing-profile', manager, profile);

// Who sees what
const arjunLead = await mkLead(ARJUN);
const arjunInv = (await post('/api/v1/invoices', rm, { leadId: arjunLead, items: [line], placeOfSupply: '27' })).body;
check('a salesperson can draft on their own lead', !!arjunInv.id, arjunInv);
check('they see only invoices on their own leads', (await get('/api/v1/invoices', rm)).body.rows.every((r) => r.id === arjunInv.id));
check('another lead\'s invoice is hidden', (await get(`/api/v1/invoices/${d1.id}`, rm)).status === 404);
check('they cannot invoice someone else\'s lead', (await post('/api/v1/invoices', rm, { leadId: lead1, items: [line] })).status === 404);
check('an auditor can read', (await get(`/api/v1/invoices/${d1.id}`, auditor)).status === 200);
check('an auditor cannot create', (await post('/api/v1/invoices', auditor, { leadId: lead1, items: [line] })).status === 403);

// Register
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const reg = await get(`/api/v1/invoices/register.csv?from=${today}&to=${today}`, manager);
const rows = String(reg.body).split('\n');
check('the register lists issued invoices', reg.status === 200 && rows.length === 7 && rows[0].startsWith('Invoice no,Date (IST)'), rows.length);
check('a cancelled invoice counts as zero', rows.find((r) => r.includes(cur.number)).includes('0.00,0.00,0.00,0.00,0.00,0.00,Cancelled'), rows.find((r) => r.includes(cur.number)));
check('tax columns are right', rows.find((r) => r.startsWith(i1.number)).includes('5000.00,450.00,450.00,0.00,0.00,5900.00,Issued'), rows.find((r) => r.startsWith(i1.number)));
check('a date range outside finds nothing', String((await get('/api/v1/invoices/register.csv?from=2020-01-01&to=2020-01-31', manager)).body).split('\n').length === 1);
// Merging customers moves their invoices (and undo moves them back)
const dupLead = await mkLead();
const dupInv = (await post('/api/v1/invoices', manager, { leadId: dupLead, items: [line], placeOfSupply: '27' })).body;
const custOf = async (leadId) => { const l = (await call(`/api/v1/leads/${leadId}`, { token: admin })).body; return l.customerId ?? l.customer?.id; };
const primaryCust = await custOf(lead1), dupCust = await custOf(dupLead);
const merged = await post('/api/v1/customers/merge', admin, { primaryId: primaryCust, duplicateId: dupCust, reason: 'same person' });
const invAfter = (await call(`/api/v1/invoices/${dupInv.id}`, { token: admin })).body;
check('merging customers moves their invoices', merged.status === 200 && merged.body.otherMoved?.invoice === 1 && invAfter.customerId === primaryCust, { merged: merged.body, customerId: invAfter.customerId });
await post(`/api/v1/customers/merges/${merged.body.mergeId}/undo`, admin, {});
check('undoing the merge moves the invoice back', (await call(`/api/v1/invoices/${dupInv.id}`, { token: admin })).body.customerId === dupCust);

const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('issuing and cancelling are audited', audit.includes('invoice.issued') && audit.includes('invoice.cancelled'));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
