'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { API_URL } from '@/lib/api';

interface Day { date: string; slots: string[] }
interface Page { organization: string; title: string; description: string | null; durationMin: number; location: string | null; host: string; days: Day[] }

const IST = 'Asia/Kolkata';
const dayLabel = (d: string) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' });
const time = (s: string) => new Date(s).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' });
const full = (s: string) => new Date(s).toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' });

/** Public page where a customer picks a free time. No sign-in. */
export default function BookingPublicPage() {
  const { org, link } = useParams<{ org: string; link: string }>();
  const url = `${API_URL}/public/booking/${encodeURIComponent(org)}/${encodeURIComponent(link)}`;
  const [page, setPage] = useState<Page | null>(null);
  const [day, setDay] = useState('');
  const [slot, setSlot] = useState('');
  const [f, setF] = useState({ name: '', mobile: '', email: '', note: '', _hp: '' });
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'done' | 'error' | 'gone'; text?: string }>({ kind: 'idle' });

  const load = () => fetch(url).then(async (r) => {
    if (!r.ok) return setState({ kind: 'gone', text: 'This booking page is not available.' });
    const p = (await r.json()) as Page;
    setPage(p); setDay((d) => (p.days.some((x) => x.date === d) ? d : p.days[0]?.date ?? ''));
  }).catch(() => setState({ kind: 'gone', text: 'This page could not be loaded. Please try again.' }));
  useEffect(() => { load(); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: 'sending' });
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, startAt: slot }) });
      const b = await r.json().catch(() => ({}));
      if (r.ok) return setState({ kind: 'done' });
      setState({ kind: 'error', text: b.message ?? 'Please check your details and try again.' });
      if (b.code === 'SLOT_TAKEN') { setSlot(''); load(); }
    } catch { setState({ kind: 'error', text: 'Could not book. Please try again.' }); }
  }

  const slots = page?.days.find((d) => d.date === day)?.slots ?? [];
  return (
    <div className="pub-wrap">
      <div className="pub-form book-pub">
        {state.kind === 'gone' && <div className="muted">{state.text}</div>}
        {!page && state.kind !== 'gone' && <div className="muted">Loading…</div>}
        {page && state.kind === 'done' && (
          <div className="book-done">
            <h2>Your meeting is booked</h2>
            <p>{full(slot)} IST, with {page.host}.</p>
            {page.location && <p className="muted">{page.location}</p>}
            {f.email && <p className="small muted">A confirmation is on its way to {f.email}.</p>}
          </div>
        )}
        {page && state.kind !== 'done' && state.kind !== 'gone' && (
          <>
            <div className="small muted">{page.organization}</div>
            <h2>{page.title}</h2>
            <div className="small muted">{page.durationMin} minutes with {page.host}{page.location ? ` · ${page.location}` : ''}</div>
            {page.description && <p className="small">{page.description}</p>}
            {state.kind === 'error' && <div className="error" style={{ marginTop: 12 }}>{state.text}</div>}
            {!slot ? (
              <>
                {!page.days.length && <p className="muted">No free times right now. Please check again later.</p>}
                {page.days.length > 0 && (
                  <>
                    <div className="book-label">Choose a day</div>
                    <div className="book-days">{page.days.map((d) => <button key={d.date} type="button" className={`chip${d.date === day ? ' on' : ''}`} onClick={() => setDay(d.date)}>{dayLabel(d.date)}</button>)}</div>
                    <div className="book-label">Choose a time (IST)</div>
                    <div className="book-slots">{slots.map((s) => <button key={s} type="button" className="btn outline" onClick={() => { setSlot(s); setState({ kind: 'idle' }); }}>{time(s)}</button>)}</div>
                  </>
                )}
              </>
            ) : (
              <form onSubmit={submit}>
                <div className="notice book-chosen"><span>{full(slot)} IST</span><button type="button" className="btn sm ghost" onClick={() => setSlot('')}>Change</button></div>
                <input className="book-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f._hp} onChange={(e) => setF({ ...f, _hp: e.target.value })} />
                <div className="field"><label htmlFor="n">Your name</label><input id="n" className="input" required minLength={2} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
                <div className="field"><label htmlFor="m">Mobile number</label><input id="m" className="input" type="tel" required maxLength={30} value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></div>
                <div className="field"><label htmlFor="e">Email (for your confirmation)</label><input id="e" className="input" type="email" maxLength={160} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
                <div className="field"><label htmlFor="o">Anything we should know? (optional)</label><textarea id="o" className="input" rows={2} maxLength={1000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
                <button className="btn" style={{ width: '100%' }} disabled={state.kind === 'sending'}>{state.kind === 'sending' ? 'Booking…' : 'Confirm booking'}</button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
