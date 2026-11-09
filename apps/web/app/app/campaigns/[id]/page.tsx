'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { fromIstInput } from '@/lib/ist';

interface Item {
  id: string; leadId: string; name: string; mobile: string | null; city: string | null; stage: string; status: string | null; source: string; lastOutcome: string | null; attempt: number; maxAttempts: number; dialed: boolean;
  script: { title: string; body: string } | null;
}
interface Next { item: Item | null; reason?: string; retryAt?: string | null; dispositions?: { value: string; label: string; connected: boolean }[]; total: number; finished: number }

const when = (d: string) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const EMPTY: Record<string, string> = {
  paused: 'This campaign is paused by your manager.', completed: 'This campaign is complete.', finished: 'All done. Every lead on this list has been worked.',
  not_your_leads: 'The leads left on this list belong to other people. Ask your manager if you should have them.',
};

/** The dialer: one lead at a time. Once dialed, the outcome must be saved before the next lead opens. */
export default function DialerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Next | null>(null);
  const [blocked, setBlocked] = useState<{ text: string; campaignId?: string } | null>(null);
  const [disposition, setDisposition] = useState('');
  const [remark, setRemark] = useState('');
  const [minutes, setMinutes] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [note, setNote] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [telNumber, setTelNumber] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setDisposition(''); setRemark(''); setMinutes(''); setFollowUp(''); setTelNumber(false);
    try { setData(await api<Next>(`/api/v1/call-campaigns/${id}/next`, { method: 'POST' })); setBlocked(null); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'OUTCOME_REQUIRED') setBlocked({ text: e.message });
      else setNote({ type: 'error', text: e instanceof ApiError ? e.message : 'Could not load the next lead' });
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const item = data?.item ?? null;
  const dial = async () => {
    if (!item) return;
    setBusy(true); setNote(null);
    try {
      await api(`/api/v1/call-campaigns/items/${item.id}/dialed`, { method: 'POST' });
      setData({ ...data!, item: { ...item, dialed: true } });
      const r = await api<{ message: string }>(`/api/v1/leads/${item.leadId}/dial`, { method: 'POST', body: {} });
      setNote({ type: 'notice', text: r.message });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NO_CALLING') { setTelNumber(true); setNote({ type: 'notice', text: 'Calling from UBOS is not set up for you. Call from your phone, then save the outcome.' }); }
      else setNote({ type: 'error', text: e instanceof ApiError ? e.message : 'The call could not start' });
    }
    setBusy(false);
  };
  const skip = async () => {
    if (!item) return;
    setBusy(true);
    try { await api(`/api/v1/call-campaigns/items/${item.id}/skip`, { method: 'POST' }); setNote(null); await load(); }
    catch (e) { setNote({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
    setBusy(false);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item || !disposition) return;
    setBusy(true);
    try {
      const r = await api<{ willRetry: boolean }>(`/api/v1/call-campaigns/items/${item.id}/outcome`, {
        method: 'POST',
        body: { disposition, remark: remark || undefined, durationSec: minutes ? Math.round(Number(minutes) * 60) : undefined, followUpAt: followUp ? fromIstInput(followUp).toISOString() : undefined },
      });
      setNote({ type: 'notice', text: r.willRetry ? `Saved. ${item.name} comes back for another try.` : `Saved for ${item.name}.` });
      await load();
    } catch (x) { setNote({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }); }
    setBusy(false);
  };

  const pct = data?.total ? Math.round((data.finished / data.total) * 100) : 0;
  const canTel = item?.mobile && !item.mobile.includes('*');
  return (
    <>
      <div className="page-head">
        <div><h1>Calling</h1><p className="muted small page-note"><Link href="/app/campaigns">Back to campaigns</Link></p></div>
        {data && <span className="small muted">{data.finished} of {data.total} finished</span>}
      </div>
      {data && <div className="progress dialer-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Campaign progress"><span style={{ width: `${pct}%` }} /></div>}
      {note && <div className={note.type}>{note.text}</div>}
      {blocked ? <div className="card empty">{blocked.text} <Link href="/app/campaigns">Open your campaigns</Link></div>
        : !data ? <div className="card muted">Loading…</div>
        : !item ? (
          <div className="card empty">
            <p>{data.reason === 'retry_later' && data.retryAt ? `Nothing to call right now. The next retry is at ${when(data.retryAt)}.` : EMPTY[data.reason ?? 'finished']}</p>
            {data.reason === 'retry_later' && <button className="btn outline" onClick={load}>Check again</button>}
          </div>
        ) : (
          <div className="dialer">
            <div className="card">
              <div className="camp-top">
                <div>
                  <h2 className="dialer-name">{item.name}</h2>
                  <div className="dialer-phone">{item.mobile ?? 'Number hidden'}</div>
                </div>
                <span className="badge">Try {item.attempt} of {item.maxAttempts}</span>
              </div>
              <dl className="dialer-facts">
                <div><dt>Stage</dt><dd>{item.stage || '—'}</dd></div>
                <div><dt>Status</dt><dd>{item.status ?? '—'}</dd></div>
                <div><dt>Source</dt><dd>{item.source}</dd></div>
                <div><dt>Last outcome</dt><dd>{item.lastOutcome ?? 'Never called'}</dd></div>
                {item.city && <div><dt>City</dt><dd>{item.city}</dd></div>}
              </dl>
              <div className="row camp-actions">
                <button className="btn" onClick={dial} disabled={busy}>{item.dialed ? 'Call again' : 'Call'}</button>
                {telNumber && canTel && <a className="btn outline" href={`tel:${item.mobile}`}>Open phone dialer</a>}
                <button className="btn ghost" onClick={skip} disabled={busy || item.dialed} title={item.dialed ? 'You called this lead. Save the outcome first.' : 'Come back to this lead later'}>Skip</button>
                <Link className="btn ghost" href={`/app/leads/${item.leadId}`} target="_blank">Open lead</Link>
              </div>
              {item.script && <details className="dialer-script" open><summary>{item.script.title}</summary><p>{item.script.body}</p></details>}
            </div>
            <form className="card" onSubmit={save}>
              <h2 className="form-head">Outcome <span className="muted small">required</span></h2>
              <div className="chips dialer-outcomes">
                {data.dispositions?.map((d) => <button type="button" key={d.value} className={`chip ${disposition === d.value ? 'on' : ''}`} aria-pressed={disposition === d.value} onClick={() => setDisposition(d.value)}>{d.label}</button>)}
              </div>
              <div className="field"><label htmlFor="dial-remark">Remark</label><textarea id="dial-remark" className="input" rows={3} maxLength={2000} value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
              <div className="form-two">
                <div className="field"><label htmlFor="dial-min">Talk time (minutes)</label><input id="dial-min" className="input" type="number" min={0} step={0.5} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></div>
                <div className="field"><label htmlFor="dial-fu">Next follow-up (IST)</label><input id="dial-fu" className="input" type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></div>
              </div>
              <button className="btn dialer-save" disabled={busy || !disposition}>Save and next lead</button>
            </form>
          </div>
        )}
    </>
  );
}
