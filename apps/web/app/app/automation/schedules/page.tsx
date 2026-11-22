'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';

interface Def { key: string; title: string; detail: boolean; ready: boolean }
interface Sched { id: string; name: string; reportKey: string; range: string; frequency: string; weekday: number | null; monthDay: number | null; time: string; recipientIds: string[]; recipients: string[]; createdBy: string; isActive: boolean; nextRunAt: string; lastRunAt: string | null; lastStatus: string | null; workspaceId: string | null }
type Draft = { id: string | null; name: string; reportKey: string; range: string; workspaceId: string; frequency: string; weekday: number; monthDay: number; time: string; recipientIds: string[] };
const RANGES: [string, string][] = [['yesterday', 'Yesterday'], ['today', 'Today so far'], ['last_7_days', 'Last 7 days'], ['this_week', 'This week so far'], ['last_30_days', 'Last 30 days'], ['this_month', 'This month so far'], ['last_month', 'Last month']];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const every = (s: { frequency: string; weekday: number | null; monthDay: number | null; time: string }) => s.frequency === 'daily' ? `Every day at ${s.time}` : s.frequency === 'weekly' ? `Every ${DAYS[s.weekday ?? 1]} at ${s.time}` : `On day ${s.monthDay} of each month at ${s.time}`;

