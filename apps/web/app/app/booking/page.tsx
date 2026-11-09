'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';
import { Menu } from '@/components/Menu';
import { PickWorkspace } from '@/components/PickWorkspace';

type Hours = Record<string, [number, number][]>;
interface BLink { id: string; slug: string; title: string; description: string | null; hostId: string; hostName: string; durationMin: number; bufferMin: number; noticeHours: number; horizonDays: number; hours: Hours; location: string | null; isActive: boolean; bookings: number; upcoming: number; path: string }
interface Options { canPickHost: boolean; me: string; hosts: { id: string; name: string }[] }
interface Entry { id: string; name: string; mobile: string | null; email: string | null; note: string | null; startAt: string; status: string; leadId: string | null }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_HOURS: Hours = Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [String(d), [[600, 1080]]]));
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

interface Draft { id: string | null; title: string; description: string; hostId: string; durationMin: number; bufferMin: number; noticeHours: number; horizonDays: number; hours: Hours; location: string }

export default function BookingPage() {
  const { me, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [links, setLinks] = useState<BLink[] | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [entries, setEntries] = useState<{ link: BLink; rows: Entry[] } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(() => {
    if (!ws) return;
    api<BLink[]>('/api/v1/booking-links').then(setLinks).catch((e) => setMsg({ type: 'error', text: e.message }));
    api<Options>('/api/v1/booking-links/options').then(setOpts).catch(() => setOpts(null));
  }, [ws]);
  useEffect(() => { load(); }, [load, version]);
  if (!ws) return <><div className="page-head"><h1>Booking links</h1></div><PickWorkspace text="Booking links belong to a business line." /></>;

  const full = (l: BLink) => `${window.location.origin}${l.path}`;
  const copy = async (l: BLink) => { try { await navigator.clipboard.writeText(full(l)); setMsg({ type: 'notice', text: 'Link copied.' }); } catch { setMsg({ type: 'notice', text: full(l) }); } };
  const run = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; } };
  const patch = (l: BLink, body: object, text: string) => run(() => api(`/api/v1/booking-links/${l.id}`, { method: 'PATCH', body }), text);
  const blank = (): Draft => ({ id: null, title: '', description: '', hostId: opts?.me ?? '', durationMin: 30, bufferMin: 0, noticeHours: 4, horizonDays: 30, hours: DEFAULT_HOURS, location: '' });
  const open = (l: BLink): Draft => ({ id: l.id, title: l.title, description: l.description ?? '', hostId: l.hostId, durationMin: l.durationMin, bufferMin: l.bufferMin, noticeHours: l.noticeHours, horizonDays: l.horizonDays, hours: l.hours, location: l.location ?? '' });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const { id, ...d } = edit;
    const body = { ...d, description: d.description || null, location: d.location || null, hostId: d.hostId || undefined };
    if (await run(() => (id ? api(`/api/v1/booking-links/${id}`, { method: 'PATCH', body }) : api('/api/v1/booking-links', { method: 'POST', body })), id ? 'Booking link saved.' : 'Booking link created.')) setEdit(null);
  }
  const setDay = (d: number, on: boolean) => { if (!edit) return; const h = { ...edit.hours }; if (on) h[d] = [[600, 1080]]; else delete h[d]; setEdit({ ...edit, hours: h }); };
  const setRange = (d: number, i: 0 | 1, t: string) => { if (!edit || !t) return; const r = [...edit.hours[d][0]] as [number, number]; r[i] = toMin(t); setEdit({ ...edit, hours: { ...edit.hours, [d]: [r] } }); };

  return (
    <>
      <div className="page-head">
        <div><h1>Booking links</h1><div className="muted small">Share a link and customers pick a free time. Each booking becomes a meeting on the calendar and a lead. All times are IST.</div></div>
        <button className="btn" disabled={!opts} onClick={() => setEdit(blank())}><Icon name="plus" className="ic" />New link</button>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {links && !links.length && <div className="card empty">No booking links yet.</div>}
      <div className="book-grid">
        {links?.map((l) => (
          <section key={l.id} className="card book-card">
            <div className="org-head">
              <h2>{l.title}</h2>
              <span className={`badge ${l.isActive ? 'ok' : 'grey'}`}>{l.isActive ? 'On' : 'Off'}</span>
            </div>
            <div className="small muted">{l.hostName} · {l.durationMin} minutes{l.location ? ` · ${l.location}` : ''}</div>
            <div className="small book-count"><b>{l.upcoming}</b> upcoming · <b>{l.bookings}</b> booked in all</div>
            <div className="book-url small">{l.path}</div>
            <div className="row book-actions">
              <button className="btn sm" onClick={() => copy(l)}>Copy link</button>
              <a className="btn sm outline" href={l.path} target="_blank" rel="noreferrer">Open</a>
              <button className="btn sm outline" onClick={() => api<Entry[]>(`/api/v1/booking-links/${l.id}/bookings`).then((rows) => setEntries({ link: l, rows })).catch((e) => setMsg({ type: 'error', text: e.message }))}>Bookings</button>
              <Menu sm items={[
                { label: 'Edit', icon: 'edit', onClick: () => setEdit(open(l)) },
                { label: l.isActive ? 'Turn off' : 'Turn on', icon: 'radio', onClick: () => patch(l, { isActive: !l.isActive }, l.isActive ? 'Link turned off.' : 'Link turned on.') },
                { label: 'Archive', icon: 'trash', onClick: async () => { if (await askConfirm(`Archive ${l.title}? The link stops working. Its bookings stay on the calendar.`)) patch(l, { isArchived: true }, 'Link archived.'); } },
              ]} />
            </div>
          </section>
        ))}
      </div>

      {edit && (
        <div className="modal-bg">
          <form className="modal book-modal" onSubmit={save}>
            <div className="org-head"><h2>{edit.id ? 'Edit booking link' : 'New booking link'}</h2><button type="button" className="btn sm ghost" aria-label="Close" onClick={() => setEdit(null)}><Icon name="close" className="ic" /></button></div>
            <div className="field"><label htmlFor="bt">Title</label><input id="bt" className="input" required minLength={2} maxLength={120} placeholder="e.g. Vastu consultation" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
            <div className="field"><label htmlFor="bd">Description (optional)</label><textarea id="bd" className="input" rows={2} maxLength={1000} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
            {opts?.canPickHost && <div className="field"><label htmlFor="bh">Who is being booked</label><select id="bh" className="input" value={edit.hostId} onChange={(e) => setEdit({ ...edit, hostId: e.target.value })}>{opts.hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></div>}
            <div className="field"><label htmlFor="bl">Where (address or video link, optional)</label><input id="bl" className="input" maxLength={300} value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} /></div>
            <div className="book-nums">
              <div className="field"><label htmlFor="bm">Length</label><select id="bm" className="input" value={edit.durationMin} onChange={(e) => setEdit({ ...edit, durationMin: Number(e.target.value) })}>{[15, 30, 45, 60, 90, 120].map((n) => <option key={n} value={n}>{n} minutes</option>)}</select></div>
              <div className="field"><label htmlFor="bb">Gap between meetings</label><select id="bb" className="input" value={edit.bufferMin} onChange={(e) => setEdit({ ...edit, bufferMin: Number(e.target.value) })}>{[0, 5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n ? `${n} minutes` : 'None'}</option>)}</select></div>
              <div className="field"><label htmlFor="bn">Earliest booking (hours ahead)</label><input id="bn" className="input" type="number" min={0} max={720} value={edit.noticeHours} onChange={(e) => setEdit({ ...edit, noticeHours: Number(e.target.value) })} /></div>
              <div className="field"><label htmlFor="bz">Bookable up to (days ahead)</label><input id="bz" className="input" type="number" min={1} max={90} value={edit.horizonDays} onChange={(e) => setEdit({ ...edit, horizonDays: Number(e.target.value) })} /></div>
            </div>
            <div className="book-hours-title">Available hours (IST)</div>
            {DAYS.map((name, d) => {
              const r = edit.hours[d]?.[0];
              return (
                <div key={name} className="book-day">
                  <label className="row"><input type="checkbox" checked={!!r} onChange={(e) => setDay(d, e.target.checked)} /> {name}</label>
                  {r ? <span className="row book-times"><input className="input" type="time" aria-label={`${name} start`} value={toTime(r[0])} onChange={(e) => setRange(d, 0, e.target.value)} /><span className="muted">to</span><input className="input" type="time" aria-label={`${name} end`} value={toTime(r[1])} onChange={(e) => setRange(d, 1, e.target.value)} /></span> : <span className="small muted">Not available</span>}
                </div>
              );
            })}
            <div className="row end" style={{ marginTop: 16 }}><button type="button" className="btn ghost" onClick={() => setEdit(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}

      {entries && (
        <div className="modal-bg">
          <div className="modal book-modal">
            <div className="org-head"><h2>Bookings · {entries.link.title}</h2><button className="btn sm ghost" aria-label="Close" onClick={() => setEntries(null)}><Icon name="close" className="ic" /></button></div>
            {!entries.rows.length && <div className="empty">No bookings yet.</div>}
            {entries.rows.map((b) => (
              <div key={b.id} className="run-card">
                <div className="org-head"><b>{b.name}</b><span className={`badge ${b.status === 'booked' ? 'ok' : 'grey'}`}>{b.status === 'booked' ? 'Booked' : b.status === 'cancelled' ? 'Cancelled' : 'Failed'}</span></div>
                <div className="small muted">{when(b.startAt)}{b.mobile ? ` · ${b.mobile}` : ''}{b.email ? ` · ${b.email}` : ''}</div>
                {b.note && <div className="small">{b.note}</div>}
                {b.leadId && <Link className="small" href={`/app/leads/${b.leadId}`}>Open the lead</Link>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
