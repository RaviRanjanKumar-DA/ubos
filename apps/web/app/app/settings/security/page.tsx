'use client';

import { CallingCard, RemindersCard } from '@/components/NotificationSettings';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface Settings {
  sessionIdleMinutes: number;
  ipAllowlist: string[];
  require2faRoles: string[];
  loginMethods: string[];
  allowedEmailDomains: string[];
  maxFailedLogins: number;
  lockMinutes: number;
}
interface Data { settings: Settings; roles: string[]; yourIp: string; providers: { google: boolean; microsoft: boolean } }

const METHODS = [
  { key: 'password', label: 'Email / username / mobile + password' },
  { key: 'google', label: 'Continue with Google (Gmail, Google Workspace)' },
  { key: 'microsoft', label: 'Continue with Microsoft (Outlook, Office 365)' },
  { key: 'email_code', label: 'One-time code sent by email' },
];

const lines = (v: string) => v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export default function SecurityPolicyPage() {
  const [data, setData] = useState<Data | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [ipText, setIpText] = useState('');
  const [domainText, setDomainText] = useState('');
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  useEffect(() => {
    api<Data>('/api/v1/settings/security', { noWorkspace: true })
      .then((d) => {
        setData(d);
        setForm(d.settings);
        setIpText(d.settings.ipAllowlist.join('\n'));
        setDomainText(d.settings.allowedEmailDomains.join('\n'));
      })
      .catch((e) => setMsg({ type: 'error', text: e.message }));
  }, []);

  if (!form || !data) return msg ? <div className="error">{msg.text}</div> : <div className="muted">Loading…</div>;

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const body = { ...form!, ipAllowlist: lines(ipText), allowedEmailDomains: lines(domainText) };
      const { updatedAt: _u, tenantId: _t, ...clean } = body as Settings & { updatedAt?: string; tenantId?: string };
      await api('/api/v1/settings/security', { method: 'PUT', body: clean, noWorkspace: true });
      setMsg({ type: 'notice', text: 'Security policy saved.' });
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof ApiError ? err.message : 'Failed' });
    }
  }

  return (
    <>
    <form onSubmit={save}>
      <div className="page-head">
        <div>
          <h1>Security Policy</h1>
          <div className="muted small">Applies to everyone in your organization. Every change is recorded in the audit log.</div>
        </div>
        <button className="btn">Save policy</button>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h2>Sign-in methods</h2>
          {METHODS.map((m) => {
            const missing = (m.key === 'google' && !data.providers.google) || (m.key === 'microsoft' && !data.providers.microsoft);
            return (
              <label key={m.key} className="row" style={{ marginBottom: 8, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <input type="checkbox" style={{ marginTop: 3, flex: 'none' }} checked={form.loginMethods.includes(m.key)} onChange={() => setForm({ ...form, loginMethods: toggle(form.loginMethods, m.key) })} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {m.label}
                  {missing && <span className="small muted" style={{ display: 'block' }}>Not connected yet: add the OAuth client ID in the server settings (see docs/LOGIN_SETUP.md).</span>}
                </span>
              </label>
            );
          })}
          <div className="field" style={{ marginTop: 10 }}>
            <label>Allowed email domains (Google / Microsoft / email code)</label>
            <textarea className="input" style={{ height: 70, paddingTop: 8 }} value={domainText} onChange={(e) => setDomainText(e.target.value)} placeholder={'company.com\none per line — leave empty to allow any'} />
          </div>
        </div>

        <div className="card">
          <h2>Two-factor authentication</h2>
          <p className="small muted">People with these roles must set up an authenticator app before they can work.</p>
          <div className="row" style={{ gap: 6 }}>
            {data.roles.map((r) => (
              <label key={r} className={`badge ${form.require2faRoles.includes(r) ? '' : 'grey'}`} style={{ cursor: 'pointer' }}>
                <input type="checkbox" style={{ margin: 0 }} checked={form.require2faRoles.includes(r)} onChange={() => setForm({ ...form, require2faRoles: toggle(form.require2faRoles, r) })} />
                {r}
              </label>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>Sessions & lockout</h2>
          <div className="grid cols-3">
            <div className="field"><label>Sign out after idle (minutes)</label><input className="input" type="number" min={5} value={form.sessionIdleMinutes} onChange={(e) => setForm({ ...form, sessionIdleMinutes: Number(e.target.value) })} /></div>
            <div className="field"><label>Lock after failed attempts</label><input className="input" type="number" min={3} max={20} value={form.maxFailedLogins} onChange={(e) => setForm({ ...form, maxFailedLogins: Number(e.target.value) })} /></div>
            <div className="field"><label>Lock for (minutes)</label><input className="input" type="number" min={1} value={form.lockMinutes} onChange={(e) => setForm({ ...form, lockMinutes: Number(e.target.value) })} /></div>
          </div>
        </div>

        <div className="card">
          <h2>IP restriction</h2>
          <p className="small muted">Only allow access from these office networks. Leave empty to allow any network. Your current IP: <code>{data.yourIp}</code></p>
          <textarea className="input" style={{ height: 90, paddingTop: 8 }} value={ipText} onChange={(e) => setIpText(e.target.value)} placeholder={'203.0.113.10\n203.0.113.0/24'} />
        </div>
      </div>
    </form>
    <RemindersCard />
    <CallingCard />
    </>
  );
}
