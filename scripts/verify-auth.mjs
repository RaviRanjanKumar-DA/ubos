// End-to-end checks for Phase 1.1 sign-in & security, against a running API (seeded) and Mailpit.
// Usage: npm run verify:auth   — changes some users (2FA, passwords); run `npm run db:seed` afterwards to reset.
// Includes one ~31 s wait to test refresh-token theft detection.
import { authenticator } from 'otplib';

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
const TENANT = 'mycompany';
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 220)}` : ''}`);
  if (!cond) failures++;
}

/** Minimal browser-like client: keeps cookies, sends the CSRF header like the web app does. */
class Browser {
  jar = new Map();
  async call(path, { method = 'GET', body, csrf = true, bearer, tenant = TENANT, redirect = 'follow', workspace } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (tenant) headers['X-Tenant'] = tenant;
    if (csrf) headers['X-UBOS-CSRF'] = '1';
    if (workspace) headers['X-Workspace'] = workspace;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie && !bearer) headers.Cookie = cookie;
    const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, location: res.headers.get('location') };
  }
}

const adminLogin = async () => {
  const b = new Browser();
  await b.call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'admin@mycompany.local', password: PASSWORD } });
  return b;
};

// ── Sign-in options ──
const methods = await new Browser().call('/api/v1/auth/methods');
check('login page lists sign-in methods for the organization', methods.status === 200 && methods.body.methods.includes('password') && methods.body.methods.includes('email_code'), methods.body);

for (const [label, identifier] of [['email', 'rm@mycompany.local'], ['username', 'arjun'], ['mobile', '98765 11111']]) {
  const b = new Browser();
  const r = await b.call('/api/v1/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
  const me = await b.call('/api/v1/auth/me');
  check(`password login with ${label} sets an httpOnly session cookie`, r.status === 200 && b.jar.has('ubos_at') && me.body.user?.name === 'Arjun (RM)', { r: r.body, me: me.status });
}

const b1 = new Browser();
await b1.call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'arjun', password: PASSWORD } });
const csrf = await b1.call('/api/v1/auth/logout', { method: 'POST', csrf: false });
check('cookie request without CSRF header is blocked', csrf.status === 403 && csrf.body.code === 'CSRF_REJECTED', csrf);

// ── Refresh rotation, theft detection, logout ──
const oldRefresh = b1.jar.get('ubos_rt');
const ref = await b1.call('/api/v1/auth/refresh', { method: 'POST' });
check('refresh rotates the refresh token', ref.status === 200 && b1.jar.get('ubos_rt') !== oldRefresh, ref);
const meAfter = await b1.call('/api/v1/auth/me');
check('new access token works after refresh', meAfter.status === 200);

console.log('…waiting 31 s to test refresh-token theft detection');
await new Promise((r) => setTimeout(r, 31_000));
const thief = new Browser();
thief.jar.set('ubos_rt', oldRefresh);
const stolen = await thief.call('/api/v1/auth/refresh', { method: 'POST' });
check('re-using an old refresh token is rejected', stolen.status === 401, stolen);
const victim = await b1.call('/api/v1/auth/me');
check('…and the whole session is revoked (theft detected)', victim.status === 401 && victim.body.code === 'SESSION_REVOKED', victim);

const b2 = new Browser();
const login2 = await b2.call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'arjun', password: PASSWORD } });
await b2.call('/api/v1/auth/logout', { method: 'POST' });
const afterLogout = await new Browser().call('/api/v1/auth/me', { bearer: login2.body.accessToken });
check('logout ends the session immediately (old access token rejected)', afterLogout.status === 401 && afterLogout.body.code === 'SESSION_REVOKED', afterLogout);

// ── Lockout ──
for (let i = 0; i < 5; i++) {
  await new Browser().call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'rm2@mycompany.local', password: 'wrong-password-1' } });
}
const locked = await new Browser().call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'rm2@mycompany.local', password: PASSWORD } });
check('5 wrong passwords lock the account (even the right password is refused)', locked.status === 423 && locked.body.code === 'ACCOUNT_LOCKED', locked);
const admin = await adminLogin();
const users = await admin.call('/api/v1/audit-logs');
check('lockout is recorded in the audit log', users.body.some?.((l) => l.action === 'auth.account_locked'));

