'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, API_URL, ApiError, LOGIN_ERRORS, session } from '@/lib/api';

type Step = 'org' | 'signin' | 'code' | 'mfa';
type LoginResponse = { mfaRequired: boolean; mfaToken?: string; mustChangePassword?: boolean };

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 23 23" aria-hidden="true">
      <path fill="#f35325" d="M1 1h10v10H1z" /><path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" /><path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>('org');
  const [org, setOrg] = useState('');
  const [orgName, setOrgName] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const err = params.get('error');
    if (err) setError(LOGIN_ERRORS[err] ?? 'Sign-in failed. Please try again.');
    const o = params.get('org') ?? session.lastOrg();
    if (o) {
      setOrg(o);
      if (params.get('org')) loadMethods(o);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server');
    } finally {
      setBusy(false);
    }
  }

  function loadMethods(slug = org) {
    return run(async () => {
      const o = slug.trim().toLowerCase();
      const r = await api<{ organization: string; methods: string[] }>('/api/v1/auth/methods', { tenant: o });
      setOrg(o);
      setOrgName(r.organization);
      setMethods(r.methods);
      setStep('signin');
    });
  }

  function done(r: LoginResponse) {
    if (r.mfaRequired && r.mfaToken) {
      setMfaToken(r.mfaToken);
      setCode('');
      setStep('mfa');
      return;
    }
    session.set({ tenant: org, workspaceId: null });
    router.push(r.mustChangePassword ? '/app/security?reason=password' : '/app/dashboard');
  }

  const passwordLogin = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => done(await api<LoginResponse>('/api/v1/auth/login', { method: 'POST', tenant: org, body: { identifier, password } })));
  };
  const requestCode = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ message: string }>('/api/v1/auth/email-code/request', { method: 'POST', tenant: org, body: { email } });
      setNotice(r.message);
      setCode('');
    });
  };
  const verifyCode = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => done(await api<LoginResponse>('/api/v1/auth/email-code/verify', { method: 'POST', tenant: org, body: { email, code } })));
  };
  const verifyMfa = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => done(await api<LoginResponse>('/api/v1/auth/2fa/verify', { method: 'POST', tenant: org, body: { mfaToken, code } })));
  };
  const sso = (provider: 'google' | 'microsoft') => {
    window.location.href = `${API_URL}/oauth/${provider}/start?tenant=${encodeURIComponent(org)}`;
  };

  const full = { width: '100%', justifyContent: 'center' } as const;

  return (
    <div className="card">
      <div className="brand" style={{ padding: '0 0 16px' }}><span className="logo">U</span> UBOS</div>
      {error && <div className="error">{error}</div>}

      {step === 'org' && (
        <form onSubmit={(e) => { e.preventDefault(); loadMethods(); }}>
          <h2>Sign in to your organization</h2>
          <div className="field">
            <label htmlFor="org">Organization code</label>
            <input id="org" className="input" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="e.g. mycompany" required autoFocus />
          </div>
          <button className="btn" style={full} disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
        </form>
      )}

      {step === 'signin' && (
        <>
          <h2 style={{ marginBottom: 2 }}>{orgName}</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            {org} · <a href="#" onClick={(e) => { e.preventDefault(); setStep('org'); setError(''); }}>change</a>
          </p>
          {(methods.includes('google') || methods.includes('microsoft')) && (
            <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
              {methods.includes('google') && (
                <button type="button" className="btn outline" style={{ ...full, color: 'var(--ink)' }} onClick={() => sso('google')}>
                  <GoogleLogo /> Continue with Google
                </button>
              )}
              {methods.includes('microsoft') && (
                <button type="button" className="btn outline" style={{ ...full, color: 'var(--ink)' }} onClick={() => sso('microsoft')}>
                  <MicrosoftLogo /> Continue with Microsoft
                </button>
              )}
            </div>
          )}
          {methods.includes('password') && (
            <form onSubmit={passwordLogin}>
              <div className="field">
                <label htmlFor="id">Email, username or mobile</label>
                <input id="id" className="input" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required autoFocus />
              </div>
              <div className="field">
                <label htmlFor="pw">Password</label>
                <input id="pw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </div>
              <button className="btn" style={full} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            </form>
          )}
          {methods.includes('email_code') && (
            <button type="button" className="btn ghost" style={{ ...full, marginTop: 8 }} onClick={() => { setStep('code'); setNotice(''); setError(''); }}>
              Email me a sign-in code instead
            </button>
          )}
        </>
      )}

      {step === 'code' && (
        <>
          <h2>Sign in with an email code</h2>
          {notice && <div className="notice">{notice}</div>}
          <form onSubmit={notice ? verifyCode : requestCode}>
            <div className="field">
              <label htmlFor="em">Work email</label>
              <input id="em" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!notice} />
            </div>
            {notice && (
              <div className="field">
                <label htmlFor="cd">6-digit code</label>
                <input id="cd" className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
              </div>
            )}
            <button className="btn" style={full} disabled={busy}>{notice ? 'Verify and sign in' : 'Send code'}</button>
          </form>
          <button type="button" className="btn ghost" style={{ ...full, marginTop: 8 }} onClick={() => setStep('signin')}>Back</button>
        </>
      )}

      {step === 'mfa' && (
        <form onSubmit={verifyMfa}>
          <h2>Two-factor verification</h2>
          <p className="small muted">Enter the 6-digit code from your authenticator app.</p>
          <div className="field">
            <label htmlFor="mfa">Authenticator code</label>
            <input id="mfa" className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
          </div>
          <button className="btn" style={full} disabled={busy}>Verify</button>
        </form>
      )}

      <p className="small muted" style={{ marginTop: 16 }}>
        New to UBOS? <a href="/signup">Start a free trial</a> · Platform staff? <a href="/console/login">Open the Platform Console</a>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="auth">
      <div className="pitch">
        <h1>One system for your whole business</h1>
        <ul>
          <li>Leads, calling and WhatsApp in one place</li>
          <li>Separate workspaces for every business line</li>
          <li>HR, finance, incentives and audit built in</li>
        </ul>
      </div>
      <div className="form">
        <div style={{ width: '100%', maxWidth: 380 }}>
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
