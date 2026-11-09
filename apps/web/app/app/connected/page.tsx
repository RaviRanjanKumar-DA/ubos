'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm } from '@/components/Dialogs';

interface Mailbox { id: string; provider: 'google' | 'microsoft'; email: string; status: string; lastSyncAt: string | null; lastError: string | null; stored: number }
interface MailData { providers: { google: boolean; microsoft: boolean }; accounts: Mailbox[] }
interface FbPage { id: string; pageId: string; name: string; status: string; workspaceId: string | null; formRoutes: Record<string, string>; leads: number; lastLeadAt: string | null; lastError: string | null }
interface FbData { configured: boolean; callbackUrl: string; pages: FbPage[] }
interface FbForm { id: string; name: string; status?: string }

const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const NAMES = { google: 'Gmail / Google Workspace', microsoft: 'Outlook / Microsoft 365' };
const RESULT: Record<string, { type: 'error' | 'notice'; text: string }> = {
  MAIL_OK: { type: 'notice', text: 'Your mailbox is connected. Email with your customers will appear on their leads within a few minutes.' },
  FACEBOOK_OK: { type: 'notice', text: 'Facebook is connected. Choose a business line for each page to start receiving leads.' },
  NO_PAGES: { type: 'error', text: 'Facebook did not share any pages. Connect again and tick the pages you manage.' },
  CANCELLED: { type: 'error', text: 'The connection was cancelled.' },
  STATE_INVALID: { type: 'error', text: 'That connection link has expired. Please start again.' },
  FAILED: { type: 'error', text: 'The connection did not complete. Please try again.' },
};

