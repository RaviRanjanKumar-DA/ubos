'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { SlaBadge, PRIORITY, STATUS, when, type Sla } from '@/components/support/ticket-ui';

interface Msg { id: string; kind: string; body: string; emailStatus: string; createdAt: string; author: string }
interface Ticket {
  id: string; number: number; subject: string; description: string | null; status: string; priority: string; category: string | null; source: string; workspaceId: string; leadId: string | null; assigneeId: string | null; assignee: string | null; createdBy: string; createdAt: string;
  firstResponseDueAt: string; resolutionDueAt: string; firstRespondedAt: string | null; resolvedAt: string | null; sla: Sla; canWork: boolean;
  customer: { id: string; code: string; name: string; mobile: string | null; email: string | null; hasEmail: boolean }; messages: Msg[];
}
interface Options { canAssign: boolean; me: string; users: { value: string; label: string }[] }
interface Article { id: string; title: string; excerpt: string }
const MAIL: Record<string, [string, string]> = { sending: ['grey', 'Sending email'], sent: ['ok', 'Emailed'], failed: ['bad', 'Email failed'] };

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { version } = useShell();
  const [t, setT] = useState<Ticket | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [err, setErr] = useState('');
  const [kind, setKind] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [kbQ, setKbQ] = useState('');
  const [kb, setKb] = useState<Article[]>([]);

  const load = useCallback(() => api<Ticket>(`/api/v1/tickets/${id}`).then(setT).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load this ticket')), [id]);
  useEffect(() => { load(); api<Options>('/api/v1/tickets/options').then(setOpts).catch(() => setOpts(null)); }, [load, version]);
  useEffect(() => {
    if (kbQ.trim().length < 2) { setKb([]); return; }
    const c = setTimeout(() => api<{ articles: Article[] }>(`/api/v1/kb?q=${encodeURIComponent(kbQ)}`).then((r) => setKb(r.articles.slice(0, 5))).catch(() => setKb([])), 250);
    return () => clearTimeout(c);
  }, [kbQ]);

  const patch = async (b: object) => {
    setErr('');
    try { await api(`/api/v1/tickets/${id}`, { method: 'PATCH', body: b }); await load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api<{ emailStatus: string }>(`/api/v1/tickets/${id}/messages`, { method: 'POST', body: { kind, body, email } });
      setBody('');
      if (r.emailStatus === 'failed') setErr('The reply is saved, but the email could not be sent.');
      await load();
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); }
    setBusy(false);
  };
  const insert = async (a: Article) => {
    try { const full = await api<{ body: string }>(`/api/v1/kb/${a.id}`); setBody(body ? `${body}\n\n${full.body}` : full.body); setKind('reply'); } catch { setErr('Could not open this article'); }
  };

  if (!t) return <><div className="page-head"><h1>Ticket</h1></div><div className={err ? 'error' : 'card muted'}>{err || 'Loading…'}</div></>;
  const closed = t.status === 'closed';
  return (
    <>
      <div className="page-head">
        <div>
          <p className="muted small page-note"><Link href="/app/tickets">Tickets</Link></p>
          <h1>#{t.number} {t.subject}</h1>
          <p className="small muted page-note">Raised by {t.createdBy} · {when(t.createdAt)}</p>
        </div>
        <SlaBadge sla={t.sla} status={t.status} />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="ticket-layout">
        <div>
          <div className="card">
            {t.description && <p className="ticket-text ticket-desc">{t.description}</p>}
            {!t.messages.length && !t.description && <p className="small muted">No conversation yet.</p>}
            <ul className="ticket-thread">
              {t.messages.map((m) => m.kind === 'event' ? <li key={m.id} className="ticket-event small muted">{m.body} · {m.author} · {when(m.createdAt)}</li> : (
                <li key={m.id} className={`ticket-msg ${m.kind}`}>
                  <div className="ticket-msg-head"><b className="small">{m.author}</b><span className="badge grey">{m.kind === 'note' ? 'Internal note' : 'Reply'}</span>{MAIL[m.emailStatus] && <span className={`badge ${MAIL[m.emailStatus][0]}`}>{MAIL[m.emailStatus][1]}</span>}<span className="small muted">{when(m.createdAt)}</span></div>
                  <div className="ticket-text">{m.body}</div>
                </li>
              ))}
            </ul>
          </div>
          {t.canWork && (closed ? <div className="card small muted">This ticket is closed. Set its status to Open to add to it.</div> : (
            <form className="card ticket-reply" onSubmit={send}>
              <div className="dash-tabs" role="tablist">
                {([['reply', 'Reply to customer'], ['note', 'Internal note']] as const).map(([k, l]) => <button type="button" role="tab" aria-selected={kind === k} key={k} className={`dash-tab ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{l}</button>)}
              </div>
              <textarea className="input" rows={5} required maxLength={5000} aria-label={kind === 'reply' ? 'Reply' : 'Note'} placeholder={kind === 'reply' ? 'Write to the customer' : 'Only your team sees this'} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="row ticket-send">
                {kind === 'reply' && (t.customer.hasEmail ? <label className="row small"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email this to the customer</label> : <span className="small muted">No email on file, so this is saved here only.</span>)}
                <button className="btn" disabled={busy || !body.trim()}>{busy ? 'Saving…' : kind === 'reply' ? 'Send reply' : 'Add note'}</button>
              </div>
            </form>
          ))}
        </div>
        <aside className="ticket-side">
          <div className="card">
            <h2 className="form-head">Details</h2>
            <div className="field"><label htmlFor="d-st">Status</label><select id="d-st" className="input" disabled={!t.canWork} value={t.status} onChange={(e) => patch({ status: e.target.value })}>{Object.entries(STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div className="field"><label htmlFor="d-pr">Priority</label><select id="d-pr" className="input" disabled={!t.canWork} value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div className="field">
              <label htmlFor="d-ow">Owner</label>
              {opts?.canAssign && t.canWork ? <select id="d-ow" className="input" value={t.assigneeId ?? ''} onChange={(e) => patch({ assigneeId: e.target.value || null })}><option value="">Unassigned</option>{opts.users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select>
                : t.assigneeId ? <b>{t.assignee}</b> : t.canWork && opts ? <button type="button" className="btn sm outline" onClick={() => patch({ assigneeId: opts.me })}>Take this ticket</button> : <span className="muted">Unassigned</span>}
            </div>
            <dl className="ticket-facts">
              <div><dt>First response by</dt><dd>{when(t.firstResponseDueAt)}{t.firstRespondedAt && <span className="small muted"> · answered {when(t.firstRespondedAt)}</span>}</dd></div>
              <div><dt>Resolve by</dt><dd>{when(t.resolutionDueAt)}</dd></div>
              {t.category && <div><dt>Category</dt><dd>{t.category}</dd></div>}
            </dl>
          </div>
          <div className="card">
            <h2 className="form-head">Customer</h2>
            <p className="ticket-cust"><Link href={`/app/customers/${t.customer.id}`}><b>{t.customer.name}</b></Link> <span className="small muted">{t.customer.code}</span></p>
            {t.customer.mobile && <p className="small ticket-cust">{t.customer.mobile}</p>}
            {t.customer.email && <p className="small ticket-cust">{t.customer.email}</p>}
            {t.leadId && <p className="small ticket-cust"><Link href={`/app/leads/${t.leadId}`}>Open the lead</Link></p>}
          </div>
          {t.canWork && !closed && (
            <div className="card">
              <h2 className="form-head">Knowledge base</h2>
              <input className="input" placeholder="Search answers" aria-label="Search knowledge base" value={kbQ} onChange={(e) => setKbQ(e.target.value)} />
              <ul className="kb-hits">{kb.map((a) => <li key={a.id}><b className="small">{a.title}</b><button type="button" className="link-btn small" onClick={() => insert(a)}>Use in reply</button></li>)}</ul>
              {kbQ.trim().length >= 2 && !kb.length && <p className="small muted">No answers found.</p>}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
