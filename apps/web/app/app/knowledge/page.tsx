'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Row { id: string; title: string; category: string | null; status: string; updatedAt: string; excerpt: string }
interface Full { id: string; title: string; body: string; category: string | null; status: string }
const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });

/** Answers for the support team of a business line. */
export default function KnowledgePage() {
  const { me, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [data, setData] = useState<{ canManage: boolean; articles: Row[] } | null>(null);
  const [q, setQ] = useState('');
  const [reading, setReading] = useState<Full | null>(null);
  const [editing, setEditing] = useState<Partial<Full> | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => api<{ canManage: boolean; articles: Row[] }>(`/api/v1/kb${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setData).catch(() => setData({ canManage: false, articles: [] })), [q]);
  useEffect(() => { if (!ws) return; const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q, ws, version]);
  if (!ws) return <><div className="page-head"><h1>Knowledge base</h1></div><div className="card muted">Articles belong to a business line. Choose one in the switcher at the top.</div></>;

  const open = async (id: string) => { setErr(''); try { setReading(await api<Full>(`/api/v1/kb/${id}`)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not open this article'); } };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!editing) return; setErr('');
    const body = { title: editing.title, body: editing.body, category: editing.category || null, status: editing.status ?? 'draft' };
    try {
      if (editing.id) await api(`/api/v1/kb/${editing.id}`, { method: 'PATCH', body }); else await api('/api/v1/kb', { method: 'POST', body });
      setEditing(null); setReading(null); load();
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); }
  };
  const archive = async (a: Full) => {
    if (!confirm(`Archive “${a.title}”? It stops showing here.`)) return;
    try { await api(`/api/v1/kb/${a.id}`, { method: 'PATCH', body: { archived: true } }); setReading(null); load(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); }
  };
  return (
    <>
      <div className="page-head">
        <div><h1>Knowledge base</h1><p className="muted small page-note">Ready answers your team can read and use in ticket replies.</p></div>
        {data?.canManage && <button className="btn" onClick={() => setEditing({ status: 'draft' })}>+ New article</button>}
      </div>
      {err && <div className="error">{err}</div>}
      <div className="kb-search"><input className="input" placeholder="Search articles" aria-label="Search articles" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {!data ? <div className="card muted">Loading…</div> : !data.articles.length ? <div className="card empty">{q ? 'No articles match your search.' : data.canManage ? 'No articles yet. Write the answers your team gives most often.' : 'No articles published yet.'}</div> : (
        <div className="camp-grid">
          {data.articles.map((a) => (
            <button type="button" className="card kb-card" key={a.id} onClick={() => open(a.id)}>
              <span className="camp-top"><b className="kb-title">{a.title}</b>{a.status === 'draft' && <span className="badge grey">Draft</span>}</span>
              <span className="small muted kb-excerpt">{a.excerpt}</span>
              <span className="small muted">{[a.category, `Updated ${day(a.updatedAt)}`].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </div>
      )}
      {reading && !editing && (
        <div className="modal-bg" onClick={() => setReading(null)}>
          <div className="modal modal-wide" role="dialog" aria-label={reading.title} onClick={(e) => e.stopPropagation()}>
            <h2>{reading.title}</h2>
            <div className="ticket-text">{reading.body}</div>
            <div className="row modal-actions">
              {data?.canManage && <button className="btn ghost" onClick={() => archive(reading)}>Archive</button>}
              {data?.canManage && <button className="btn outline" onClick={() => setEditing(reading)}>Edit</button>}
              <button className="btn" onClick={() => setReading(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <div className="modal-bg" onClick={() => setEditing(null)}>
          <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{editing.id ? 'Edit article' : 'New article'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label htmlFor="kb-t">Title</label><input id="kb-t" className="input" required minLength={3} maxLength={160} value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></div>
            <div className="field"><label htmlFor="kb-c">Category</label><input id="kb-c" className="input" maxLength={60} value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })} /></div>
            <div className="field"><label htmlFor="kb-b">Answer</label><textarea id="kb-b" className="input" rows={10} required maxLength={50000} value={editing.body ?? ''} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></div>
            <div className="field"><label htmlFor="kb-s">Status</label><select id="kb-s" className="input" value={editing.status ?? 'draft'} onChange={(e) => setEditing({ ...editing, status: e.target.value })}><option value="draft">Draft (managers only)</option><option value="published">Published (whole team)</option></select></div>
            <div className="row modal-actions"><button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
