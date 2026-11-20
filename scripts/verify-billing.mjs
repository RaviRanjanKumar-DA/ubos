// End-to-end checks for slice 3.8a: self-serve trial signup, the trial and renewal lifecycle (grace, expired, paid), reminders, usage.
// Usage: npm run verify:billing   (API running, freshly seeded, Mailpit on :8025; run `npm run db:seed` afterwards).

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = null, token, method = 'GET', body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const inbox = async () => (await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()).messages ?? [];
const codeFor = async (email) => {
  for (let i = 0; i < 20; i++) {
    const m = (await inbox()).find((x) => x.To?.[0]?.Address === email && /sign-up code/.test(x.Subject));
    if (m) return m.Subject.match(/\d{6}/)[0];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const istDay = (offset = 0) => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
const owner = (await call('/platform/v1/auth/login', { method: 'POST', body: { email: 'owner@ubos.local', password: PASSWORD } })).body.accessToken;
const plat = (path, method = 'GET', body) => call(`/platform/v1${path}`, { token: owner, method, body });
await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });

// ---- Signup ----
const stamp = Date.now().toString(36);
const SLUG = `trial-${stamp}`, EMAIL = `founder-${stamp}@example.com`;
const cfg = (await call('/public/v1/signup/config')).body;
check('signup is open with a 14-day trial', cfg.enabled === true && cfg.trialDays === 14 && cfg.licences === 5 && !!cfg.plan, cfg);
check('a taken organization code is refused', (await call('/public/v1/signup/slug?slug=mycompany')).body.available === false);
check('reserved names are refused', (await call('/public/v1/signup/slug?slug=console')).body.available === false);
check('badly formed codes are refused', (await call('/public/v1/signup/slug?slug=A%20B')).body.available === false);
check('a free code is offered', (await call(`/public/v1/signup/slug?slug=${SLUG}`)).body.available === true);
const sent = await call('/public/v1/signup/code', { method: 'POST', body: { email: EMAIL } });
const code = await codeFor(EMAIL);
check('a sign-up code is emailed', sent.status === 200 && /^\d{6}$/.test(code ?? ''), sent.body);
const form = { email: EMAIL, orgName: 'Trial Traders', slug: SLUG, name: 'Founder Singh', password: 'Trial@2026x', businessLines: [{ name: 'Real Estate', template: 'real_estate' }] };
check('a wrong code is refused', (await call('/public/v1/signup', { method: 'POST', body: { ...form, code: code === '000000' ? '111111' : '000000' } })).body.code === 'CODE_INVALID');
check('a weak password is refused', (await call('/public/v1/signup', { method: 'POST', body: { ...form, code, password: 'short' } })).status === 400);
check('a taken code is refused at signup', (await call('/public/v1/signup', { method: 'POST', body: { ...form, code, slug: 'abc' } })).body.code === 'SLUG_TAKEN');
const made = await call('/public/v1/signup', { method: 'POST', body: { ...form, code } });
check('the organization is created', made.status === 201 && made.body.slug === SLUG, made.body);
check('a used code cannot be used again', (await call('/public/v1/signup', { method: 'POST', body: { ...form, code, slug: `${SLUG}-2` } })).body.code === 'CODE_INVALID');
const tok = (await call('/api/v1/auth/login', { tenant: SLUG, method: 'POST', body: { identifier: EMAIL, password: form.password } })).body.accessToken;
const T = (path, method = 'GET', body) => call(path, { tenant: SLUG, token: tok, method, body });
const me = (await T('/api/v1/auth/me')).body;
check('the founder signs in to a trial', !!tok && me.tenant.status === 'trial' && me.tenant.billing?.phase === 'trial' && me.tenant.billing.daysLeft === 14, me.tenant);
check('the business line is ready', me.workspaces.length === 1 && me.workspaces[0].name === 'Real Estate', me.workspaces);
const use = (await T('/api/v1/billing/usage')).body;
check('billing shows usage and what the trial includes', use.allowance.users === 5 && use.usage.active_users === 1 && use.billing.phase === 'trial', use);
const tenants = (await plat('/tenants')).body;
const NEW = tenants.find((t) => t.slug === SLUG);
check('the console shows it as a self-serve signup', NEW?.signedUpVia === 'self_serve' && NEW.status === 'trial' && !!NEW.endsAt, NEW);

