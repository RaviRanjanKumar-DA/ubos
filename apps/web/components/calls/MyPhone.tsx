'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Device { id: string; name: string; platform: string; appVersion: string | null; lastSyncAt: string | null; pendingCalls: number; revokedAt: string | null; createdAt: string }

/** Pair the SIM-calling phone app: a 6-digit code (10 minutes) + the organization code. One phone per person. */
export function MyPhoneCard() {
  const { me } = useShell();
  const [devices, setDevices] = useState<Device[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string; org: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [left, setLeft] = useState(0);
  const load = useCallback(() => api<Device[]>('/api/v1/devices', { noWorkspace: true }).then(setDevices).catch(() => setDevices([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((new Date(code.expiresAt).getTime() - Date.now()) / 1000));
      setLeft(s);
      if (!s) { setCode(null); load(); }
    }, 1000);
    return () => clearInterval(t);
  }, [code, load]);
  if (!me.features.includes('module.sim_calling')) return null;
  const active = devices.find((d) => !d.revokedAt);
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>My phone (SIM calling)</h2>
      <p className="small muted" style={{ marginTop: -6 }}>Pair the UBOS phone app once: calls you make from your own SIM — with their outcome and recording — then appear on your leads within seconds, even if the phone was offline for a while.</p>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {active ? (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span><b>📱 {active.name}</b> <span className="small muted">· app {active.appVersion ?? '?'} · last sync {active.lastSyncAt ? new Date(active.lastSyncAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet'}{active.pendingCalls ? ` · ${active.pendingCalls} call(s) waiting` : ''}</span></span>
          <button className="btn sm ghost" onClick={async () => { if (!confirm('Unpair this phone? It stops syncing at once.')) return; await api(`/api/v1/devices/${active.id}/revoke`, { method: 'POST', noWorkspace: true }).catch(() => undefined); setMsg({ type: 'notice', text: 'Phone unpaired.' }); load(); }}>Unpair</button>
        </div>
      ) : <p className="small">No phone paired yet.</p>}
      {code ? (
        <div className="pair-box">
          <div className="small muted">In the UBOS phone app enter</div>
          <div className="row" style={{ gap: 24, justifyContent: 'center', margin: '8px 0' }}>
            <div><div className="small muted">Organization code</div><b style={{ fontSize: 20 }}>{code.org}</b></div>
            <div><div className="small muted">Pairing code</div><b style={{ fontSize: 28, letterSpacing: 6 }}>{code.code}</b></div>
          </div>
          <div className="small muted">Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · {active ? 'pairing a new phone replaces the current one' : 'one phone per person'}</div>
        </div>
      ) : (
        <button className="btn outline" style={{ marginTop: 8 }} onClick={async () => {
          setMsg(null);
          try { setCode(await api<{ code: string; expiresAt: string; org: string }>('/api/v1/devices/pair-code', { method: 'POST', noWorkspace: true })); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
        }}>{active ? 'Pair a different phone' : 'Pair my phone'}</button>
      )}
    </div>
  );
}
