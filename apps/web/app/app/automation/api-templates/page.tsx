'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_METHODS, API_PLACEHOLDERS } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';
import { PickWorkspace } from '@/components/PickWorkspace';

interface Tpl { id: string; name: string; method: string; url: string; body: string | null; workspaceId: string | null; headerNames: string[]; lastStatus: number | null; lastCalledAt: string | null }
type Draft = { id: string | null; name: string; method: string; url: string; body: string; allLines: boolean; headers: { k: string; v: string }[]; keepHeaders: boolean };
const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

/** Saved outgoing calls with placeholders, used by the "Call an API" step in rules and flows. */
export default function ApiTemplates() {
  const { me, can, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [rows, setRows] = useState<Tpl[] | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [test, setTest] = useState<{ status: number; ok: boolean; ms: number; body: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const manage = can('crm.automation.manage');
  const load = useCallback(() => api<Tpl[]>('/api/v1/automation/api-templates').then(setRows).catch((e) => setMsg({ type: 'error', text: e.message })), []);
  useEffect(() => { if (ws) load(); }, [load, ws, version]);
  if (!ws) return <><div className="page-head"><h1>API templates</h1></div><PickWorkspace text="API templates belong to a business line." /></>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!d) return;
    setMsg(null);
    const headers = Object.fromEntries(d.headers.filter((h) => h.k.trim()).map((h) => [h.k.trim(), h.v]));
    try {
      await api(d.id ? `/api/v1/automation/api-templates/${d.id}` : '/api/v1/automation/api-templates', { method: d.id ? 'PUT' : 'POST', body: { name: d.name, method: d.method, url: d.url, body: d.body || null, headers, keepHeaders: d.keepHeaders, ...(d.id ? {} : { workspaceId: d.allLines ? null : ws }) } });
      setD(null); setMsg({ type: 'notice', text: 'API template saved.' }); load();
    } catch (x) { setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }); }
  };
  const runTest = async (t: Tpl) => {
    setTest(null); setMsg(null);
    try { setTest(await api(`/api/v1/automation/api-templates/${t.id}/test`, { method: 'POST', body: {} })); load(); } catch (x) { setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>API templates</h1><div className="muted small">Call another system (your website, a sheet, a payment or SMS service) from a rule or flow, with lead details filled in.</div></div>
        {manage && <button className="btn" onClick={() => setD({ id: null, name: '', method: 'POST', url: 'https://', body: '{\n  "name": "{lead.name}",\n  "mobile": "{lead.mobile}"\n}', allLines: false, headers: [{ k: 'Content-Type', v: 'application/json' }], keepHeaders: false })}><Icon name="plus" className="ic" />New API template</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {test && <div className={test.ok ? 'notice' : 'error'}>Answered {test.status} in {test.ms} ms{test.body ? `: ${test.body.slice(0, 200)}` : ''}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Template</th><th>Address</th><th>Last call</th><th /></tr></thead>
            <tbody>
              {rows?.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.name}</b><div className="small muted">{t.workspaceId ? 'This business line' : 'Every business line'}{t.headerNames.length ? ` · headers: ${t.headerNames.join(', ')}` : ''}</div></td>
                  <td className="small" style={{ overflowWrap: 'anywhere' }}><span className="badge grey">{t.method}</span> {t.url}</td>
                  <td className="small">{t.lastCalledAt ? <><span className={`badge ${t.lastStatus && t.lastStatus < 300 ? 'ok' : 'bad'}`}>{t.lastStatus || 'failed'}</span> {when(t.lastCalledAt)}</> : '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{manage && <>
                    <button className="btn ghost sm" onClick={() => runTest(t)}>Test</button>
                    <button className="btn ghost sm" onClick={() => setD({ id: t.id, name: t.name, method: t.method, url: t.url, body: t.body ?? '', allLines: !t.workspaceId, headers: [], keepHeaders: true })}>Edit</button>
                    <button className="btn ghost sm" onClick={async () => { if (await askConfirm(`Archive "${t.name}"? Rules and flows using it will fail until changed.`)) { await api(`/api/v1/automation/api-templates/${t.id}/archive`, { method: 'POST' }); load(); } }}>Archive</button>
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && !rows.length && <div className="empty">No API templates yet.</div>}
        </div>
      </div>

      {d && (
        <div className="modal-bg">
          <form className="modal hr-modal" onSubmit={save}>
            <h2>{d.id ? 'Edit API template' : 'New API template'}</h2>
            <div className="field"><label htmlFor="at-n">Name</label><input id="at-n" className="input" required minLength={2} maxLength={80} placeholder="e.g. Send lead to website CRM" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
            <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
              <select className="input" style={{ maxWidth: 110 }} aria-label="Method" value={d.method} onChange={(e) => setD({ ...d, method: e.target.value })}>{API_METHODS.map((m) => <option key={m}>{m}</option>)}</select>
              <input className="input" aria-label="Address" required value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://example.com/hook?mobile={lead.mobile}" />
            </div>
            <div className="field" style={{ marginTop: 10 }}><label>Headers <span className="small muted">(saved encrypted; never shown again)</span></label>
              {d.id && d.keepHeaders ? <div className="row small" style={{ gap: 8 }}>Saved headers are kept. <button type="button" className="btn ghost sm" onClick={() => setD({ ...d, keepHeaders: false, headers: [{ k: '', v: '' }] })}>Replace them</button></div> : (
                <>
                  {d.headers.map((h, i) => (
                    <div key={i} className="row" style={{ flexWrap: 'nowrap', gap: 6, marginBottom: 6 }}>
                      <input className="input" aria-label="Header name" placeholder="Authorization" value={h.k} onChange={(e) => setD({ ...d, headers: d.headers.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) })} />
                      <input className="input" aria-label="Header value" placeholder="Bearer …" value={h.v} onChange={(e) => setD({ ...d, headers: d.headers.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)) })} />
                      <button type="button" className="btn ghost sm" aria-label="Remove header" onClick={() => setD({ ...d, headers: d.headers.filter((_, j) => j !== i) })}><Icon name="close" className="ic" /></button>
                    </div>
                  ))}
                  <button type="button" className="btn ghost sm" onClick={() => setD({ ...d, headers: [...d.headers, { k: '', v: '' }] })}>+ Header</button>
                </>
              )}
            </div>
            {d.method !== 'GET' && <div className="field"><label htmlFor="at-b">Body</label><textarea id="at-b" className="input" style={{ height: 130, paddingTop: 8, fontFamily: 'monospace', fontSize: 13 }} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} /></div>}
            <p className="small muted" style={{ marginTop: 0 }}>Placeholders: {API_PLACEHOLDERS.map(([k]) => `{${k}}`).join(' ')}</p>
            {!d.id && <label className="row small" style={{ gap: 8, marginBottom: 10 }}><input type="checkbox" checked={d.allLines} onChange={(e) => setD({ ...d, allLines: e.target.checked })} />Use in every business line (needs organization-wide automation rights)</label>}
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setD(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
