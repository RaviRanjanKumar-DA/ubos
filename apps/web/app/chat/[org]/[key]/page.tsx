'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { API_URL } from '@/lib/api';

interface Info { organization: string; greeting: string; color: string }
interface Msg { id: string; from: 'you' | 'them'; text: string | null; options: string[]; at: string }

/** The chat window a website visitor sees (inside the site's chat button). */
export default function WebChatPage() {
  const { org, key } = useParams<{ org: string; key: string }>();
  const base = `${API_URL}/public/chat/${encodeURIComponent(org)}/${encodeURIComponent(key)}`;
  const store = `ubos.chat.${org}.${key}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [gone, setGone] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [f, setF] = useState({ name: '', mobile: '', email: '', message: '', _hp: '' });
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(base).then(async (r) => (r.ok ? setInfo(await r.json()) : setGone(true))).catch(() => setGone(true));
    try { setToken(localStorage.getItem(store)); } catch { /* private window: the chat lasts for this visit */ }
  }, [base, store]);

  const poll = useCallback(async () => {
    if (!token) return;
    const r = await fetch(`${base}/messages`, { headers: { 'X-Chat-Token': token } }).catch(() => null);
    if (r?.status === 404) { setToken(null); try { localStorage.removeItem(store); } catch { /* ignore */ } return; }
    if (r?.ok) setMsgs(await r.json());
  }, [base, token, store]);
  useEffect(() => { poll(); if (!token) return; const t = setInterval(poll, 4000); return () => clearInterval(t); }, [poll, token]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs.length]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await fetch(`${base}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) setErr(b.message ?? 'Please check your details.');
      else { setToken(b.token); try { localStorage.setItem(store, b.token); } catch { /* ignore */ } }
    } catch { setErr('Could not connect. Please try again.'); }
    setBusy(false);
  }
  async function say(value: string) {
    if (!value.trim() || !token) return;
    setText('');
    await fetch(`${base}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chat-Token': token }, body: JSON.stringify({ text: value }) }).catch(() => setErr('Could not send. Please try again.'));
    setTimeout(poll, 300);
  }

  if (gone) return <div className="wchat"><div className="wchat-form muted">This chat is not available right now.</div></div>;
  if (!info) return <div className="wchat"><div className="wchat-form muted">Loading…</div></div>;
  const last = msgs[msgs.length - 1];
  return (
    <div className="wchat">
      <div className="wchat-head" style={{ background: info.color }}>{info.organization}</div>
      {!token ? (
        <form className="wchat-form" onSubmit={start}>
          <p>{info.greeting}</p>
          {err && <div className="error">{err}</div>}
          <input style={{ position: 'absolute', left: -9999 }} tabIndex={-1} autoComplete="off" aria-hidden="true" value={f._hp} onChange={(e) => setF({ ...f, _hp: e.target.value })} />
          <div className="field"><label htmlFor="c-n">Your name</label><input id="c-n" className="input" required minLength={2} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="c-m">Mobile number</label><input id="c-m" className="input" type="tel" required maxLength={30} value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></div>
          <div className="field"><label htmlFor="c-e">Email (optional)</label><input id="c-e" className="input" type="email" maxLength={160} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="c-t">How can we help?</label><textarea id="c-t" className="input" rows={2} maxLength={2000} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></div>
          <button className="btn" style={{ width: '100%', background: info.color, borderColor: info.color }} disabled={busy}>{busy ? 'Starting…' : 'Start chat'}</button>
        </form>
      ) : (
        <>
          <div className="wchat-body" aria-live="polite">
            {msgs.map((m) => <div key={m.id} className={`wchat-msg${m.from === 'you' ? ' you' : ''}`} style={m.from === 'you' ? { background: info.color } : undefined}>{m.text}</div>)}
            {last?.from === 'them' && last.options.length > 0 && <div className="wchat-opts">{last.options.map((o) => <button key={o} type="button" className="btn sm outline" onClick={() => say(o)}>{o}</button>)}</div>}
            <div ref={end} />
          </div>
          {err && <div className="error" style={{ margin: 8 }}>{err}</div>}
          <form className="wchat-foot" onSubmit={(e) => { e.preventDefault(); say(text); }}>
            <input className="input" aria-label="Your message" placeholder="Type a message…" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn" style={{ background: info.color, borderColor: info.color }} disabled={!text.trim()}>Send</button>
          </form>
        </>
      )}
    </div>
  );
}
