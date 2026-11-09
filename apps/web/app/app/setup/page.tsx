'use client';

import { Icon } from '@/components/Icon';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Step { id: string; title: string; level: 'basic' | 'advanced'; available: boolean; done: boolean; skipped: boolean; href: string | null; phase: string | null }
interface Card { id: string; title: string; hint: string; tone: string; steps: Step[]; done: number; total: number }
interface Guide { id: string; title: string; icon: string; hint: string; cards: Card[]; done: number; total: number }
interface SetupGuide { guides: Guide[]; available: { done: number; total: number } }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const phaseLabel = (p: string) => (p.includes('.') ? `Coming in slice ${p}` : `Coming in Phase ${p}`);

/** Setup Guide: an onboarding checklist whose steps tick themselves off as the organization sets things up. */
export default function SetupPage() {
  const { me } = useShell();
  const [data, setData] = useState<SetupGuide | null>(null);
  const [active, setActive] = useState('start');
  const [error, setError] = useState('');
  const [resource, setResource] = useState<'app' | 'contact' | 'videos' | 'updates' | null>(null);

  const load = useCallback(() => api<SetupGuide>('/api/v1/setup-guide', { noWorkspace: true }).then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function skip(s: Step) {
    setError('');
    try { await api(`/api/v1/setup-guide/steps/${s.id}/skip`, { method: 'POST', noWorkspace: true, body: { skipped: !s.skipped } }); load(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
  }

  if (me.permissions['org.workspace.manage'] !== 'ORGANIZATION') return <div className="notice">The Setup Guide is for organization admins.</div>;
  const guide = data?.guides.find((g) => g.id === active);
  const pct = data ? Math.round((data.available.done / Math.max(1, data.available.total)) * 100) : 0;

  return (
    <div className="setup">
      <aside className="setup-nav">
        <div className="setup-label">User guides</div>
        {data?.guides.map((g) => {
          const ready = g.cards.flatMap((c) => c.steps).filter((s) => s.available);
          const finished = ready.length > 0 && ready.every((s) => s.done || s.skipped);
          return (
            <button key={g.id} className={`setup-nav-item ${active === g.id ? 'on' : ''}`} onClick={() => setActive(g.id)}>
              <Ring value={ready.length ? ready.filter((s) => s.done || s.skipped).length / ready.length : 0} done={finished} />
              <span>{g.title}</span>
            </button>
          );
        })}
        <div className="setup-label" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>Resources</div>
        {([['app', 'download', 'Download app'], ['contact', 'chat', 'Contact our team'], ['videos', 'play', 'Help videos'], ['updates', 'megaphone', 'Product updates']] as const).map(([k, i, l]) => (
          <button key={k} className="setup-nav-item" onClick={() => setResource(k)}><span className="setup-res-icon" aria-hidden="true"><Icon name={i} className="ic" /></span><span>{l}</span></button>
        ))}
      </aside>

      <section style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>Hi {me.user.name.split(' ')[0]}, <span style={{ color: 'var(--brand)' }}>happy {DAYS[new Date().getDay()]}!</span></h1>
        <p className="muted" style={{ marginTop: 0, maxWidth: 560 }}>Here’s where you set up UBOS. Go at your own pace — every step you finish ticks itself off.</p>
        {data && (
          <div className="row small" style={{ marginBottom: 16, gap: 10 }}>
            <div className="setup-bar" style={{ width: 220 }}><div style={{ width: `${pct}%` }} /></div>
            <span><b>{data.available.done}</b> of {data.available.total} available steps done ({pct}%)</span>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        {!data && !error && <div className="muted">Loading…</div>}
        {guide && (
          <>
            <h2 style={{ fontSize: 20, margin: '6px 0 2px' }}><span aria-hidden="true">{guide.icon}</span> {guide.title}</h2>
            <p className="small muted" style={{ marginTop: 0 }}>{guide.hint}</p>
            {guide.cards.map((c) => (
              <div key={c.id} className="card setup-card">
                <div className="row" style={{ flexWrap: 'nowrap', marginBottom: 8 }}>
                  <span className="setup-swatch" style={{ background: c.tone }} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{c.title}</b>
                    <div className="small muted">{c.hint}</div>
                  </div>
                  <div className="setup-bar" style={{ width: 90 }}><div style={{ width: `${(c.done / c.total) * 100}%` }} /></div>
                  <span className="small muted" style={{ width: 30, textAlign: 'right' }}>{c.done}/{c.total}</span>
                </div>
                {c.steps.map((s) => (
                  <div key={s.id} className={`setup-step ${s.done ? 'done' : ''}`}>
                    <span className={`setup-check ${s.done ? 'done' : s.skipped ? 'skipped' : ''}`} aria-label={s.done ? 'Done' : s.skipped ? 'Skipped' : 'Not done'}>{s.done ? '✓' : s.skipped ? '–' : ''}</span>
                    {s.available && s.href ? <Link href={s.href} className="setup-title">{s.title}</Link> : <span className="setup-title" style={{ color: s.available ? undefined : 'var(--muted)' }}>{s.title}</span>}
                    <span style={{ flex: 1 }} />
                    {!s.available && s.phase && <span className="badge grey">{phaseLabel(s.phase)}</span>}
                    {s.available && !s.done && <button className="btn sm ghost" onClick={() => skip(s)}>{s.skipped ? 'Undo skip' : 'Skip'}</button>}
                    <span className={`badge ${s.level === 'basic' ? 'ok' : 'warn'}`}>{s.level === 'basic' ? 'Basic' : 'Advanced'}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </section>

      {resource && (
        <div className="modal-bg" onClick={() => setResource(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {resource === 'app' && <><h2>Mobile app</h2><p>The UBOS Android app (SIM calling, call recording, follow-up reminders) arrives in Phase 2. Until then UBOS works in the phone’s browser.</p></>}
            {resource === 'contact' && <><h2>Contact our team</h2><p>In-app support chat and tickets arrive with the Platform Console upgrade (slice 1.8). Until then, contact the UBOS team through your account manager.</p></>}
            {resource === 'videos' && <><h2>Help videos</h2><p>Short videos for each guide step will be linked here as each feature is finished.</p></>}
            {resource === 'updates' && (
              <>
                <h2>Product updates</h2>
                <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
                  <li><b>Setup Guide</b> — this checklist, with progress that updates itself.</li>
                  <li><b>Settings & admin</b> — stage board with rules and SLA, Lead ID, H1 / H2, custom actions with scores, flexible lead filters, user bulk add, billing & licences.</li>
                  <li><b>Lead work</b> — bulk upload, bulk actions, calls, remarks, follow-ups, assignment rules.</li>
                  <li><b>Customer Master</b> — one customer across business lines, duplicates, merge with undo, Customer 360°.</li>
                  <li><b>Sign-in & security</b> — Google / Microsoft / email code, two-factor, IP allow-list, sessions.</li>
                </ul>
              </>
            )}
            <div className="row end"><button className="btn" onClick={() => setResource(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Ring({ value, done }: { value: number; done: boolean }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="9" cy="9" r={r} fill={done ? 'var(--ok)' : 'none'} stroke="var(--line)" strokeWidth="2" />
      {!done && value > 0 && <circle cx="9" cy="9" r={r} fill="none" stroke="var(--brand)" strokeWidth="2" strokeDasharray={`${c * value} ${c}`} transform="rotate(-90 9 9)" />}
      {done && <path d="M5.5 9.2l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" strokeWidth="1.8" />}
    </svg>
  );
}
