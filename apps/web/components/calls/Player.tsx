'use client';

import { useEffect, useState } from 'react';
import { recordingUrl } from '@/lib/live';

/** Loads a recording only when asked (each play is audited) and frees it afterwards. */
export function RecordingPlayer({ callId, workspaceId }: { callId: string; workspaceId?: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (src?.startsWith('blob:')) URL.revokeObjectURL(src); }, [src]);
  if (src) return src.startsWith('blob:') ? <audio src={src} controls autoPlay style={{ height: 32, maxWidth: 260 }} /> : <a className="btn sm ghost" href={src} target="_blank" rel="noreferrer">▶ Open at provider</a>;
  return (
    <span>
      <button className="btn sm ghost" disabled={busy} title="Play recording" onClick={async () => {
        setBusy(true); setErr('');
        try { setSrc(await recordingUrl(callId, workspaceId)); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
        setBusy(false);
      }}>{busy ? '…' : '▶ Play'}</button>
      {err && <span className="small" style={{ color: 'var(--bad)' }}> {err}</span>}
    </span>
  );
}

export const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
export const CHANNEL: Record<string, string> = { sim: '📱 SIM', cloud: '☁ Cloud', manual: '✍ Logged' };