/** Reports emailed as CSV on a schedule. */
export default function Schedules() {
  const { me, can, version } = useShell();
  const [rows, setRows] = useState<Sched[] | null>(null);
  const [defs, setDefs] = useState<Def[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [d, setD] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(() => api<Sched[]>('/api/v1/automation/schedules', { noWorkspace: true }).then(setRows).catch((e) => setMsg({ type: 'error', text: e.message })), []);
  useEffect(() => { load(); api<{ reports: Def[] }>('/api/v1/reports').then((r) => setDefs(r.reports.filter((x) => x.ready))).catch(() => setDefs([])); }, [load, version]);
  useEffect(() => {
    (can('org.user.view') ? api<{ id: string; name: string; isActive: boolean }[]>('/api/v1/users', { noWorkspace: true }).then((u) => u.filter((x) => x.isActive)) : Promise.resolve([{ id: me.user.id, name: me.user.name }]))
      .then(setPeople).catch(() => setPeople([{ id: me.user.id, name: me.user.name }]));
  }, [can, me.user.id, me.user.name]);
  const act = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; } };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!d) return;
    const body = { name: d.name, reportKey: d.reportKey, range: d.range, workspaceId: d.workspaceId || null, frequency: d.frequency, weekday: d.frequency === 'weekly' ? d.weekday : null, monthDay: d.frequency === 'monthly' ? d.monthDay : null, time: d.time, recipientIds: d.recipientIds };
    if (await act(() => api(d.id ? `/api/v1/automation/schedules/${d.id}` : '/api/v1/automation/schedules', { method: d.id ? 'PUT' : 'POST', body, noWorkspace: true }), 'Schedule saved.')) setD(null);
  };
  const blank = (): Draft => ({ id: null, name: '', reportKey: 'leaderboard', range: 'yesterday', workspaceId: '', frequency: 'daily', weekday: 1, monthDay: 1, time: '09:00', recipientIds: [me.user.id] });

  return (
    <>
      <div className="page-head">
        <div><h1>Schedules</h1><div className="muted small">Email any report as a CSV that opens in Excel, every day, week or month (India time).</div></div>
        <button className="btn" onClick={() => setD(blank())}><Icon name="plus" className="ic" />New schedule</button>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Schedule</th><th>When</th><th>To</th><th>Next / last</th><th /></tr></thead>
            <tbody>
              {rows?.map((s) => (
                <tr key={s.id} style={s.isActive ? undefined : { opacity: 0.6 }}>
                  <td><b>{s.name}</b><div className="small muted">{defs.find((x) => x.key === s.reportKey)?.title ?? s.reportKey} · {RANGES.find(([k]) => k === s.range)?.[1]} · by {s.createdBy}</div></td>
                  <td className="small">{every(s)}</td>
                  <td className="small">{s.recipients.join(', ')}</td>
                  <td className="small">{s.isActive ? `Next ${when(s.nextRunAt)}` : 'Paused'}{s.lastStatus && <div className={s.lastStatus.startsWith('failed') ? 'kpi-bad' : 'muted'}>{s.lastStatus.startsWith('failed') ? s.lastStatus : `Last sent ${when(s.lastRunAt!)}`}</div>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" onClick={() => act(() => api(`/api/v1/automation/schedules/${s.id}`, { method: 'PATCH', body: { runNow: true }, noWorkspace: true }), 'It will be sent within a minute.')}>Send now</button>
                    <button className="btn ghost sm" onClick={() => setD({ id: s.id, name: s.name, reportKey: s.reportKey, range: s.range, workspaceId: s.workspaceId ?? '', frequency: s.frequency, weekday: s.weekday ?? 1, monthDay: s.monthDay ?? 1, time: s.time, recipientIds: s.recipientIds })}>Edit</button>
                    <button className="btn ghost sm" onClick={() => act(() => api(`/api/v1/automation/schedules/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive }, noWorkspace: true }), s.isActive ? 'Paused.' : 'Resumed.')}>{s.isActive ? 'Pause' : 'Resume'}</button>
                    <button className="btn ghost sm" onClick={async () => { if (await askConfirm(`Archive "${s.name}"? No more emails are sent.`)) act(() => api(`/api/v1/automation/schedules/${s.id}`, { method: 'PATCH', body: { isArchived: true }, noWorkspace: true }), 'Archived.'); }}>Archive</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && !rows.length && <div className="empty">No schedules yet. Example: yesterday&apos;s call report to every manager at 9 am.</div>}
        </div>
      </div>
      <p className="small muted">A schedule sends what its creator can see. Lead lists need “Export leads”.</p>

      {d && (
        <div className="modal-bg">
          <form className="modal hr-modal" onSubmit={save}>
            <h2>{d.id ? 'Edit schedule' : 'New schedule'}</h2>
            <div className="field"><label htmlFor="sc-n">Name</label><input id="sc-n" className="input" required minLength={2} maxLength={80} placeholder="e.g. Daily call report" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="sc-r">Report</label><select id="sc-r" className="input" value={d.reportKey} onChange={(e) => setD({ ...d, reportKey: e.target.value })}>{defs.map((x) => <option key={x.key} value={x.key}>{x.title}{x.detail && !can('crm.lead.export') ? ' (needs Export leads)' : ''}</option>)}</select></div>
              <div className="field"><label htmlFor="sc-p">Period in the email</label><select id="sc-p" className="input" value={d.range} onChange={(e) => setD({ ...d, range: e.target.value })}>{RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              {me.workspaces.length > 1 && <div className="field"><label htmlFor="sc-w">Business line</label><select id="sc-w" className="input" value={d.workspaceId} onChange={(e) => setD({ ...d, workspaceId: e.target.value })}><option value="">All</option>{me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>}
              <div className="field"><label htmlFor="sc-f">How often</label><select id="sc-f" className="input" value={d.frequency} onChange={(e) => setD({ ...d, frequency: e.target.value })}><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></select></div>
              {d.frequency === 'weekly' && <div className="field"><label htmlFor="sc-wd">Day</label><select id="sc-wd" className="input" value={d.weekday} onChange={(e) => setD({ ...d, weekday: Number(e.target.value) })}>{DAYS.map((x, i) => <option key={x} value={i}>{x}</option>)}</select></div>}
              {d.frequency === 'monthly' && <div className="field"><label htmlFor="sc-md">Day of the month</label><input id="sc-md" className="input" type="number" min={1} max={28} value={d.monthDay} onChange={(e) => setD({ ...d, monthDay: Number(e.target.value) })} /></div>}
              <div className="field"><label htmlFor="sc-t">Time (India)</label><input id="sc-t" className="input" type="time" required value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} /></div>
            </div>
            <div className="field"><label>Send to</label>
              <div className="chips">{people.map((p) => <button type="button" key={p.id} className={`chip ${d.recipientIds.includes(p.id) ? 'on' : ''}`} onClick={() => setD({ ...d, recipientIds: d.recipientIds.includes(p.id) ? d.recipientIds.filter((x) => x !== p.id) : [...d.recipientIds, p.id] })}>{p.name}</button>)}</div>
            </div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setD(null)}>Go back</button><button className="btn" disabled={!d.recipientIds.length}>Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
