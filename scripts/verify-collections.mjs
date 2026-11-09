// End-to-end checks for slice 3.3: ageing, instalment plans, reminders, the customer ledger, access.
// Usage: npm run verify:collections   (API running, freshly seeded, Mailpit on; run `npm run db:seed` afterwards).

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const auditor = await login('auditor@mycompany.local');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const VASTU = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]))['Vastu Consultation / Audit'];
const users = (await call('/api/v1/users', { token: admin })).body;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local').id, ARJUN = users.find((u) => u.email === 'rm@mycompany.local').id;
const post = (p, token, body) => call(p, { token, workspace: VASTU, method: 'POST', body: body ?? {} });
const put = (p, token, body) => call(p, { token, workspace: VASTU, method: 'PUT', body });
const get = (p, token) => call(p, { token, workspace: VASTU });
const stamp = Date.now();
const DAY = 86_400_000;
const days = (n) => new Date(Date.now() + n * DAY).toISOString();
let n = 0;
const profile = { legalName: 'Batraa Vastu Pvt Ltd', gstin: '27AAPFU0939F1ZV', stateCode: '27', address: '12 MG Road, Pune', invoicePrefix: 'VA' };
await put('/api/v1/billing-profile', manager, profile);
const mkLead = async (ownerId = NEHA, email = true) => { const i = ++n; const r = (await post('/api/v1/leads', manager, { name: `Coll Lead ${i} ${stamp}`, mobile: `9${String(stamp).slice(-7)}${String(i).padStart(2, '0')}`, ...(email ? { email: `coll${i}.${stamp}@example.com` } : {}), customFields: { property_type: 'Home' }, ownerId })).body; return r.id ?? r.lead?.id; };
const line = (unitPaise = 1_000_000) => ({ description: 'Audit', qty: 1, unitPaise, gstBp: 0 });
const issued = async (leadId, dueAt, unit) => { const d = (await post('/api/v1/invoices', manager, { leadId, items: [line(unit)], placeOfSupply: '27', ...(dueAt ? { dueAt } : {}) })).body; return (await post(`/api/v1/invoices/${d.id}/issue`, manager)).body; };

const leadA = await mkLead();
const notDue = await issued(leadA, days(10));
const age5 = await issued(leadA, days(-5));
const age40 = await issued(leadA, days(-40));
const age70 = await issued(leadA, days(-70));
const age100 = await issued(leadA, days(-100));
const noDate = await issued(leadA, null);
const c = (await get('/api/v1/collections', manager)).body;
check('money due is sorted into age bands', c.ageing.notDue === 2_000_000 && c.ageing.d1to30 === 1_000_000 && c.ageing.d31to60 === 1_000_000 && c.ageing.d61to90 === 1_000_000 && c.ageing.d90plus === 1_000_000, c.ageing);
check('the most overdue comes first', c.rows[0].id === age100.id, c.rows.slice(0, 2));
check('days overdue are worked out', c.rows.find((r) => r.id === age5.id).daysPast === 5, c.rows.find((r) => r.id === age5.id));
check('an invoice with no due date is not overdue', c.rows.find((r) => r.id === noDate.id).bucket === 'notDue');
check('the biggest debtors are listed', c.byCustomer[0].invoices === 6 && c.byCustomer[0].duePaise === 6_000_000, c.byCustomer[0]);
await post(`/api/v1/invoices/${notDue.id}/payments`, manager, { amountPaise: 1_000_000 });
await post(`/api/v1/invoices/${age5.id}/payments`, manager, { amountPaise: 400_000 });
const c2 = (await get('/api/v1/collections', manager)).body;
check('a paid invoice leaves the list', !c2.rows.some((r) => r.id === notDue.id));
check('a part payment reduces what is due', c2.rows.find((r) => r.id === age5.id).duePaise === 600_000 && c2.ageing.d1to30 === 600_000, c2.ageing);
const csv = String((await get('/api/v1/collections.csv', manager)).body).split('\n');
check('the list can be downloaded', csv[0].startsWith('Invoice no,Customer') && csv.length === 6, csv.length);
check('a download shows days overdue and rupees', csv.find((l) => l.startsWith(age5.number)).endsWith(',5,10000.00,4000.00,6000.00'), csv.find((l) => l.startsWith(age5.number)));

// Instalments
const leadB = await mkLead();
const inv = await issued(leadB, days(-1), 900_000);
const plan = (list, token = manager, id = inv.id) => put(`/api/v1/invoices/${id}/instalments`, token, { instalments: list });
check('instalments must add up to the invoice', (await plan([{ dueAt: days(5), amountPaise: 100_000 }])).body.code === 'PLAN_TOTAL');
check('a salesperson cannot plan someone else\'s invoice', (await plan([{ dueAt: days(5), amountPaise: 900_000 }], rm)).status === 404);
const ok = await plan([{ dueAt: days(30), amountPaise: 300_000 }, { dueAt: days(-2), amountPaise: 300_000 }, { dueAt: days(60), amountPaise: 300_000 }]);
check('a plan is saved in date order', ok.status === 200 && ok.body[0].amountPaise === 300_000 && new Date(ok.body[0].dueAt) < new Date(ok.body[1].dueAt), ok.body);
const dueOf = async () => new Date((await get(`/api/v1/invoices/${inv.id}`, manager)).body.dueAt).getTime();
check('the invoice falls due on the first instalment', Math.abs(await dueOf() - new Date(days(-2)).getTime()) < 60_000);
const p1 = (await post(`/api/v1/invoices/${inv.id}/payments`, manager, { amountPaise: 300_000 })).body;
check('paying one moves the due date to the next', Math.abs(await dueOf() - new Date(days(30)).getTime()) < 60_000);
check('it is no longer overdue', (await get('/api/v1/collections', manager)).body.rows.find((r) => r.id === inv.id).daysPast < 0);
await post(`/api/v1/payments/${p1.id}/void`, manager, { reason: 'bounced cheque' });
check('voiding the payment moves it back', Math.abs(await dueOf() - new Date(days(-2)).getTime()) < 60_000);
check('a plan can be removed', (await plan([])).body.length === 0);
check('an auditor can read a plan but not change it', (await get(`/api/v1/invoices/${inv.id}/instalments`, auditor)).status === 200 && (await plan([], auditor)).status === 403);

