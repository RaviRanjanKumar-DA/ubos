'use client';

import { Icon } from '@/components/Icon';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface Settings { digestHour: number; reminderMinutes: number; digestEnabled: boolean; lastDigestAt: string | null; canManage: boolean }
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'am' : 'pm'}`;

/** Organization: when the daily summary goes out and how early reminders arrive; "Run now" for admins. */
export function RemindersCard() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  useEffect(() => { api<Settings>('/api/v1/settings/notifications', { noWorkspace: true }).then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  async function save() {
    setMsg(null);
    try { await api('/api/v1/settings/notifications', { method: 'PUT', noWorkspace: true, body: { digestHour: s!.digestHour, reminderMinutes: s!.reminderMinutes } }); setMsg({ type: 'notice', text: 'Reminder settings saved.' }); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  }
  async function runNow() {
    setMsg(null);
    try {
      const r = await api<{ reminders: number; digests: number; dashboards: number }>('/api/v1/automation/run-now', { method: 'POST', noWorkspace: true });
      setMsg({ type: 'notice', text: `Sent ${r.reminders} reminder(s), ${r.digests} daily summary email(s) and ${r.dashboards} dashboard email(s).` });
    } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  }
  return (
    <div className="card" style={{ marginTop: 14, maxWidth: 760 }}>
      <h2>Reminders & daily summary</h2>
      <p className="small muted">Everyone gets an in-app and email reminder before each task, meeting and follow-up, and a morning summary of their day. People can switch their own summary off in My Security.</p>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="grid cols-2">
        <div className="field"><label>Daily summary at</label>
          <select className="input" value={s.digestHour} onChange={(e) => setS({ ...s, digestHour: Number(e.target.value) })} disabled={!s.canManage}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </div>
        <div className="field"><label>Remind before</label>
          <select className="input" value={s.reminderMinutes} onChange={(e) => setS({ ...s, reminderMinutes: Number(e.target.value) })} disabled={!s.canManage}>
            {[0, 5, 10, 15, 30, 60, 120, 1440].map((m) => <option key={m} value={m}>{m === 0 ? 'At the time' : m < 60 ? `${m} minutes` : m === 1440 ? '1 day' : `${m / 60} hour(s)`}</option>)}
          </select>
        </div>
      </div>
      {s.canManage && (
        <div className="row end">
          <button type="button" className="btn ghost" onClick={runNow} title="Sends whatever is due right now">Run now</button>
          <button type="button" className="btn" onClick={save}>Save</button>
        </div>
      )}
    </div>
  );
}

/** Personal: switch my own daily summary email on or off. */
export function MyNotificationsCard() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api<Settings>('/api/v1/settings/notifications', { noWorkspace: true }).then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Notifications</h2>
      <label className="row">
        <input type="checkbox" checked={s.digestEnabled} onChange={async (e) => {
          const v = e.target.checked;
          await api('/api/v1/me/notifications', { method: 'PUT', noWorkspace: true, body: { digestEnabled: v } }).catch(() => undefined);
          setS({ ...s, digestEnabled: v }); setMsg(v ? 'Daily summary switched on.' : 'Daily summary switched off.');
        }} />
        Email me a summary of my day every morning ({hourLabel(s.digestHour)})
      </label>
      <p className="small muted" style={{ marginBottom: 0 }}>Reminders before tasks, meetings and follow-ups always arrive in the bell and by email.{msg ? ` ${msg}` : ''}</p>
    </div>
  );
}

interface Calling { plan: string | null; cloudCalling: boolean; simCalling: boolean; planRetentionDays: number; recordingMode: 'ubos' | 'provider'; recordingRetentionDays: number | null; effectiveRetentionDays: number; canManage: boolean; unknownCallerWorkspaceId: string | null; dispositionRequired: boolean; workspaces: { id: string; name: string }[] }

/** Which calling the plan includes and how call recordings are stored. */
export function CallingCard() {
  const [c, setC] = useState<Calling | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  useEffect(() => { api<Calling>('/api/v1/settings/calling', { noWorkspace: true }).then(setC).catch(() => setC(null)); }, []);
  if (!c) return null;
  async function save() {
    setMsg(null);
    try {
      await api('/api/v1/settings/calling', { method: 'PUT', noWorkspace: true, body: { recordingMode: c!.recordingMode, recordingRetentionDays: c!.recordingRetentionDays, unknownCallerWorkspaceId: c!.unknownCallerWorkspaceId, dispositionRequired: c!.dispositionRequired } });
      setMsg({ type: 'notice', text: 'Recording settings saved.' });
    } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  }
  return (
    <div className="card" style={{ marginTop: 14, maxWidth: 760 }}>
      <h2>Calls & recordings</h2>
      <div className="row" style={{ gap: 14, marginBottom: 10 }}>
        <span className={`badge ${c.cloudCalling ? 'ok' : 'grey'}`}><Icon name="calls" className="ic" />Cloud calling {c.cloudCalling ? 'included' : 'not in your plan'}</span>
        <span className={`badge ${c.simCalling ? 'ok' : 'grey'}`}><Icon name="phone" className="ic" />SIM calling {c.simCalling ? 'included' : 'not in your plan'}</span>
        <span className="small muted">{c.plan} keeps recordings up to {c.planRetentionDays} days</span>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {(c.cloudCalling || c.simCalling) ? (
        <>
          <div className="dup-modes">
            <label className={`dup-mode ${c.recordingMode === 'ubos' ? 'on' : ''}`}><input type="radio" checked={c.recordingMode === 'ubos'} onChange={() => setC({ ...c, recordingMode: 'ubos' })} disabled={!c.canManage} /> Copy cloud-call recordings into UBOS storage (plays even if the provider deletes them; counts towards storage)</label>
            <label className={`dup-mode ${c.recordingMode === 'provider' ? 'on' : ''}`}><input type="radio" checked={c.recordingMode === 'provider'} onChange={() => setC({ ...c, recordingMode: 'provider' })} disabled={!c.canManage} /> Keep cloud-call recordings at the provider — UBOS stores only the link</label>
          </div>
          <p className="small muted">SIM-call recordings are uploaded from the phone into UBOS storage (encrypted), linked to the call on the lead.</p>
          <div className="field" style={{ maxWidth: 300 }}>
            <label>Delete recordings after (days)</label>
            <input className="input" type="number" min={1} max={c.planRetentionDays} placeholder={`Plan limit: ${c.planRetentionDays}`} value={c.recordingRetentionDays ?? ''} disabled={!c.canManage}
              onChange={(e) => setC({ ...c, recordingRetentionDays: e.target.value ? Number(e.target.value) : null })} />
          </div>
          <div className="field" style={{ maxWidth: 420 }}>
            <label>Calls from numbers not in UBOS</label>
            <select className="input" value={c.unknownCallerWorkspaceId ?? ''} disabled={!c.canManage} onChange={(e) => setC({ ...c, unknownCallerWorkspaceId: e.target.value || null })}>
              <option value="">Keep them as “unknown numbers” to put on a lead by hand</option>
              {c.workspaces.map((w) => <option key={w.id} value={w.id}>Incoming calls become a new lead in {w.name}</option>)}
            </select>
          </div>
          <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" checked={c.dispositionRequired} disabled={!c.canManage} onChange={(e) => setC({ ...c, dispositionRequired: e.target.checked })} /> The phone app asks for the call outcome after every call</label>
          {c.canManage && <div className="row end"><button type="button" className="btn" onClick={save}>Save</button></div>}
        </>
      ) : <p className="small muted">Your plan has no calling. Upgrade on Billing & Licences to add cloud calling, SIM calling or both.</p>}
    </div>
  );
}
