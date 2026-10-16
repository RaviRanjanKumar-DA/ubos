'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [tenant, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const org = tenant.trim().toLowerCase();
      const r = await api<{ accessToken: string }>('/api/v1/auth/login', { method: 'POST', tenant: org, body: { email, password } });
      session.set({ tenant: org, token: r.accessToken, workspaceId: null });
      router.push('/app/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server');
    } finally {
      setBusy(false);
    }
  }

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
        <form className="card" onSubmit={submit}>
          <div className="brand" style={{ padding: '0 0 16px' }}>
            <span className="logo">U</span> UBOS
          </div>
          <h2>Sign in to your organization</h2>
          {error && <div className="error">{error}</div>}
          <div className="field">
            <label htmlFor="org">Organization code</label>
            <input id="org" className="input" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="e.g. mycompany" required />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="pw">Password</label>
            <input id="pw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="small muted" style={{ marginTop: 14 }}>
            Platform staff? <a href="/console/login">Open the Platform Console</a>
          </p>
        </form>
      </div>
    </div>
  );
}
