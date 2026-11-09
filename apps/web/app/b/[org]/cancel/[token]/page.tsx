'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { API_URL } from '@/lib/api';

interface Info { organization: string; name: string; startAt: string; status: string; canCancel: boolean }

/** The link in a booking confirmation. Opening it changes nothing; the button cancels. */
export default function CancelBookingPage() {
  const { org, token } = useParams<{ org: string; token: string }>();
  const url = `${API_URL}/public/booking/${encodeURIComponent(org)}/cancel/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => fetch(url).then(async (r) => (r.ok ? setInfo(await r.json()) : setError('This booking was not found.'))).catch(() => setError('This page could not be loaded.'));
  useEffect(() => { load(); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  async function cancel() {
    setBusy(true); setError('');
    const r = await fetch(url, { method: 'POST' }).catch(() => null);
    if (r?.ok) await load(); else setError('The booking could not be cancelled. Please try again.');
    setBusy(false);
  }
  const when = info && new Date(info.startAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
  return (
    <div className="pub-wrap">
      <div className="pub-form">
        {error && <div className="error">{error}</div>}
        {!info && !error && <div className="muted">Loading…</div>}
        {info && (
          <>
            <div className="small muted">{info.organization}</div>
            <h2>{info.status === 'cancelled' ? 'Your meeting is cancelled' : 'Your meeting'}</h2>
            <p>{when} IST</p>
            {info.canCancel && <button className="btn danger" disabled={busy} onClick={cancel}>{busy ? 'Cancelling…' : 'Cancel this meeting'}</button>}
            {!info.canCancel && info.status === 'booked' && <p className="small muted">This meeting has already started.</p>}
          </>
        )}
      </div>
    </div>
  );
}
