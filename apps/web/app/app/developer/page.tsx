'use client';

import { Icon } from '@/components/Icon';
import { askConfirm } from '@/components/Dialogs';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Key { id: string; name: string; prefix: string; scopes: string[]; workspaceId: string | null; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }
interface Hook { id: string; name: string; url: string; events: string[]; workspaceId: string | null; isActive: boolean; failureCount: number; lastDeliveryAt: string | null; lastStatus: number | null; last7Days: Record<string, number> }
interface Delivery { id: string; event: string; status: string; attempts: number; responseStatus: number | null; error: string | null; createdAt: string; deliveredAt: string | null; nextAttemptAt: string; payload: unknown }
type Tab = 'keys' | 'hooks' | 'docs';
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Settings → Developer: API keys, outgoing webhooks and a short API reference. */
export default function DeveloperPage() {
  const { me } = useShell();
  const [tab, setTab] = useState<Tab>('keys');
  const [keys, setKeys] = useState<{ scopes: { value: string; label: string }[]; baseUrl: string; keys: Key[] } | null>(null);
  const [hooks, setHooks] = useState<{ events: { value: string; label: string }[]; webhooks: Hook[] } | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(async () => {
    const [k, h] = await Promise.all([
      api<typeof keys>('/api/v1/api-keys', { noWorkspace: true }).catch(() => null),
      api<typeof hooks>('/api/v1/webhooks', { noWorkspace: true }).catch(() => null),
    ]);
    setKeys(k); setHooks(h);
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  };
  const wsName = (id: string | null) => (id ? me.workspaces.find((w) => w.id === id)?.name ?? 'One business line' : 'All business lines');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Developer</h1>
          <p className="muted small" style={{ margin: 0 }}>Connect your own systems: API keys for the public API, and webhooks that tell other systems when something happens in UBOS.</p>
        </div>
      </div>
      <div className="dash-tabs" role="tablist">
        {([['keys', 'API keys'], ['hooks', 'Outgoing webhooks'], ['docs', 'API reference']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`dash-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {secret && (
        <div className="card secret-card">
          <b>{secret.title}</b>
          <p className="small" style={{ margin: '4px 0 8px' }}>Copy it now — it is shown only once. UBOS keeps only a fingerprint.</p>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <code className="webhook">{secret.value}</code>
            <button className="btn sm outline" onClick={() => navigator.clipboard?.writeText(secret.value)}>Copy</button>
            <button className="btn sm ghost" onClick={() => setSecret(null)}>Done</button>
          </div>
        </div>
      )}
      {tab === 'keys' && keys && <Keys data={keys} wsName={wsName} act={act} onSecret={setSecret} />}
      {tab === 'hooks' && hooks && <Hooks data={hooks} wsName={wsName} act={act} onSecret={setSecret} />}
      {tab === 'docs' && <Docs baseUrl={keys?.baseUrl ?? 'http://localhost:4000/public/v1'} />}
      {!keys && !hooks && <div className="card muted">Only organization admins with developer access can manage API keys and webhooks.</div>}
    </>
  );
}

type Act = (fn: () => Promise<unknown>, text: string) => Promise<boolean>;

function Keys({ data, wsName, act, onSecret }: { data: { scopes: { value: string; label: string }[]; keys: Key[] }; wsName: (id: string | null) => string; act: Act; onSecret: (s: { title: string; value: string }) => void }) {
  const { me } = useShell();
  const [form, setForm] = useState<{ name: string; scopes: string[]; workspaceId: string; expiresAt: string } | null>(null);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>API keys</h2>
        <button className="btn sm" onClick={() => setForm({ name: '', scopes: ['leads:write'], workspaceId: '', expiresAt: '' })}>+ New API key</button>
      </div>
      {form && (
        <form className="run-card" style={{ marginTop: 10 }} onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            const r = await api<{ key: string; name: string }>('/api/v1/api-keys', { method: 'POST', noWorkspace: true, body: { name: form.name, scopes: form.scopes, workspaceId: form.workspaceId || null, expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:00`).toISOString() : null } });
            onSecret({ title: `API key “${r.name}”`, value: r.key });
            setForm(null);
          }, 'API key created.');
        }}>
          <div className="grid cols-3">
            <div className="field"><label>Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} placeholder="e.g. Website backend" /></div>
            <div className="field"><label>Business line</label>
              <select className="input" value={form.workspaceId} onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}>
                <option value="">All business lines</option>{me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Expires (optional)</label><input className="input" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></div>
          </div>
          <div className="field"><label>What it may do</label>
            <div className="chips">{data.scopes.map((s) => <button type="button" key={s.value} title={s.label} className={`chip ${form.scopes.includes(s.value) ? 'on' : ''}`} onClick={() => setForm({ ...form, scopes: form.scopes.includes(s.value) ? form.scopes.filter((x) => x !== s.value) : [...form.scopes, s.value] })}>{s.value}</button>)}</div>
            <div className="small muted" style={{ marginTop: 4 }}>{data.scopes.filter((s) => form.scopes.includes(s.value)).map((s) => s.label).join(' · ')}</div>
          </div>
          <div className="row end"><button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancel</button><button className="btn" disabled={!form.scopes.length}>Create key</button></div>
        </form>
      )}
      {!data.keys.length && !form && <p className="small muted">No API keys yet. Create one for each system that sends leads to UBOS or reads them.</p>}
      {data.keys.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Business line</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k.id} style={k.revokedAt ? { opacity: 0.5 } : undefined}>
                  <td><b>{k.name}</b><div className="small muted">Created {when(k.createdAt)}{k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}</div></td>
                  <td><code>{k.prefix}…</code></td>
                  <td className="small">{k.scopes.join(', ')}</td>
                  <td className="small">{wsName(k.workspaceId)}</td>
                  <td className="small">{when(k.lastUsedAt)}</td>
                  <td>{k.revokedAt ? <span className="badge grey">Revoked</span> : <button className="btn sm ghost" onClick={async () => { if (await askConfirm(`Revoke “${k.name}”? Systems using it stop working at once.`)) act(() => api(`/api/v1/api-keys/${k.id}/revoke`, { method: 'POST', noWorkspace: true }), 'Key revoked.'); }}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Hooks({ data, wsName, act, onSecret }: { data: { events: { value: string; label: string }[]; webhooks: Hook[] }; wsName: (id: string | null) => string; act: Act; onSecret: (s: { title: string; value: string }) => void }) {
  const { me } = useShell();
  const [form, setForm] = useState<{ id?: string; name: string; url: string; events: string[]; workspaceId: string } | null>(null);
  const [log, setLog] = useState<{ hook: Hook; rows: Delivery[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const openLog = async (h: Hook) => setLog({ hook: h, rows: await api<Delivery[]>(`/api/v1/webhooks/${h.id}/deliveries`, { noWorkspace: true }).catch(() => []) });
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h2 style={{ margin: 0 }}>Outgoing webhooks</h2><p className="small muted" style={{ margin: '4px 0 0' }}>UBOS posts JSON to your URL when these things happen. Each call is signed (header X-UBOS-Signature) and retried with back-off if your server fails.</p></div>
        <button className="btn sm" onClick={() => setForm({ name: '', url: 'https://', events: ['lead.created'], workspaceId: '' })}>+ New webhook</button>
      </div>
      {form && (
        <form className="run-card" style={{ marginTop: 10 }} onSubmit={(e) => {
          e.preventDefault();
          const body = { name: form.name, url: form.url, events: form.events, workspaceId: form.workspaceId || null };
          act(async () => {
            if (form.id) await api(`/api/v1/webhooks/${form.id}`, { method: 'PATCH', noWorkspace: true, body });
            else { const r = await api<{ secret: string; name: string }>('/api/v1/webhooks', { method: 'POST', noWorkspace: true, body }); onSecret({ title: `Signing secret for “${r.name}”`, value: r.secret }); }
            setForm(null);
          }, form.id ? 'Webhook saved.' : 'Webhook created.');
        }}>
          <div className="grid cols-3">
            <div className="field"><label>Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} placeholder="e.g. Our ERP" /></div>
            <div className="field"><label>URL</label><input className="input" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required /></div>
            <div className="field"><label>Business line</label>
              <select className="input" value={form.workspaceId} onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}><option value="">All business lines</option>{me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            </div>
          </div>
          <div className="field"><label>Events</label>
            <div className="access-grid">{data.events.map((ev) => (
              <label key={ev.value} className="row small" title={ev.label}><input type="checkbox" checked={form.events.includes(ev.value)} onChange={() => setForm({ ...form, events: form.events.includes(ev.value) ? form.events.filter((x) => x !== ev.value) : [...form.events, ev.value] })} /> {ev.value}</label>
            ))}</div>
          </div>
          <div className="row end"><button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancel</button><button className="btn" disabled={!form.events.length}>Save</button></div>
        </form>
      )}
      {!data.webhooks.length && !form && <p className="small muted">No webhooks yet. Zapier, Make, n8n or your own server can receive UBOS events this way.</p>}
      {data.webhooks.map((h) => (
        <div key={h.id} className="run-card" style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ minWidth: 0 }}>
              <b>{h.name}</b> {h.isActive ? <span className="badge ok">Active</span> : <span className="badge grey">Paused</span>}
              {h.failureCount > 0 && <span className="badge bad" style={{ marginLeft: 4 }}>{h.failureCount} failure(s) in a row</span>}
              <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{h.url} · {wsName(h.workspaceId)}</div>
              <div className="small">{h.events.join(', ')}</div>
              <div className="small muted">Last 7 days: {Object.entries(h.last7Days).map(([k, v]) => `${v} ${k}`).join(' · ') || 'nothing sent'}{h.lastDeliveryAt ? ` · last call ${when(h.lastDeliveryAt)} (${h.lastStatus ?? 'no answer'})` : ''}</div>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm outline" onClick={() => act(async () => {
                const d = await api<Delivery>(`/api/v1/webhooks/${h.id}/test`, { method: 'POST', noWorkspace: true });
                if (d.status !== 'delivered') throw new ApiError(400, 'TEST_FAILED', `Test not delivered: ${d.error ?? `HTTP ${d.responseStatus}`}`);
              }, 'Test delivered.')}>Send test</button>
              <button className="btn sm ghost" onClick={() => openLog(h)}>Deliveries</button>
              <button className="btn sm ghost" onClick={() => setForm({ id: h.id, name: h.name, url: h.url, events: h.events, workspaceId: h.workspaceId ?? '' })}>Edit</button>
              <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/webhooks/${h.id}`, { method: 'PATCH', noWorkspace: true, body: { isActive: !h.isActive } }), h.isActive ? 'Paused.' : 'Resumed.')}>{h.isActive ? 'Pause' : 'Resume'}</button>
              <button className="btn sm ghost" onClick={() => act(async () => { const r = await api<{ secret: string }>(`/api/v1/webhooks/${h.id}/rotate-secret`, { method: 'POST', noWorkspace: true }); onSecret({ title: `New signing secret for “${h.name}”`, value: r.secret }); }, 'Secret changed — update your receiver.')}>New secret</button>
            </div>
          </div>
        </div>
      ))}
      {log && (
        <div className="drawer-bg" onClick={() => setLog(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Deliveries">
            <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Deliveries · {log.hook.name}</h2><button className="btn sm ghost" onClick={() => setLog(null)} aria-label="Close"><Icon name="close" className="ic" /></button></div>
            {!log.rows.length && <p className="small muted">Nothing sent yet.</p>}
            {log.rows.map((d) => (
              <div key={d.id} className="event-row">
                <button className="event-head" onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id}>
                  <span className={`badge ${d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn'}`}>{d.status}</span>
                  <span className="small">{d.event}</span>
                  <span className="small muted">{d.responseStatus ? `HTTP ${d.responseStatus}` : d.error ?? ''} · {d.attempts} attempt(s)</span>
                  <span className="small muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{when(d.createdAt)}</span>
                </button>
                {open === d.id && (
                  <div className="event-body">
                    <pre>{JSON.stringify(d.payload, null, 2)}</pre>
                    {d.status === 'pending' && <div className="small muted">Next try {when(d.nextAttemptAt)}</div>}
                    {d.status !== 'delivered' && <button className="btn sm outline" onClick={async () => { await api(`/api/v1/webhook-deliveries/${d.id}/retry`, { method: 'POST', noWorkspace: true }).catch(() => undefined); openLog(log.hook); }}>Retry now</button>}
                  </div>
                )}
              </div>
            ))}
          </aside>
        </div>
      )}
    </div>
  );
}

