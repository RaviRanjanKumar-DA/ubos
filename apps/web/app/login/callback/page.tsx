'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';

/** Landing page after "Continue with Google / Microsoft". The API has already set the session cookie. */
function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  const [mfaToken, setMfaToken] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const org = params.get('org') ?? '';

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('mfa');
    history.replaceState(null, '', window.location.pathname + window.location.search); // drop the token from the address bar
    if (token) setMfaToken(token);
    else {
      session.set({ tenant: org, workspaceId: null });
      router.replace('/app/dashboard');
    }
  }, [org, router]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ mustChangePassword?: boolean }>('/api/v1/auth/2fa/verify', { method: 'POST', tenant: org, body: { mfaToken, code } });
      session.set({ tenant: org, workspaceId: null });
      router.replace(r.mustChangePassword ? '/app/security?reason=password' : '/app/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed');
    }
  }

  if (!mfaToken) return <p className="muted">Signing you in…</p>;
  return (
    <form className="card" onSubmit={verify} style={{ maxWidth: 380, width: '100%' }}>
      <h2>Two-factor verification</h2>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label htmlFor="mfa">Authenticator code</label>
        <input id="mfa" className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
      </div>
      <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>Verify</button>
    </form>
  );
}

export default function CallbackPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Suspense fallback={null}>
        <Callback />
      </Suspense>
    </div>
  );
}