// Reminders
const mails = async (to) => { const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=20`).then((x) => x.json()); return r.messages ?? []; };
const emailOf = (i) => `coll${i}.${stamp}@example.com`;
const runNow = () => post('/api/v1/automation/run-now', admin);
const leadC = await mkLead();
const cNo = n;
const remindInv = await issued(leadC, days(-4), 500_000);
await post(`/api/v1/invoices/${remindInv.id}/remind`, rm).then((r) => check('a salesperson cannot chase someone else\'s invoice', r.status === 404));
const manual = await post(`/api/v1/invoices/${remindInv.id}/remind`, manager);
await sleep(500);
const m1 = await mails(emailOf(cNo));
check('a reminder can be emailed by hand', manual.status === 200 && m1.length === 1 && m1[0].Subject.includes(remindInv.number), m1.length);
check('the reminder date is shown', !!(await get('/api/v1/collections', manager)).body.rows.find((r) => r.id === remindInv.id).lastReminderAt);
await runNow();
await sleep(600);
const notes = async () => JSON.stringify((await call('/api/v1/notifications', { token: manager, workspace: VASTU })).body);
check('the owner is told when an invoice is overdue', (await notes()).includes(`Invoice ${remindInv.number} is 4 days overdue`), (await notes()).slice(0, 300));
check('automatic email to customers is off by default', (await mails(emailOf(cNo))).length === 1);
const beforeSecond = (await notes()).split(`Invoice ${remindInv.number} is`).length;
await runNow();
await sleep(500);
check('running again does not repeat the alert', (await notes()).split(`Invoice ${remindInv.number} is`).length === beforeSecond);
await put('/api/v1/billing-profile', manager, { ...profile, autoRemind: true });
check('automatic email can be switched on', (await get('/api/v1/billing-profile', manager)).body.profile.autoRemind === true);
const leadD = await mkLead();
const dNo = n;
const autoInv = await issued(leadD, days(-1), 500_000);
await runNow();
await sleep(800);
const m2 = await mails(emailOf(dNo));
check('then the customer is emailed once', m2.length === 1 && m2[0].Subject.includes(autoInv.number), m2.length);
await runNow();
await sleep(600);
check('and not again the same day', (await mails(emailOf(dNo))).length === 1);
await post(`/api/v1/leads/${leadD}/outreach/opt-out`, manager, { channel: 'email', optedOut: true });
check('a customer who opted out is not emailed by hand', (await post(`/api/v1/invoices/${autoInv.id}/remind`, manager)).body.code === 'OPTED_OUT');
const leadE = await mkLead(NEHA, false);
const eInv = await issued(leadE, days(-1), 500_000);
check('a customer with no email cannot be emailed', (await post(`/api/v1/invoices/${eInv.id}/remind`, manager)).body.code === 'NO_ADDRESS');
const leadF = await mkLead();
const fInv = await issued(leadF, days(-3), 500_000);
await post(`/api/v1/invoices/${fInv.id}/payments`, manager, { amountPaise: 500_000 });
check('a paid invoice gets no reminder', (await post(`/api/v1/invoices/${fInv.id}/remind`, manager)).body.code === 'NOTHING_DUE');
await put('/api/v1/billing-profile', manager, { ...profile, autoRemind: false });

// Ledger
const leadG = await mkLead();
const g1 = await issued(leadG, days(10), 1_000_000);
await post(`/api/v1/invoices/${g1.id}/payments`, manager, { amountPaise: 400_000 });
const g2 = await issued(leadG, days(10), 200_000);
const pv = (await post(`/api/v1/invoices/${g2.id}/payments`, manager, { amountPaise: 100_000 })).body;
await post(`/api/v1/payments/${pv.id}/void`, manager, { reason: 'bounced' });
const g3 = await issued(leadG, days(10), 50_000);
await post(`/api/v1/invoices/${g3.id}/cancel`, manager, { reason: 'typed wrongly' });
const cust = (await get(`/api/v1/leads/${leadG}`, manager)).body.customerId;
const led = (await get(`/api/v1/customers/${cust}/ledger`, manager)).body;
check('the ledger runs a balance', led.rows.length === 3 && led.rows[0].balancePaise === 1_000_000 && led.rows[1].balancePaise === 600_000 && led.rows[2].balancePaise === 800_000, led.rows);
check('voided payments and cancelled invoices are left out', led.billedPaise === 1_200_000 && led.receivedPaise === 400_000 && led.balancePaise === 800_000, led);
check('a ledger follows who can see the customer', (await get(`/api/v1/customers/${cust}/ledger`, rm)).status === 404);
const arjunLead = await mkLead(ARJUN);
const arjunInv = await issued(arjunLead, days(-2), 100_000);
const rmView = (await get('/api/v1/collections', rm)).body;
check('a salesperson sees only their own money due', rmView.rows.length === 1 && rmView.rows[0].id === arjunInv.id, rmView.rows.length);
check('a plan without Finance cannot open collections', (await call('/api/v1/collections', { tenant: 'abc', token: await login('admin@abc.local', 'abc') })).status === 403);
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('plan changes are audited', audit.includes('invoice.plan_changed'));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
