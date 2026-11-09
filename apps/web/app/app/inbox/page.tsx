'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { useLive } from '@/lib/live';
import { ChatThread, type Template } from '@/components/whatsapp/Chat';

interface Row { id: string; channel: string; phone: string | null; name: string; leadId: string | null; assigneeId: string | null; assigneeName: string | null; status: string; unread: number; lastMessageAt: string; windowOpen: boolean; optedOut: boolean; last: { body: string | null; direction: string; status: string } | null }
interface Broadcast { id: string; name: string; total: number; sent: number; skipped: number; failed: number; createdAt: string }
type Tab = 'chats' | 'templates' | 'broadcasts';
const relative = (d: string) => { const m = Math.floor((Date.now() - new Date(d).getTime()) / 60_000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };

function Inbox() {
  const { can } = useShell();
  const first = useSearchParams().get('c');
  const [tab, setTab] = useState<Tab>('chats');
  const canManage = can('crm.whatsapp.broadcast');
  return (
    <>
      <div className="page-head"><div><h1>Inbox</h1><p className="muted small" style={{ margin: 0 }}>Customer chats from WhatsApp and your website. New chats become leads and go to the lead’s owner.</p></div></div>
      <div className="dash-tabs" role="tablist">
        {([['chats', 'Chats'], ['templates', 'Templates'], ...(canManage ? [['broadcasts', 'Broadcasts']] : [])] as [Tab, string][]).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`dash-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'chats' && <Chats first={first} />}
      {tab === 'templates' && <Templates />}
      {tab === 'broadcasts' && <Broadcasts />}
    </>
  );
}

function Chats({ first }: { first: string | null }) {
  const { can, version } = useShell();
  const [view, setView] = useState<'all' | 'mine' | 'unassigned'>('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<string | null>(first);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const load = useCallback(() => api<Row[]>(`/api/v1/conversations?${new URLSearchParams({ view, ...(q.trim() ? { q: q.trim() } : {}) })}`).then(setRows).catch(() => setRows([])), [view, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, version]);
  useEffect(() => { if (can('crm.lead.assign')) api<{ id: string; name: string }[]>('/api/v1/users').then(setPeople).catch(() => setPeople([])); }, [can]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLive((e) => { if (!e.type.startsWith('message.')) return; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(load, 500); });
  const cur = rows?.find((r) => r.id === open);
  const post = (path: string, body: unknown) => api(`/api/v1/conversations/${open}/${path}`, { method: 'POST', body }).then(load).catch(() => undefined);
  return (
    <div className="inbox">
      <div className="card inbox-list">
        <div className="row" style={{ gap: 4 }}>{(['all', 'mine', 'unassigned'] as const).map((v) => <button key={v} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{v === 'all' ? 'All' : v === 'mine' ? 'Mine' : 'Unassigned'}</button>)}</div>
        <input className="input" style={{ margin: '8px 0' }} placeholder="Search name or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
        {rows && !rows.length && <p className="small muted">No chats here yet.</p>}
        {rows?.map((r) => (
          <button key={r.id} className={`conv ${open === r.id ? 'on' : ''}`} onClick={() => { setOpen(r.id); setTimeout(load, 800); }}>
            <span className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}><b className="conv-name">{r.name}{r.channel === 'webchat' && <span className="badge grey conv-web">Web</span>}</b><span className="small muted">{relative(r.lastMessageAt)}</span></span>
            <span className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}><span className="small muted conv-name">{r.last?.direction === 'out' ? 'You: ' : ''}{r.last?.body ?? ''}</span>{r.unread > 0 && <span className="tab-count">{r.unread}</span>}</span>
          </button>
        ))}
      </div>
      <div className="card inbox-thread">
        {!open || !cur ? <p className="muted small" style={{ margin: 0 }}>Choose a chat.</p> : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div><b>{cur.name}</b> <span className="small muted">{cur.phone}</span> {cur.status === 'closed' && <span className="badge grey">Closed</span>} {cur.leadId && <Link className="small" href={`/app/leads/${cur.leadId}`}>Open lead →</Link>}</div>
              <div className="row" style={{ gap: 6 }}>
                {can('crm.lead.assign') ? (
                  <select className="input" style={{ width: 170 }} value={cur.assigneeId ?? ''} aria-label="Assigned to" onChange={(e) => post('assign', { userId: e.target.value || null })}><option value="">Unassigned</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                ) : <span className="small muted">{cur.assigneeName ?? 'Unassigned'}</span>}
                <button className="btn sm ghost" onClick={() => post('status', { status: cur.status === 'open' ? 'closed' : 'open' })}>{cur.status === 'open' ? 'Close' : 'Reopen'}</button>
              </div>
            </div>
            <ChatThread key={open} id={open} onChange={load} />
          </>
        )}
      </div>
    </div>
  );
}

const VAR_HELP = 'name, mobile, city, owner, cf:<lead field>, or text:<fixed words>';

function Templates() {
  const [data, setData] = useState<{ canManage: boolean; templates: Template[] } | null>(null);
  const [f, setF] = useState({ name: '', language: 'en', category: 'marketing', body: '', variables: '' });
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(() => api<NonNullable<typeof data>>('/api/v1/message-templates').then(setData).catch(() => setData(null)), []);
  useEffect(() => { load(); }, [load]);
  const n = Math.max(0, ...[...f.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
  return (
    <div className={data?.canManage ? 'prod-grid' : ''}>
      <div className="card">
        <h2>Approved templates</h2>
        {msg && <div className={msg.type}>{msg.text}</div>}
        {!data?.templates.length && <p className="small muted">None yet. Templates are approved by Meta in WhatsApp Manager, then registered here.</p>}
        {data?.templates.map((t) => (
          <div key={t.id} className="run-card">
            <div className="row" style={{ justifyContent: 'space-between' }}><span><b>{t.name}</b> <span className="badge grey">{t.language} · {t.category}</span></span>
              {data.canManage && <button className="btn sm ghost" onClick={() => api(`/api/v1/message-templates/${t.id}`, { method: 'PATCH', body: { isArchived: true } }).then(load)}>Archive</button>}</div>
            <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{t.body}</div>
            {t.variables.length > 0 && <div className="small muted">{t.variables.map((v, i) => `{{${i + 1}}} = ${v}`).join(' · ')}</div>}
          </div>
        ))}
      </div>
      {data?.canManage && (
        <form className="card" onSubmit={(e) => {
          e.preventDefault(); setMsg(null);
          api('/api/v1/message-templates', { method: 'POST', body: { name: f.name, language: f.language, category: f.category, body: f.body, variables: f.variables.split(',').map((x) => x.trim()).filter(Boolean) } })
            .then(() => { setF({ name: '', language: 'en', category: 'marketing', body: '', variables: '' }); setMsg({ type: 'notice', text: 'Template registered.' }); load(); })
            .catch((x) => setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }));
        }}>
          <h2>Register a template</h2>
          <div className="field"><label>Name (exactly as approved)</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="audit_followup" /></div>
          <div className="grid cols-2">
            <div className="field"><label>Language</label><input className="input" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} required /></div>
            <div className="field"><label>Category</label><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="marketing">Marketing</option><option value="utility">Utility</option></select></div>
          </div>
          <div className="field"><label>Text</label><textarea className="input" style={{ height: 90, paddingTop: 8 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required placeholder="Hello {{1}}, this is {{2}}…" /></div>
          <div className="field"><label>What fills the blanks{n ? ` (${n}, comma separated)` : ''}</label><input className="input" value={f.variables} onChange={(e) => setF({ ...f, variables: e.target.value })} placeholder="name, owner" /><div className="small muted" style={{ marginTop: 4 }}>{VAR_HELP}</div></div>
          <div className="row end"><button className="btn">Register</button></div>
        </form>
      )}
    </div>
  );
}

function Broadcasts() {
  const [rows, setRows] = useState<Broadcast[] | null>(null);
  useEffect(() => { api<Broadcast[]>('/api/v1/broadcasts').then(setRows).catch(() => setRows([])); }, []);
  return (
    <div className="card">
      <p className="small muted" style={{ marginTop: 0 }}>To send one: on the Leads page tick the leads and choose “WhatsApp”. Customers who replied STOP are always skipped.</p>
      {!rows?.length ? <p className="small muted">No broadcasts yet.</p> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>When</th><th>Leads</th><th>Sent</th><th>Skipped</th><th>Failed</th></tr></thead>
          <tbody>{rows.map((b) => <tr key={b.id}><td><b>{b.name}</b></td><td className="small">{new Date(b.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}</td><td>{b.total}</td><td>{b.sent}</td><td>{b.skipped}</td><td>{b.failed}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

export default function InboxPage() { return <Suspense fallback={null}><Inbox /></Suspense>; }
