// End-to-end checks for slice 3.8b: customers pay UBOS orders online (UBOS's own Razorpay account) and get GST tax invoices from UBOS.
// A local server plays Razorpay on :4596, so a real Razorpay test account must still be checked before going live with real money.
// Usage: npm run verify:payments   (API running, freshly seeded; run `npm run db:seed` afterwards).
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const HOOK_SECRET = 'ubos-hook-secret-123', KEY_SECRET = 'ubos-key-secret-456';
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = null, token, method = 'GET', body, raw, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, text };
}

const made = [];
let seq = 0;
const server = createServer((req, res) => {
  let data = ''; req.on('data', (c) => (data += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/payment_links') {
      made.push({ ...JSON.parse(data), auth: req.headers.authorization });
      return res.end(JSON.stringify({ id: `plink_ubos_${++seq}`, short_url: `https://rzp.test/ubos/${seq}`, status: 'created' }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => server.listen(4596, r));

const owner = (await call('/platform/v1/auth/login', { method: 'POST', body: { email: 'owner@ubos.local', password: PASSWORD } })).body.accessToken;
const plat = (path, method = 'GET', body) => call(`/platform/v1${path}`, { token: owner, method, body });
const abc = (await call('/api/v1/auth/login', { tenant: 'abc', method: 'POST', body: { identifier: 'admin@abc.local', password: PASSWORD } })).body.accessToken;
const mine = (await call('/api/v1/auth/login', { tenant: 'mycompany', method: 'POST', body: { identifier: 'admin@mycompany.local', password: PASSWORD } })).body.accessToken;
const A = (path, method = 'GET', body) => call(path, { tenant: 'abc', token: abc, method, body });
const hook = (body, sig) => { const raw = JSON.stringify(body); return call('/public/v1/razorpay', { method: 'POST', raw, headers: { 'X-Razorpay-Signature': sig ?? createHmac('sha256', HOOK_SECRET).update(raw).digest('hex') } }); };
const paidEvent = (link, payId, amount) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: link, status: 'paid' } }, payment: { entity: { id: payId, amount, method: 'upi', captured: true } } } });
const cat = (await A('/api/v1/billing/catalog')).body;
const LIC = cat.licences[0].code;
const order = async (qty = 2) => (await A('/api/v1/billing/orders', 'POST', { cycle: 'annual', items: [{ productCode: LIC, quantity: qty }] })).body;

// ---- Before online payment is set up ----
const s0 = (await plat('/settings')).body;
check('platform settings never show secrets', s0.hasRazorpaySecret === false && !('razorpaySecretEnc' in s0) && s0.invoicePrefix === 'UB', s0);
check('an organization sees online payment is off', (await A('/api/v1/billing/details')).body.onlinePay === false);
const o1 = await order();
check('paying online before it is set up is refused clearly', (await A(`/api/v1/billing/orders/${o1.id}/pay`, 'POST')).body.code === 'ONLINE_PAY_OFF');

// ---- UBOS billing settings ----
const billing = { sellerName: 'UBOS Software Pvt Ltd', sellerGstin: '27AAPFU0939F1ZV', sellerStateCode: '27', sellerAddress: '1 Tech Park, Pune 411001', sellerEmail: 'billing@ubos.local', invoicePrefix: 'UB', razorpayKeyId: 'rzp_test_ubos', razorpaySecret: KEY_SECRET, razorpayWebhookSecret: HOOK_SECRET, razorpayApiBase: 'http://localhost:4596' };
check('the GSTIN must match the state', (await plat('/settings/billing', 'PUT', { ...billing, sellerStateCode: '29' })).body.code === 'GSTIN_STATE');
const saved = await plat('/settings/billing', 'PUT', billing);
check('UBOS saves its invoice details and Razorpay keys', saved.status === 200 && saved.body.hasRazorpaySecret && saved.body.hasWebhookSecret && saved.body.sellerName === billing.sellerName, saved.body);
check('the saved secrets are never sent back', !saved.text.includes(KEY_SECRET) && !saved.text.includes(HOOK_SECRET) && !(await plat('/settings')).text.includes(KEY_SECRET));
check('an organization cannot change UBOS billing settings', [401, 403].includes((await call('/platform/v1/settings/billing', { token: abc, method: 'PUT', body: billing })).status));

// ---- Buyer details ----
check('a bad GSTIN is refused', (await A('/api/v1/billing/details', 'PUT', { billingName: 'ABC Pvt Ltd', gstin: '29BADGSTIN', billingStateCode: '29', billingAddress: 'MG Road, Bengaluru' })).status === 400);
check('the buyer GSTIN must match the state', (await A('/api/v1/billing/details', 'PUT', { billingName: 'ABC Pvt Ltd', gstin: '29GGGGG1314R9ZA', billingStateCode: '27', billingAddress: 'MG Road, Bengaluru' })).body.code === 'GSTIN_STATE');
const det = await A('/api/v1/billing/details', 'PUT', { billingName: 'ABC Education Pvt Ltd', gstin: '29GGGGG1314R9ZA', billingStateCode: '29', billingAddress: '12 MG Road, Bengaluru 560001' });
check('an organization saves its invoice details', det.status === 200 && (await A('/api/v1/billing/details')).body.onlinePay === true, det.body);

