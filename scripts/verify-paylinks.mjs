// End-to-end checks for slice 3.2: Razorpay payment links, signed webhooks, receipts. A local server plays Razorpay on :4597, so a real test account must still be checked.
// Usage: npm run verify:paylinks   (API running, freshly seeded; run `npm run db:seed` afterwards).

import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const HOOK_SECRET = 'rzp-webhook-secret';
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers = {}, raw } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const res = await fetch(path.startsWith('http') ? path : API + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;

const made = [], cancelled = [];
let refuse = false, seq = 0;
const server = createServer((req, res) => {
  let data = ''; req.on('data', (c) => (data += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const m = req.url.match(/^\/v1\/payment_links\/(\w+)\/cancel$/);
    if (m) { cancelled.push(m[1]); return res.end('{"status":"cancelled"}'); }
    if (req.url === '/v1/payment_links') {
      if (refuse) { res.statusCode = 400; return res.end('{"error":{"description":"Bad amount"}}'); }
      const b = JSON.parse(data); made.push({ ...b, auth: req.headers.authorization });
      return res.end(JSON.stringify({ id: `plink_${++seq}`, short_url: `https://rzp.test/${seq}`, status: 'created' }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => server.listen(4597, r));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const auditor = await login('auditor@mycompany.local');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]))['Vastu Consultation / Audit'];
const users = (await call('/api/v1/users', { token: admin })).body;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local').id;
const post = (p, token, body) => call(p, { token, workspace: VASTU, method: 'POST', body: body ?? {} });
const get = (p, token) => call(p, { token, workspace: VASTU });
const stamp = Date.now();
let n = 0;
await call('/api/v1/billing-profile', { token: manager, workspace: VASTU, method: 'PUT', body: { legalName: 'Batraa Vastu Pvt Ltd', gstin: '27AAPFU0939F1ZV', stateCode: '27', address: '12 MG Road, Pune', invoicePrefix: 'VA' } });
const line = { description: 'Vastu audit', qty: 1, unitPaise: 1_000_000, gstBp: 1800 };
const issued = async () => {
  const lead = (await post('/api/v1/leads', manager, { name: `Pay Lead ${++n} ${stamp}`, mobile: `9${String(stamp).slice(-7)}${String(n).padStart(2, '0')}`, email: `pay${n}.${stamp}@example.com`, customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
  const d = (await post('/api/v1/invoices', manager, { leadId: lead.id ?? lead.lead.id, items: [line], placeOfSupply: '27' })).body;
  return (await post(`/api/v1/invoices/${d.id}/issue`, manager)).body;
};
const link = (id, body, token = manager) => post(`/api/v1/invoices/${id}/payment-link`, token, body ?? {});
const inv = await issued();
check('a link needs Razorpay connected', (await link(inv.id)).body.code === 'GATEWAY_OFF');
await call('/api/v1/integrations/razorpay/setup', { token: admin, method: 'PUT', body: { values: { keyId: 'rzp_test_abc', apiSecret: 'rzp-key-secret', webhookSecret: HOOK_SECRET, mode: 'test', apiBase: 'http://localhost:4597' }, activate: true } });
const setup = (await call('/api/v1/integrations/razorpay/setup', { token: admin })).body;
check('setup hides the secrets', /^••••/.test(setup.values.apiSecret) && /^••••/.test(setup.values.webhookSecret), setup.values);
check('setup gives a webhook address', /\/hooks\/mycompany\/razorpay\//.test(setup.webhookUrl));
check('Razorpay shows as live', setup.phase === 'Live');

const hook = (body, sig) => { const raw = JSON.stringify(body); return call(setup.webhookUrl, { tenant: null, method: 'POST', raw, headers: { 'X-Razorpay-Signature': sig ?? createHmac('sha256', HOOK_SECRET).update(raw).digest('hex') } }); };
const paid = (plink, payId, amount) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: plink, amount_paid: amount, status: 'paid' } }, payment: { entity: { id: payId, amount, method: 'upi', captured: true } } } });

check('a salesperson cannot use someone else\'s invoice', (await link(inv.id, {}, rm)).status === 404);
check('an auditor cannot create a link', (await link(inv.id, {}, auditor)).status === 403);
const draftLead = (await post('/api/v1/leads', manager, { name: `Draft ${stamp}`, mobile: `8${String(stamp).slice(-9)}`, customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const draft = (await post('/api/v1/invoices', manager, { leadId: draftLead.id ?? draftLead.lead.id, items: [line], placeOfSupply: '27' })).body;
check('a draft cannot have a link', (await link(draft.id)).body.code === 'NOT_ISSUED');
check('a link cannot ask for more than is due', (await link(inv.id, { amountPaise: 99_999_999 })).body.code === 'TOO_MUCH');
const l1 = (await link(inv.id)).body;
check('a link is made for the amount due', l1.amountPaise === 1_180_000 && l1.url === 'https://rzp.test/1', l1);
check('Razorpay receives the right details', made[0].amount === 1_180_000 && made[0].currency === 'INR' && made[0].customer.name.startsWith('Pay Lead') && made[0].auth === `Basic ${Buffer.from('rzp_test_abc:rzp-key-secret').toString('base64')}`, made[0]);
check('the reference fits Razorpay\'s limit', made[0].reference_id.length <= 40, made[0].reference_id);
check('by default Razorpay does not message the customer', made[0].notify.sms === false && made[0].notify.email === false);
const l2 = (await link(inv.id, { amountPaise: 500_000, notifyCustomer: true })).body;
const list = (await get(`/api/v1/invoices/${inv.id}/payment-links`, manager)).body;
check('a new link replaces the open one', cancelled.includes('plink_1') && list.links.filter((x) => x.status === 'created').length === 1 && list.links.find((x) => x.id === l1.id).status === 'cancelled', list.links);
check('the customer can be messaged when asked', made[1].notify.sms === true && made[1].notify.email === true);
check('an invoice with an open link cannot be cancelled', (await post(`/api/v1/invoices/${inv.id}/cancel`, manager, { reason: 'made a mistake' })).body.code === 'OPEN_LINK');
refuse = true;
const refused = await link(inv.id);
check('a refusal from Razorpay is shown', refused.body.code === 'GATEWAY_REFUSED' && refused.body.message.includes('Bad amount'), refused.body);
refuse = false;
const l3 = (await link(inv.id, { amountPaise: 500_000 })).body;

// Webhooks
check('an unsigned webhook is refused', (await call(setup.webhookUrl, { tenant: null, method: 'POST', raw: JSON.stringify(paid('plink_x', 'pay_0', 100)) })).status === 401);
check('a forged webhook is refused', (await hook(paid(l3.url.split('/').pop(), 'pay_0', 100), '0'.repeat(64))).status === 401);
const plink = `plink_${seq}`;
const h1 = await hook(paid(plink, 'pay_1', 500_000));
check('a signed webhook is accepted', h1.status === 200 && h1.body.ok === true, h1.body);
let cur = (await get(`/api/v1/invoices/${inv.id}`, manager)).body;
check('the invoice is credited', cur.paidPaise === 500_000 && cur.payments.length === 1 && cur.payments[0].mode === 'online' && cur.payments[0].reference === 'pay_1', cur.payments);
const again = await hook(paid(plink, 'pay_1', 500_000));
cur = (await get(`/api/v1/invoices/${inv.id}`, manager)).body;
check('the same webhook twice records it once', again.body.duplicate === true && cur.paidPaise === 500_000 && cur.payments.length === 1, again.body);
const racing = await Promise.all([hook(paid(plink, 'pay_2', 1000)), hook(paid(plink, 'pay_2', 1000)), hook(paid(plink, 'pay_2', 1000))]);
cur = (await get(`/api/v1/invoices/${inv.id}`, manager)).body;
check('webhooks arriving together record it once', cur.paidPaise === 501_000 && racing.every((r) => r.status === 200), racing.map((r) => r.status));
const links = (await get(`/api/v1/invoices/${inv.id}/payment-links`, manager)).body.links;
check('the link shows as paid', links.find((x) => x.id === l3.id).status === 'paid', links);
check('a paid link cannot be cancelled', (await post(`/api/v1/payment-links/${l3.id}/cancel`, manager)).body.code === 'NOT_OPEN');
const notes = JSON.stringify((await call('/api/v1/notifications', { token: admin, workspace: VASTU })).body) + JSON.stringify((await call('/api/v1/notifications', { token: manager, workspace: VASTU })).body);
check('an unknown link is ignored', (await hook(paid('plink_none', 'pay_9', 100))).body.ignored === true);
check('other events are ignored', (await hook({ event: 'payment.authorized', payload: {} })).body.ignored === true);
const lead = (await get(`/api/v1/leads/${cur.leadId}`, manager)).body;
check('the payment is on the lead', JSON.stringify(lead.activities).includes(`received on invoice ${cur.number}`));

// Expired and cancelled
const inv2 = await issued();
const e1 = (await link(inv2.id)).body;
await hook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: `plink_${seq}` } } } });
check('an expired link is marked', (await get(`/api/v1/invoices/${inv2.id}/payment-links`, manager)).body.links.find((x) => x.id === e1.id).status === 'expired');
const e2 = (await link(inv2.id)).body;
check('a link can be cancelled', (await post(`/api/v1/payment-links/${e2.id}/cancel`, manager)).status === 200 && cancelled.includes(`plink_${seq}`));
check('with no open link the invoice can be cancelled', (await post(`/api/v1/invoices/${inv2.id}/cancel`, manager, { reason: 'made a mistake' })).status === 200);
check('a cancelled invoice cannot have a link', (await link(inv2.id)).body.code === 'NOT_ISSUED');

// Receipts
const inv3 = await issued();
const p1 = (await post(`/api/v1/invoices/${inv3.id}/payments`, manager, { amountPaise: 100_000, mode: 'upi' })).body;
const p2 = (await post(`/api/v1/invoices/${inv3.id}/payments`, manager, { amountPaise: 200_000, mode: 'cash' })).body;
const num = (r) => Number(r.split('/')[2]);
check('every payment gets a receipt number', /^RCPT\/\d\d-\d\d\/\d{4}$/.test(p1.receiptNumber), p1.receiptNumber);
check('receipt numbers run in order', num(p2.receiptNumber) === num(p1.receiptNumber) + 1);
const rc = (await get(`/api/v1/payments/${p1.id}/receipt`, manager)).body;
check('a receipt shows the words and the invoice', rc.words === 'Rupees One Thousand Only' && rc.invoice.number === inv3.number && rc.seller.legalName === 'Batraa Vastu Pvt Ltd', rc);
check('a salesperson cannot open someone else\'s receipt', (await get(`/api/v1/payments/${p1.id}/receipt`, rm)).status === 404);
await post(`/api/v1/payments/${p1.id}/void`, manager, { reason: 'wrong entry' });
check('a voided payment\'s receipt says so', (await get(`/api/v1/payments/${p1.id}/receipt`, manager)).body.isVoided === true);
check('manual payments still credit the invoice', (await get(`/api/v1/invoices/${inv3.id}`, manager)).body.paidPaise === 200_000);
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('payment links are audited', audit.includes('payment_link.created') && audit.includes('payment.gateway_received'));
check('no secret reaches the audit log', !audit.includes('rzp-key-secret') && !audit.includes(HOOK_SECRET));
check('the people involved are told it was paid', notes.includes('Payment received on invoice'), notes.slice(0, 200));

server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