export default function ConnectedPage() {
  const { me, version } = useShell();
  const canFb = me.permissions['integrations.manage'] === 'ORGANIZATION';
  const canMail = !!me.permissions['crm.message.send'];
  const [mail, setMail] = useState<MailData | null>(null);
  const [fb, setFb] = useState<FbData | null>(null);
  const [forms, setForms] = useState<Record<string, FbForm[]>>({});
  const [routes, setRoutes] = useState<Record<string, { workspaceId: string; formRoutes: Record<string, string> }>>({});
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    if (canMail) api<MailData>('/api/v1/connected/mail').then(setMail).catch((e) => setMsg({ type: 'error', text: e.message }));
    if (canFb) api<FbData>('/api/v1/connected/facebook', { noWorkspace: true }).then((d) => { setFb(d); setRoutes((r) => ({ ...Object.fromEntries(d.pages.map((p) => [p.id, { workspaceId: p.workspaceId ?? '', formRoutes: p.formRoutes }])), ...r })); }).catch((e) => setMsg({ type: 'error', text: e.message }));
  }, [canMail, canFb]);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('result');
    if (code && RESULT[code]) { setMsg(RESULT[code]); window.history.replaceState(null, '', '/app/connected'); }
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>, text: string) => {
    setBusy(key); setMsg(null);
    try { await fn(); setMsg({ type: 'notice', text }); load(); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
    setBusy('');
  };
  const go = async (key: string, path: string, noWorkspace?: boolean) => {
    setBusy(key); setMsg(null);
    try { const r = await api<{ url: string }>(path, { method: 'POST', noWorkspace }); window.location.href = r.url; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); setBusy(''); }
  };
  const showForms = (p: FbPage) => api<FbForm[]>(`/api/v1/connected/facebook/pages/${p.id}/forms`, { noWorkspace: true }).then((f) => setForms((x) => ({ ...x, [p.id]: f }))).catch((e) => setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }));
  const connectedTo = (p: 'google' | 'microsoft') => mail?.accounts.find((a) => a.provider === p);

  return (
    <>
      <div className="page-head"><div><h1>Connected accounts</h1><div className="muted small">{canFb ? 'Link your mailbox, and your organization\'s Facebook pages.' : 'Link your mailbox to see customer email on their leads.'}</div></div></div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      {canMail && (
        <section className="card conn-section">
          <h2>My mailbox</h2>
          <p className="small muted">Only email with customers you can already see is copied to their leads. Other mail is never stored. You can also send tracked email from a lead.</p>
          {(['google', 'microsoft'] as const).map((p) => {
            const a = connectedTo(p);
            return (
              <div key={p} className="conn-row">
                <div className="conn-main">
                  <b>{NAMES[p]}</b>
                  {a ? <div className="small muted">{a.email} · {a.stored} {a.stored === 1 ? 'email' : 'emails'} on leads{a.lastSyncAt ? ` · checked ${when(a.lastSyncAt)}` : ''}</div> : mail && !mail.providers[p] && <div className="small muted">Not set up on the server yet.</div>}
                  {a?.lastError && <div className="small conn-err">{a.lastError}</div>}
                </div>
                <div className="row">
                  {a && <span className={`badge ${a.status === 'active' ? 'ok' : 'bad'}`}>{a.status === 'active' ? 'Connected' : 'Reconnect needed'}</span>}
                  {a?.status === 'active' && <button className="btn sm outline" disabled={!!busy} onClick={() => run(a.id, () => api(`/api/v1/connected/mail/${a.id}/sync`, { method: 'POST' }), 'Mailbox checked.')}>Check now</button>}
                  {a && <button className="btn sm ghost" disabled={!!busy} onClick={async () => { if (await askConfirm(`Disconnect ${a.email}? UBOS stops reading and sending from it. Emails already on leads stay.`, 'Disconnect')) run(a.id, () => api(`/api/v1/connected/mail/${a.id}/disconnect`, { method: 'POST' }), 'Mailbox disconnected.'); }}>Disconnect</button>}
                  {(!a || a.status !== 'active') && <button className="btn sm" disabled={!!busy || !mail?.providers[p]} onClick={() => go(p, `/api/v1/connected/mail/${p}/start`)}>{a ? 'Reconnect' : 'Connect'}</button>}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {canFb && (
        <section className="card conn-section">
          <div className="org-head">
            <h2>Facebook &amp; Instagram Lead Ads</h2>
            <button className="btn sm" disabled={!!busy || !fb?.configured} onClick={() => go('fb', '/api/v1/connected/facebook/start', true)}>{fb?.pages.length ? 'Add or refresh pages' : 'Connect Facebook'}</button>
          </div>
          {fb && !fb.configured && <p className="small muted">The Facebook app has not been set up on the server yet.</p>}
          {fb && fb.configured && !fb.pages.length && <p className="small muted">No pages connected yet.</p>}
          {fb?.pages.map((p) => {
            const r = routes[p.id] ?? { workspaceId: '', formRoutes: {} };
            const set = (next: Partial<typeof r>) => setRoutes({ ...routes, [p.id]: { ...r, ...next } });
            return (
              <div key={p.id} className="conn-page">
                <div className="org-head">
                  <div><b>{p.name}</b><div className="small muted">{p.leads} new {p.leads === 1 ? 'lead' : 'leads'}{p.lastLeadAt ? ` · last ${when(p.lastLeadAt)}` : ''}</div></div>
                  <span className={`badge ${p.status === 'active' ? 'ok' : 'warn'}`}>{p.status === 'active' ? 'Receiving leads' : 'Needs a business line'}</span>
                </div>
                {p.lastError && <div className="small conn-err">{p.lastError}</div>}
                <div className="conn-route">
                  <select className="input" aria-label={`Business line for ${p.name}`} value={r.workspaceId} onChange={(e) => set({ workspaceId: e.target.value })}>
                    <option value="">Choose a business line…</option>
                    {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                  <button className="btn sm" disabled={!!busy || !r.workspaceId} onClick={() => run(p.id, () => api(`/api/v1/connected/facebook/pages/${p.id}`, { method: 'PATCH', body: r, noWorkspace: true }), `${p.name} saved.`)}>Save</button>
                  <button className="btn sm outline" onClick={() => showForms(p)}>Route by form</button>
                  <button className="btn sm ghost" disabled={!!busy} onClick={async () => { if (await askConfirm(`Disconnect ${p.name}? New leads stop arriving. Existing leads stay.`, 'Disconnect')) run(p.id, () => api(`/api/v1/connected/facebook/pages/${p.id}/disconnect`, { method: 'POST', noWorkspace: true }), `${p.name} disconnected.`); }}>Disconnect</button>
                </div>
                {forms[p.id]?.map((f) => (
                  <div key={f.id} className="conn-form">
                    <span className="small">{f.name}</span>
                    <select className="input" aria-label={`Business line for form ${f.name}`} value={r.formRoutes[f.id] ?? ''} onChange={(e) => { const m = { ...r.formRoutes }; if (e.target.value) m[f.id] = e.target.value; else delete m[f.id]; set({ formRoutes: m }); }}>
                      <option value="">Same as the page</option>
                      {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </div>
                ))}
                {forms[p.id] && !forms[p.id].length && <p className="small muted">This page has no lead forms.</p>}
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}
