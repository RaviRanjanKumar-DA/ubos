'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, platformApi, platformSession } from '@/lib/api';

export default function ConsoleLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await platformApi<{ accessToken: string; user: { name: string } }>('/platform/v1/auth/login', {
        method: 'POST', body: { email, password },
      });
      platformSession.set({ token: r.accessToken, name: r.user.name });
      router.push('/console');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server');
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="pitch">
        <h1>UBOS Platform Console</h1>
        <ul>
          <li>Every customer organization in one place</li>
          <li>Plans, subscriptions and revenue</li>
          <li>Onboard, suspend and support tenants</li>
        </ul>
      </div>
      <div className="form">
        <form className="card" onSubmit={submit}>
          <div className="brand" style={{ padding: '0 0 16px' }}><span className="logo">U</span> Platform Console</div>
          {error && <div className="error">{error}</div>}
          <div className="field"><label htmlFor="e">Email</label><input id="e" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="p">Password</label><input id="p" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          <button className="btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="small muted" style={{ marginTop: 14 }}><a href="/login">Organization sign-in</a></p>
        </form>
      </div>
    </div>
  );
}
