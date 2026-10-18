'use client';

import { MyNotificationsCard } from '@/components/NotificationSettings';
import { AvailabilityCard } from '@/components/deals/AvailabilityCard';
import { MyPhoneCard } from '@/components/calls/MyPhone';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Sess { id: string; userAgent: string | null; ip: string | null; createdAt: string; lastUsedAt: string; current: boolean }

function device(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node/i.test(ua) ? 'Script / API' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function SecurityInner() {
  const { me } = useShell();
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [setup, setSetup] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  const loadSessions = () => api<Sess[]>('/api/v1/auth/sessions', { noWorkspace: true }).then(setSessions).catch(() => {});
  useEffect(() => { loadSessions(); }, []);

  const act = async (fn: () => Promise<unknown>, success: string, reload = false) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ type: 'notice', text: success });
      if (reload) setTimeout(() => window.location.assign('/app/security'), 900);
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
    }
  };

  function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pw.newPassword !== pw.confirm) return setMsg({ type: 'error', text: 'New passwords do not match' });
    act(() => api('/api/v1/auth/password', { method: 'POST', body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword }, noWorkspace: true }),
      'Password changed. Other devices were signed out.', me.security.mustChangePassword);
    setPw({ currentPassword: '', newPassword: '', confirm: '' });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Security</h1>
          <div className="muted small">{me.user.email}</div>
        </div>
      </div>
      {me.security.mustChangePassword && <div className="notice">Your administrator set a temporary password. Please choose your own password to continue.</div>}
      {me.security.mfaSetupRequired && <div className="notice">Your organization requires two-factor authentication for your role. Please set it up to continue.</div>}
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <form className="card" onSubmit={changePassword}>
          <h2>Change password</h2>
          <div className="field"><label>Current password</label><input className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /></div>
          <div className="field"><label>New password</label><input className="input" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required minLength={10} /></div>
          <div className="field"><label>Confirm new password</label><input className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></div>
          <p className="small muted">At least 10 characters, with letters and numbers.</p>
          <button className="btn">Update password</button>
        </form>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Two-factor authentication</h2>
            {me.security.totpEnabled ? <span className="badge ok"><span className="dot" />On</span> : <span className="badge grey">Off</span>}
          </div>
          <p className="small muted">Use Google Authenticator, Microsoft Authenticator or any TOTP app. You will enter a 6-digit code after your password.</p>
          {!me.security.totpEnabled && !setup && (
            <button className="btn" onClick={() => act(async () => setSetup(await api('/api/v1/auth/2fa/setup', { method: 'POST', noWorkspace: true })), 'Scan the QR code with your app')}>
              Set up two-factor
            </button>
          )}
          {setup && (
            <form onSubmit={(e) => { e.preventDefault(); act(() => api('/api/v1/auth/2fa/enable', { method: 'POST', body: { code }, noWorkspace: true }), 'Two-factor authentication is on.', true); }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={setup.qrDataUrl} alt="QR code for your authenticator app" width={180} height={180} />
              <p className="small muted" style={{ overflowWrap: 'anywhere' }}>Can't scan? Enter this key: <code>{setup.secret}</code></p>
              <div className="field"><label>Code from the app</label><input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /></div>
              <button className="btn">Turn on</button>
            </form>
          )}
          {me.security.totpEnabled && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); act(() => api('/api/v1/auth/2fa/disable', { method: 'POST', body: { code }, noWorkspace: true }), 'Two-factor authentication is off.', true); }}>
              <input className="input" style={{ width: 140 }} placeholder="6-digit code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
              <button className="btn danger">Turn off</button>
            </form>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 0, marginTop: 14 }}>
        <div style={{ padding: '14px 16px 4px' }}><h2>Signed-in devices</h2></div>
        <table className="table">
          <thead><tr><th>Device</th><th>IP</th><th>Last active</th><th /></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{device(s.userAgent)} {s.current && <span className="badge ok" style={{ marginLeft: 6 }}>This device</span>}</td>
                <td className="muted">{s.ip}</td>
                <td className="small">{new Date(s.lastUsedAt).toLocaleString('en-IN')}</td>
                <td style={{ textAlign: 'right' }}>
                  {!s.current && (
                    <button className="btn sm danger" onClick={() => act(() => api(`/api/v1/auth/sessions/${s.id}`, { method: 'DELETE', noWorkspace: true }).then(loadSessions), 'Device signed out.')}>
                      Sign out
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MyNotificationsCard />
      <AvailabilityCard />
      <MyPhoneCard />
    </>
  );
}

export default function SecurityPage() {
  return (
    <Suspense fallback={null}>
      <SecurityInner />
    </Suspense>
  );
}