function Docs({ baseUrl }: { baseUrl: string }) {
  const ex = (s: string) => <pre className="code-block">{s}</pre>;
  return (
    <div className="card" style={{ maxWidth: 900 }}>
      <h2>Public API</h2>
      <p className="small">Base URL <code>{baseUrl}</code>. Send <code>Authorization: Bearer &lt;API key&gt;</code>. JSON in, JSON out; at most 120 requests a minute per key. Keys limited to one business line only see and create leads there.</p>
      <table className="table small">
        <thead><tr><th>Call</th><th>Scope</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>GET /me</code></td><td>—</td><td>Check the key</td></tr>
          <tr><td><code>GET /workspaces</code></td><td>meta:read</td><td>Business lines with stages, sources, statuses, lost reasons and lead fields</td></tr>
          <tr><td><code>POST /leads</code></td><td>leads:write</td><td>Create a lead (same matching and duplicate rules as everywhere). Send <code>Idempotency-Key</code> to make retries safe.</td></tr>
          <tr><td><code>GET /leads?updatedSince=&amp;limit=</code></td><td>leads:read</td><td>Leads changed since a time (oldest first); continue with <code>nextUpdatedSince</code></td></tr>
          <tr><td><code>GET /leads/:id</code></td><td>leads:read</td><td>One lead with its latest activity</td></tr>
          <tr><td><code>PATCH /leads/:id</code></td><td>leads:write</td><td>Change status or stage (stage rules apply), add a remark</td></tr>
          <tr><td><code>GET /customers?mobile=|email=</code></td><td>customers:read</td><td>Find a customer</td></tr>
        </tbody>
      </table>
      <h3 style={{ fontSize: 14 }}>Create a lead</h3>
      {ex(`curl -X POST ${baseUrl}/leads \\
  -H "Authorization: Bearer ubos_…" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1001" \\
  -d '{"workspaceId":"<id from /workspaces>","name":"Meera Pillai","mobile":"9810033001",
       "source":"website","remark":"Wants a demo","customFields":{"course":"Numerology Basic"},
       "duplicateMode":"add_remark"}'`)}
      <p className="small muted">duplicateMode: add_remark (default) · update_blank · overwrite · new_lead · skip — what to do when the person already has an open lead.</p>
      <h3 style={{ fontSize: 14 }}>Checking a webhook signature</h3>
      <p className="small">Header <code>X-UBOS-Signature: t=&lt;unix time&gt;,v1=&lt;hex&gt;</code> where hex = HMAC-SHA256(secret, <code>t + "." + raw body</code>). Reject calls older than 5 minutes.</p>
      {ex(`const [t, v1] = header.match(/t=(\\d+),v1=(\\w+)/).slice(1);
const ok = crypto.createHmac('sha256', SECRET).update(t + '.' + rawBody).digest('hex') === v1;`)}
      <h3 style={{ fontSize: 14 }}>Inbound webhooks</h3>
      <p className="small">Lead sources (website forms, IndiaMART, JustDial, Zapier, Make …) post to the private URL shown in each integration’s setup; fields are matched with the mapping you save there. Every record appears in the integration’s Activity tab.</p>
    </div>
  );
}