// ---- Paying online ----
const p1 = await A(`/api/v1/billing/orders/${o1.id}/pay`, 'POST');
const sent = made[made.length - 1];
check('paying opens a Razorpay link for the order total', p1.status === 200 && p1.body.url === 'https://rzp.test/ubos/1' && sent.amount === o1.totalPaise && sent.notes.ubos_order_id === o1.id, { p1: p1.body, sent });
check('the link is made with UBOS keys', sent.auth === `Basic ${Buffer.from(`rzp_test_ubos:${KEY_SECRET}`).toString('base64')}`);
check('asking again reuses the open link', (await A(`/api/v1/billing/orders/${o1.id}/pay`, 'POST')).body.url === p1.body.url && made.length === 1);
check('another organization cannot pay this order', (await call(`/api/v1/billing/orders/${o1.id}/pay`, { tenant: 'mycompany', token: mine, method: 'POST' })).status === 404);
check('an unsigned webhook is refused', (await hook(paidEvent('plink_ubos_1', 'pay_X', o1.totalPaise), 'bad')).status === 400);
check('a short payment is not applied', (await hook(paidEvent('plink_ubos_1', 'pay_short', o1.totalPaise - 100))).body.ignored === true && (await A('/api/v1/billing/orders')).body.find((o) => o.id === o1.id).status === 'pending');
const h1 = await hook(paidEvent('plink_ubos_1', 'pay_UBOS_1', o1.totalPaise));
const after1 = (await A('/api/v1/billing/orders')).body.find((o) => o.id === o1.id);
check('a paid webhook applies the order', h1.body.applied === true && after1.status === 'paid' && after1.paidVia === 'online' && after1.paymentRef === 'pay_UBOS_1', { h1: h1.body, after1 });
const cat1 = (await A('/api/v1/billing/catalog')).body.subscription;
check('the subscription becomes active with the licences', cat1.status === 'active' && cat1.licences === 2, cat1);
check('a repeated webhook changes nothing', (await hook(paidEvent('plink_ubos_1', 'pay_UBOS_1', o1.totalPaise))).body.applied === false && (await A('/api/v1/billing/invoices')).body.length === 1);

// ---- Invoices ----
const invs = (await A('/api/v1/billing/invoices')).body;
const inv1 = (await A(`/api/v1/billing/invoices/${invs[0]?.id}`)).body;
check('UBOS issues a numbered invoice', /^UB\/\d{2}-\d{2}\/0001$/.test(inv1.number) && inv1.totalPaise === o1.totalPaise && inv1.paymentRef === 'pay_UBOS_1', inv1);
check('another state is charged IGST', inv1.igstPaise === o1.gstPaise && inv1.cgstPaise === 0 && inv1.placeOfSupply === '29' && inv1.placeOfSupplyName === 'Karnataka', inv1);
check('the invoice shows both parties and the amount in words', inv1.seller.gstin === '27AAPFU0939F1ZV' && inv1.buyer.gstin === '29GGGGG1314R9ZA' && inv1.buyer.name === 'ABC Education Pvt Ltd' && /Rupees/.test(inv1.words), { seller: inv1.seller, buyer: inv1.buyer, words: inv1.words });
check('another organization cannot open it', (await call(`/api/v1/billing/invoices/${inv1.id}`, { tenant: 'mycompany', token: mine })).status === 404);
const notes = (await A('/api/v1/notifications')).body;
check('billing admins are told', (notes.items ?? notes).some((n) => n.title === `Payment received for order ${o1.number}`));

// ---- Marked paid by hand, same state ----
await A('/api/v1/billing/details', 'PUT', { billingName: 'ABC Education Pvt Ltd', gstin: null, billingStateCode: '27', billingAddress: 'FC Road, Pune 411004' });
const o2 = await order(1);
const d2 = (await A('/api/v1/billing/details')).body;
check('a buyer without a GSTIN is fine', d2.gstin === null && d2.billingStateCode === '27', d2);
const m2 = await plat(`/orders/${o2.id}/mark-paid`, 'POST', { paymentRef: 'UTR-778899' });
const inv2 = (await plat(`/invoices/${(await plat('/invoices')).body.find((i) => i.orderId === o2.id)?.id}`)).body;
check('marking paid also issues an invoice', m2.status === 200 && /\/0002$/.test(m2.body.invoiceNumber) && inv2.number === m2.body.invoiceNumber, m2.body);
check('the same state splits into CGST and SGST', inv2.cgstPaise + inv2.sgstPaise === o2.gstPaise && inv2.igstPaise === 0 && inv2.cgstPaise > 0, inv2);
const allInv = (await plat('/invoices')).body;
check('the console lists every invoice with its organization', allInv.length === 2 && allInv.every((i) => i.tenant?.slug === 'abc'), allInv.map((i) => i.number));
check('marking a paid order paid again is refused', (await plat(`/orders/${o2.id}/mark-paid`, 'POST', { paymentRef: 'UTR-1' })).status === 409);

// ---- Links that run out, and keeping secrets ----
const o3 = await order(1);
const p3 = await A(`/api/v1/billing/orders/${o3.id}/pay`, 'POST');
await hook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: `plink_ubos_${seq}` } } } });
const p3b = await A(`/api/v1/billing/orders/${o3.id}/pay`, 'POST');
check('an expired link is replaced by a new one', p3.body.url !== p3b.body.url && /ubos\/\d+$/.test(p3b.body.url), [p3.body, p3b.body]);
const { razorpaySecret, razorpayWebhookSecret, ...noSecrets } = billing;
const kept = await plat('/settings/billing', 'PUT', { ...noSecrets, sellerAddress: '2 Tech Park, Pune 411001' });
check('saving without secrets keeps the saved ones', kept.body.hasRazorpaySecret && kept.body.hasWebhookSecret && (await hook(paidEvent(`plink_ubos_${seq}`, 'pay_UBOS_3', o3.totalPaise))).body.applied === true);

const audit = JSON.stringify((await A('/api/v1/audit-logs')).body);
check('payments and details are audited', audit.includes('billing.order_paid') && audit.includes('billing.details_saved') && audit.includes('billing.pay_link_opened'));

server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