// ── Admin password reset & forced change (also unlocks) ──
const simranId = users.body.find((l) => l.action === 'auth.account_locked')?.entityId;
const reset = await admin.call(`/api/v1/users/${simranId}/reset-password`, { method: 'POST' });
check('admin can reset a password (temporary password shown once)', reset.status === 200 && typeof reset.body.temporaryPassword === 'string', reset);
const simran = new Browser();
const sLogin = await simran.call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'rm2@mycompany.local', password: reset.body.temporaryPassword } });
const blocked = await simran.call('/api/v1/leads');
check('reset unlocks the account and forces a new password before any work', sLogin.status === 200 && sLogin.body.mustChangePassword === true && blocked.body.code === 'PASSWORD_CHANGE_REQUIRED', { sLogin: sLogin.body, blocked: blocked.body });
const weak = await simran.call('/api/v1/auth/password', { method: 'POST', body: { currentPassword: reset.body.temporaryPassword, newPassword: 'short' } });
check('weak passwords are refused', weak.status === 400);
const changed = await simran.call('/api/v1/auth/password', { method: 'POST', body: { currentPassword: reset.body.temporaryPassword, newPassword: PASSWORD + 'x' } });
const simranWs = (await simran.call('/api/v1/auth/me')).body.workspaces?.[0]?.id;
const unblocked = await simran.call('/api/v1/leads', { workspace: simranWs });
check('after changing the password the user can work', changed.status === 200 && unblocked.status === 200, { changed: changed.body, unblocked: unblocked.status });

// ── Email code login (Mailpit) ──
await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
const reqCode = await new Browser().call('/api/v1/auth/email-code/request', { method: 'POST', body: { email: 'auditor@mycompany.local' } });
const unknown = await new Browser().call('/api/v1/auth/email-code/request', { method: 'POST', body: { email: 'nobody@mycompany.local' } });
check('email code request gives the same answer for unknown emails', reqCode.status === 200 && JSON.stringify(reqCode.body) === JSON.stringify(unknown.body));
await new Promise((r) => setTimeout(r, 800));
const inbox = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
const msg = inbox.messages?.find((m) => m.To?.[0]?.Address === 'auditor@mycompany.local');
const code = msg?.Subject?.match(/\d{6}/)?.[0];
check('sign-in code arrives in the local inbox (Mailpit)', !!code, inbox.messages?.map((m) => m.Subject));
const wrong = await new Browser().call('/api/v1/auth/email-code/verify', { method: 'POST', body: { email: 'auditor@mycompany.local', code: code === '000000' ? '111111' : '000000' } });
check('wrong code is rejected', wrong.status === 401);
const eb = new Browser();
const ok = await eb.call('/api/v1/auth/email-code/verify', { method: 'POST', body: { email: 'auditor@mycompany.local', code } });
const eMe = await eb.call('/api/v1/auth/me');
check('correct email code signs the user in', ok.status === 200 && eMe.body.user?.email === 'auditor@mycompany.local', ok.body);
const reuse = await new Browser().call('/api/v1/auth/email-code/verify', { method: 'POST', body: { email: 'auditor@mycompany.local', code } });
check('a code works only once', reuse.status === 401);

// ── Two-factor authentication (TOTP) ──
const nb = new Browser();
await nb.call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'manager@mycompany.local', password: PASSWORD } });
const setup = await nb.call('/api/v1/auth/2fa/setup', { method: 'POST' });
check('2FA setup returns a QR code', setup.status === 200 && String(setup.body.qrDataUrl).startsWith('data:image/png'), setup.status);
const enable = await nb.call('/api/v1/auth/2fa/enable', { method: 'POST', body: { code: authenticator.generate(setup.body.secret) } });
check('2FA can be enabled with a valid authenticator code', enable.status === 200, enable.body);
const step1 = await new Browser().call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'manager@mycompany.local', password: PASSWORD } });
check('password alone is no longer enough (2FA challenge)', step1.body.mfaRequired === true && !!step1.body.mfaToken, step1.body);
const mb = new Browser();
const badMfa = await mb.call('/api/v1/auth/2fa/verify', { method: 'POST', body: { mfaToken: step1.body.mfaToken, code: '000000' } });
const goodMfa = await mb.call('/api/v1/auth/2fa/verify', { method: 'POST', body: { mfaToken: step1.body.mfaToken, code: authenticator.generate(setup.body.secret) } });
check('wrong 2FA code rejected, right code signs in', badMfa.status === 401 && goodMfa.status === 200 && mb.jar.has('ubos_at'), { badMfa: badMfa.status, goodMfa: goodMfa.body });
const disable = await mb.call('/api/v1/auth/2fa/disable', { method: 'POST', body: { code: authenticator.generate(setup.body.secret) } });
check('2FA can be switched off again with a code', disable.status === 200);

