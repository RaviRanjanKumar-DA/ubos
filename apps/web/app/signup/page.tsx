'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';
import { BusinessLinePicker, type PickedLine } from '@/components/console/BusinessLinePicker';

interface Config { enabled: boolean; trialDays: number; licences: number; plan: string | null; maxBusinessLines: number | null }
const toSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export default function SignupPage() {
  const router = useRouter();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [step, setStep] = useState<'email' | 'details'>('email');
  const [email, setEmail] = useState('');
  const [f, setF] = useState({ code: '', name: '', orgName: '', slug: '', password: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugState, setSlugState] = useState<{ available: boolean; reason?: string } | null>(null);
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const full = { width: '100%', justifyContent: 'center' } as const;

  useEffect(() => { api<Config>('/public/v1/signup/config', { tenant: '' }).then(setCfg).catch(() => setCfg({ enabled: false, trialDays: 14, licences: 5, plan: null, maxBusinessLines: null })); }, []);
  useEffect(() => {
    if (!f.slug) return setSlugState(null);
    const t = setTimeout(() => { api<{ available: boolean; reason?: string }>(`/public/v1/signup/slug?slug=${encodeURIComponent(f.slug)}`, { tenant: '' }).then(setSlugState).catch(() => setSlugState(null)); }, 300);
    return () => clearTimeout(t);
  }, [f.slug]);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.'); } setBusy(false); };
  const sendCode = (e: React.FormEvent) => { e.preventDefault(); run(async () => { await api('/public/v1/signup/code', { method: 'POST', tenant: '', body: { email } }); setStep('details'); }); };
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!lines.length) return setError('Pick at least one business line');
    run(async () => {
      const r = await api<{ slug: string }>('/public/v1/signup', { method: 'POST', tenant: '', body: { email, ...f, businessLines: lines } });
      await api('/api/v1/auth/login', { method: 'POST', tenant: r.slug, body: { identifier: email, password: f.password } });
      session.set({ tenant: r.slug, workspaceId: null });
      router.push('/app/setup');
    });
  };

  return (
    <div className="auth">
      <div className="pitch">
        <h1>Start your free trial</h1>
        <ul>
          <li>{cfg?.trialDays ?? 14} days free, up to {cfg?.licences ?? 5} users</li>
          <li>Leads, calling, WhatsApp, HR and finance in one place</li>
          <li>No card needed. Choose licences when you are ready.</li>
        </ul>
      </div>
      <div className="form">
        <div className="card" style={{ maxWidth: 440 }}>
          {cfg && !cfg.enabled && (
            <>
              <h2>Sign-up is closed right now</h2>
              <p className="small muted">Contact us and we will set up your organization.</p>
            </>
          )}
          {cfg?.enabled && step === 'email' && (
            <form onSubmit={sendCode}>
              <h2>Create your organization</h2>
              <p className="small muted" style={{ marginTop: 0 }}>We will email you a 6-digit code to confirm it is you.</p>
              {error && <div className="error">{error}</div>}
              <div className="field"><label htmlFor="su-e">Work email</label><input id="su-e" className="input" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
              <button className="btn" style={full} disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
            </form>
          )}
          {cfg?.enabled && step === 'details' && (
            <form onSubmit={create}>
              <h2 style={{ marginBottom: 2 }}>Almost there</h2>
              <p className="small muted" style={{ marginTop: 0 }}>Code sent to {email} · <a href="#" onClick={(e) => { e.preventDefault(); setStep('email'); setError(''); }}>change</a></p>
              {error && <div className="error">{error}</div>}
              <div className="field"><label htmlFor="su-c">6-digit code</label><input id="su-c" className="input" inputMode="numeric" maxLength={6} required autoFocus value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} /></div>
              <div className="field"><label htmlFor="su-n">Your name</label><input id="su-n" className="input" required minLength={2} maxLength={80} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="su-o">Organization name</label><input id="su-o" className="input" required minLength={2} maxLength={100} value={f.orgName} onChange={(e) => setF({ ...f, orgName: e.target.value, slug: slugTouched ? f.slug : toSlug(e.target.value) })} /></div>
              <div className="field">
                <label htmlFor="su-s">Organization code</label>
                <input id="su-s" className="input" required minLength={3} maxLength={40} value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: toSlug(e.target.value) }); }} />
                <span className={`small ${slugState && !slugState.available ? 'kpi-bad' : 'muted'}`}>{slugState ? (slugState.available ? 'Available. Your team signs in with this code.' : slugState.reason) : 'Your team signs in with this code.'}</span>
              </div>
              <div className="field">
                <label>Business lines</label>
                <BusinessLinePicker value={lines} onChange={setLines} max={cfg.maxBusinessLines ?? 5} />
                <span className="small muted">Each one gets its own pipeline. You can add more later.</span>
              </div>
              <div className="field"><label htmlFor="su-p">Password</label><input id="su-p" className="input" type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /><span className="small muted">At least 10 characters, with letters and numbers.</span></div>
              <button className="btn" style={full} disabled={busy || (slugState !== null && !slugState.available)}>{busy ? 'Creating…' : `Start ${cfg.trialDays}-day trial`}</button>
            </form>
          )}
          <p className="small muted" style={{ marginTop: 16 }}>Already using UBOS? <Link href="/login">Sign in</Link></p>
        </div>
      </div>
    </div>
  );
}
