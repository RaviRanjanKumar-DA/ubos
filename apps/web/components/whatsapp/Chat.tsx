'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useLive } from '@/lib/live';

export interface Template { id: string; name: string; language: string; category: string; body: string; variables: string[] }
interface Msg { id: string; direction: string; type: string; body: string | null; templateName: string | null; status: string; error: string | null; at: string; by: string | null }
export interface Thread {
  id: string; phone: string | null; name: string; leadId: string | null; workspaceId: string | null; assigneeId: string | null; assigneeName: string | null; status: string; unread: number;
  windowOpen: boolean; optedOut: boolean; messages: Msg[];
}
const TICK: Record<string, string> = { queued: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠' };
const time = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** One WhatsApp chat: messages (live), reply box inside the 24-hour window, approved templates otherwise. */
export function ChatThread({ id, workspace, onChange }: { id: string; workspace?: string | null; onChange?: () => void }) {
  const [t, setT] = useState<Thread | null>(null);
  const [text, setText] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tpl, setTpl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const opts = workspace ? { workspace } : {};
  const load = useCallback(() => api<Thread>(`/api/v1/conversations/${id}`, workspace ? { workspace } : {}).then(setT).catch((e) => setErr(e instanceof Error ? e.message : 'Failed')), [id, workspace]);
  useEffect(() => { setT(null); setErr(''); load(); api<{ templates: Template[] }>('/api/v1/message-templates', workspace ? { workspace } : {}).then((r) => setTemplates(r.templates)).catch(() => setTemplates([])); }, [load, workspace]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [t?.messages.length]);
  useLive((e) => { if (e.conversationId === id) load(); });

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setErr('');
    try { await fn(); after?.(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
    await load(); onChange?.(); setBusy(false);
  }
  if (!t) return err ? <div className="error">{err}</div> : <div className="muted small">Loading…</div>;
  return (
    <div className="chat">
      <div className="chat-msgs">
        {t.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.direction === 'in' ? 'in' : 'out'} ${m.status === 'failed' ? 'failed' : ''}`}>
            {m.templateName && <div className="small muted">Template: {m.templateName}</div>}
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body ?? `[${m.type}]`}</div>
            <div className="bubble-meta">{m.by ? `${m.by} · ` : ''}{time(m.at)} {m.direction === 'out' && <span className={m.status === 'read' ? 'tick-read' : ''} title={m.status}>{TICK[m.status] ?? ''}</span>}</div>
            {m.error && <div className="small" style={{ color: 'var(--bad)' }}>{m.error}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      {err && <div className="error" style={{ marginBottom: 6 }}>{err}</div>}
      {t.windowOpen ? (
        <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) run(() => api(`/api/v1/conversations/${id}/messages`, { method: 'POST', body: { text }, ...opts }), () => setText('')); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a reply…" aria-label="Reply" maxLength={4096} />
          <button className="btn" disabled={busy || !text.trim()}>Send</button>
        </form>
      ) : t.optedOut ? <div className="notice small">This customer opted out of WhatsApp messages (replied STOP).</div> : (
        <div>
          <div className="notice small">More than 24 hours since the customer’s last message. WhatsApp allows only an approved template now.</div>
          {t.leadId ? (
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <select className="input" value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Template"><option value="">{templates.length ? 'Choose a template…' : 'No templates yet'}</option>{templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              <button className="btn" disabled={busy || !tpl} onClick={() => run(() => api(`/api/v1/leads/${t.leadId}/whatsapp/template`, { method: 'POST', body: { templateId: tpl }, ...(t.workspaceId ? { workspace: t.workspaceId } : {}) }), () => setTpl(''))}>Send template</button>
            </div>
          ) : <div className="small muted">Put this chat on a lead first.</div>}
          {tpl && <div className="small muted" style={{ marginTop: 4 }}>{templates.find((x) => x.id === tpl)?.body}</div>}
        </div>
      )}
    </div>
  );
}

/** The WhatsApp tab on a lead: its chat, or a template to start one. */
export function LeadWhatsApp({ leadId, workspace }: { leadId: string; workspace: string }) {
  const [s, setS] = useState<{ connected: boolean; conversationId: string | null; optedOut: boolean; hasNumber: boolean } | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tpl, setTpl] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api<typeof s>(`/api/v1/leads/${leadId}/whatsapp`, { workspace }).then(setS).catch(() => setS(null)), [leadId, workspace]);
  useEffect(() => { load(); api<{ templates: Template[] }>('/api/v1/message-templates', { workspace }).then((r) => setTemplates(r.templates)).catch(() => setTemplates([])); }, [load, workspace]);
  if (!s) return <p className="small muted">WhatsApp is not available for this lead.</p>;
  if (!s.connected) return <p className="small muted">WhatsApp is not connected yet (Integrations → WhatsApp Cloud API).</p>;
  if (s.conversationId) return <ChatThread id={s.conversationId} workspace={workspace} />;
  if (!s.hasNumber) return <p className="small muted">This lead has no mobile number.</p>;
  if (s.optedOut) return <p className="small muted">This customer opted out of WhatsApp messages.</p>;
  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>No chat yet. WhatsApp only lets a business start a chat with an approved template.</p>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ flexWrap: 'nowrap', maxWidth: 520 }}>
        <select className="input" value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Template"><option value="">{templates.length ? 'Choose a template…' : 'No templates yet'}</option>{templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <button className="btn" disabled={!tpl} onClick={async () => { setErr(''); try { await api(`/api/v1/leads/${leadId}/whatsapp/template`, { method: 'POST', body: { templateId: tpl }, workspace }); load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); } }}>Send template</button>
      </div>
    </div>
  );
}