// ── Organization security policy ──
const sec = await admin.call('/api/v1/settings/security');
check('admin reads the security policy', sec.status === 200 && Array.isArray(sec.body.roles), sec.status);
const original = sec.body.settings;
const base = {
  sessionIdleMinutes: original.sessionIdleMinutes, ipAllowlist: original.ipAllowlist, require2faRoles: original.require2faRoles,
  loginMethods: original.loginMethods, allowedEmailDomains: original.allowedEmailDomains,
  maxFailedLogins: original.maxFailedLogins, lockMinutes: original.lockMinutes,
};
const lockout = await admin.call('/api/v1/settings/security', { method: 'PUT', body: { ...base, ipAllowlist: ['203.0.113.0/24'] } });
check('IP allow-list that would lock the admin out is refused', lockout.status === 400 && lockout.body.code === 'WOULD_LOCK_YOU_OUT', lockout.body);

await admin.call('/api/v1/settings/security', { method: 'PUT', body: { ...base, require2faRoles: ['RM'] } });
const rmB = new Browser();
await rmB.call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'arjun', password: PASSWORD } });
const rmWork = await rmB.call('/api/v1/leads');
const rmMe = await rmB.call('/api/v1/auth/me');
check('policy "2FA required for RM" forces setup before any work', rmWork.body.code === 'MFA_SETUP_REQUIRED' && rmMe.body.security?.mfaSetupRequired === true, rmWork.body);

await admin.call('/api/v1/settings/security', { method: 'PUT', body: { ...base, require2faRoles: [], loginMethods: ['email_code'] } });
const pwOff = await new Browser().call('/api/v1/auth/login', { method: 'POST', body: { identifier: 'arjun', password: PASSWORD } });
check('a disabled sign-in method is refused', pwOff.status === 403 && pwOff.body.code === 'LOGIN_METHOD_DISABLED', pwOff.body);
const restore = await admin.call('/api/v1/settings/security', { method: 'PUT', body: base });
check('policy restored', restore.status === 200);

const rmPolicy = await rmB.call('/api/v1/settings/security');
check('RM cannot read or change the security policy', rmPolicy.status === 403);

// ── Google / Microsoft ──
const g = await new Browser().call(`/oauth/google/start?tenant=${TENANT}`, { redirect: 'manual', tenant: null });
const configured = sec.body.providers?.google;
check(
  configured ? 'Google sign-in redirects to Google' : 'Google sign-in without client ID returns to login with a clear error',
  g.status === 302 && (configured ? g.location.startsWith('https://accounts.google.com/') : g.location.includes('error=PROVIDER_NOT_CONFIGURED')),
  g.location,
);

// ── Platform Console sessions ──
const pb = new Browser();
const pl = await pb.call('/platform/v1/auth/login', { method: 'POST', body: { email: 'owner@ubos.local', password: PASSWORD }, tenant: null });
const pt = await pb.call('/platform/v1/tenants', { tenant: null });
check('platform login uses its own session cookie', pl.status === 200 && pb.jar.has('ubos_pat') && pt.status === 200, pl.body);
const crossCookie = new Browser();
crossCookie.jar.set('ubos_pat', admin.jar.get('ubos_at'));
const cc = await crossCookie.call('/platform/v1/tenants', { tenant: null });
check('a tenant session cookie cannot open the Platform Console', cc.status === 401, cc.status);
await pb.call('/platform/v1/auth/logout', { method: 'POST', tenant: null });
const pAfter = await new Browser().call('/platform/v1/tenants', { bearer: pl.body.accessToken, tenant: null });
check('platform logout ends the session', pAfter.status === 401);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