// ---- Settings ----
const settings = (await plat('/settings')).body;
check('the console has signup and trial settings', settings.signupEnabled === true && settings.graceDays === 7, settings);
check('trial settings check the plan', (await plat('/settings', 'PUT', { ...settings, trialPlanCode: 'nope' })).status === 404);
await plat('/settings', 'PUT', { signupEnabled: false, trialDays: 14, trialPlanCode: settings.trialPlanCode, trialLicences: 5, graceDays: 7 });
check('signup can be closed', (await call('/public/v1/signup/code', { method: 'POST', body: { email: `x-${stamp}@example.com` } })).body.code === 'SIGNUP_CLOSED' && (await call('/public/v1/signup/config')).body.enabled === false);
await plat('/settings', 'PUT', { signupEnabled: true, trialDays: 14, trialPlanCode: settings.trialPlanCode, trialLicences: 5, graceDays: 7 });
check('an organization cannot change platform settings', [401, 403].includes((await call('/platform/v1/settings', { token: tok, method: 'PUT', body: settings })).status));

// ---- Lifecycle ----
const sub = (body) => plat(`/tenants/${NEW.id}/subscription`, 'PATCH', { reason: 'Testing the lifecycle', ...body });
check('changing a subscription needs a reason', (await plat(`/tenants/${NEW.id}/subscription`, 'PATCH', { endsOn: istDay(3) })).status === 400);
await sub({ endsOn: istDay(3) });
const r1 = await plat('/billing/run', 'POST');
const notes = async () => { const n = (await T('/api/v1/notifications')).body; return (n.items ?? n).map((x) => x.title); };
check('admins are reminded 3 days before the trial ends', r1.status === 200 && (await notes()).some((t) => t === 'Your UBOS trial ends in 3 days'), await notes());
await plat('/billing/run', 'POST');
check('each reminder is sent once', (await notes()).filter((t) => t === 'Your UBOS trial ends in 3 days').length === 1);
const g = await sub({ endsOn: istDay(-2) });
check('after the trial ends the account is in grace', g.body.status === 'grace', g.body);
check('everything keeps working in grace', (await T('/api/v1/leads')).status === 200);
const meG = (await T('/api/v1/auth/me')).body.tenant.billing;
check('grace shows the days left before it pauses', meG.phase === 'grace' && meG.daysLeft === 5, meG);
check('admins are told the trial has ended', (await notes()).includes('Your UBOS trial has ended') && (await inbox()).some((m) => m.To?.[0]?.Address === EMAIL && m.Subject === 'Your UBOS trial has ended'));
const x = await sub({ endsOn: istDay(-10) });
check('after the grace days the account expires', x.body.status === 'expired', x.body);
const blocked = await T('/api/v1/leads');
check('an expired account can only open Billing', blocked.status === 402 && blocked.body.code === 'SUBSCRIPTION_EXPIRED', blocked);
check('signing in still works when expired', (await call('/api/v1/auth/login', { tenant: SLUG, method: 'POST', body: { identifier: EMAIL, password: form.password } })).status === 200 && (await T('/api/v1/auth/me')).status === 200);
check('public forms stop for an expired account', (await call(`/public/forms/${SLUG}/anything`)).status === 404);
const cat = await T('/api/v1/billing/catalog');
const order = await T('/api/v1/billing/orders', 'POST', { cycle: 'annual', items: [{ productCode: cat.body.licences[0].code, quantity: 3 }] });
check('an expired account can still order licences', cat.status === 200 && order.status === 201, order.body);
check('admins are told the account is paused', (await inbox()).some((m) => m.To?.[0]?.Address === EMAIL && m.Subject === 'Your UBOS account is paused'));
const paid = await plat(`/orders/${order.body.id}/mark-paid`, 'POST', { paymentRef: 'UTR-TEST-1' });
const afterPay = (await T('/api/v1/auth/me')).body.tenant;
check('paying brings the account back', paid.status === 200 && afterPay.status === 'active' && (await T('/api/v1/leads')).status === 200, afterPay);
await plat('/billing/run', 'POST');
check('a paid account stays active', (await plat('/tenants')).body.find((t) => t.slug === SLUG).status === 'active');
await sub({ endsOn: istDay(1) });
check('paid subscriptions get renewal reminders too', (await notes()).includes('Your UBOS subscription ends in 1 day'), await notes());
check('your own company never expires', (await plat('/tenants')).body.find((t) => t.slug === 'mycompany').status === 'active');

// ---- Usage and audit ----
const pu = await plat(`/tenants/${NEW.id}/usage`);
check('the console sees usage per organization', pu.status === 200 && pu.body.usage.active_users === 1 && pu.body.signedUpVia === 'self_serve', pu.body);
const audit = JSON.stringify((await T('/api/v1/audit-logs')).body);
check('signup and status changes are audited', audit.includes('tenant.signed_up') && audit.includes('billing.status_changed'));
const many = [];
for (let i = 0; i < 6; i++) many.push((await call('/public/v1/signup/code', { method: 'POST', body: { email: `burst-${stamp}@example.com` } })).status);
check('asking for codes is rate limited', many.includes(429), many);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
