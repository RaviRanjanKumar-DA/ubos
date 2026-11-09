'use client';

import { Icon } from '@/components/Icon';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { istDay, istDayStart } from '@/lib/ist';
import { useShell } from '@/components/AppShell';
import { TaskDialog, TaskRow } from '@/components/TaskDialog';
import { relTime } from '@/lib/workspace';

interface CalEvent { kind: 'task' | 'meeting' | 'call' | 'follow_up'; id: string; title: string; at: string; durationMin: number | null; done: boolean; assignee: string | null; leadId: string | null; leadName: string | null; location: string | null }
type Person = { id: string; name: string };
const KIND: Record<CalEvent['kind'], [string, string]> = { meeting: ['leads', 'Meeting'], task: ['tick', 'Task'], call: ['calls', 'Call'], follow_up: ['clock', 'Follow-up'] };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** A square on the grid, as a date (the same form as istDay). */
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const thisMonth = () => { const t = istDay(new Date()); return new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, 1); };
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

export default function CalendarPage() {
  const { me, can, version } = useShell();
  const [month, setMonth] = useState(thisMonth);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [who, setWho] = useState('');
  const [picked, setPicked] = useState<CalEvent | null>(null);
  const [dialog, setDialog] = useState<{ task?: TaskRow; date?: Date } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const wide = me.permissions['crm.lead.view'] && me.permissions['crm.lead.view'] !== 'OWN';

  // Grid: whole weeks (Monday first) covering the month.
  const grid = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    return days.slice(0, days[35].getMonth() === month.getMonth() ? 42 : 35);
  }, [month]);

  const load = useCallback(() => {
    const from = istDayStart(dayKey(grid[0])).toISOString();
    const to = new Date(istDayStart(dayKey(grid[grid.length - 1])).getTime() + 86_400_000).toISOString();
    api<CalEvent[]>(`/api/v1/calendar?from=${from}&to=${to}${who ? `&assigneeId=${who}` : ''}`).then(setEvents).catch((e) => setMsg({ type: 'error', text: e.message }));
    api<TaskRow[]>(`/api/v1/tasks?status=open${who ? `&assigneeId=${who}` : ''}`).then(setTasks).catch(() => setTasks([]));
  }, [grid, who]);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    if (!wide) return;
    (me.currentWorkspaceId ? api<Person[]>(`/api/v1/workspaces/${me.currentWorkspaceId}/assignees`) : can('org.user.view') ? api<(Person & { isActive: boolean })[]>('/api/v1/users').then((u) => u.filter((x) => x.isActive)) : Promise.resolve([]))
      .then((p) => setPeople(p.map((x) => ({ id: x.id, name: x.name })))).catch(() => setPeople([]));
  }, [version, wide, me.currentWorkspaceId, can]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events ?? []) { const k = istDay(new Date(e.at)); m.set(k, [...(m.get(k) ?? []), e]); }
    return m;
  }, [events]);

  async function complete(e: CalEvent) {
    setMsg(null);
    try {
      if (e.kind === 'follow_up') await api(`/api/v1/follow-ups/${e.id}`, { method: 'PATCH', body: { done: true } });
      else await api(`/api/v1/tasks/${e.id}`, { method: 'PATCH', body: { done: !e.done } });
      setPicked(null);
      load();
    } catch (err) { setMsg({ type: 'error', text: err instanceof ApiError ? err.message : 'Failed' }); }
  }

  const today = istDay(new Date());
  const overdue = tasks.filter((t) => t.overdue);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar & Tasks</h1>
          <div className="small muted">Meetings, tasks, planned calls and lead follow-ups in one place. Reminders arrive before each one.</div>
        </div>
        <div className="row">
          {wide && people.length > 0 && (
            <select className="input" style={{ width: 'auto' }} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
              <option value="">Everyone I can see</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.user.id ? 'Me' : p.name}</option>)}
            </select>
          )}
          <button className="btn" onClick={() => setDialog({})}>+ New task / meeting</button>
        </div>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div className="cal-layout">
        <div className="card cal">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <div className="row">
              <button className="btn sm outline" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
              <button className="btn sm outline" onClick={() => setMonth(thisMonth())}>Today</button>
              <button className="btn sm outline" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">›</button>
            </div>
            <h2 style={{ margin: 0 }}>{month.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'long', year: 'numeric' })}</h2>
            <div className="row small" style={{ gap: 10 }}>{Object.entries(KIND).map(([k, [i, l]]) => <span key={k} className={`cal-key k-${k}`}><Icon name={i} className="ic" /> {l}</span>)}</div>
          </div>
          <div className="cal-grid">
            {DAYS.map((d) => <div key={d} className="cal-dow">{d}</div>)}
            {grid.map((d) => {
              const list = byDay.get(dayKey(d)) ?? [];
              return (
                <div key={d.toISOString()} className={`cal-day ${d.getMonth() !== month.getMonth() ? 'other' : ''} ${dayKey(d) === today ? 'today' : ''}`}
                  onDoubleClick={() => { setDialog({ date: new Date(istDayStart(dayKey(d)).getTime() + 11 * 3_600_000) }); }}>
                  <div className="cal-date">{d.getDate()}</div>
                  {list.slice(0, 4).map((e) => (
                    <button key={`${e.kind}-${e.id}`} className={`cal-ev k-${e.kind} ${e.done ? 'done' : ''}`} onClick={() => setPicked(e)} title={`${KIND[e.kind][1]}: ${e.title}`}>
                      <span>{time(e.at)}</span> {e.title}
                    </button>
                  ))}
                  {list.length > 4 && <button className="cal-more" onClick={() => setPicked(list[4])}>+{list.length - 4} more</button>}
                </div>
              );
            })}
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>Double-click a day to plan something on it.</div>
        </div>

        <div className="card">
          <h2>Open tasks {overdue.length > 0 && <span className="badge bad">{overdue.length} overdue</span>}</h2>
          {!tasks.length && <p className="small muted">Nothing open.</p>}
          {tasks.slice(0, 30).map((t) => (
            <div key={t.id} className="task-row">
              <input type="checkbox" aria-label={`Done: ${t.title}`} onChange={() => complete({ kind: t.type, id: t.id, done: false } as CalEvent)} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <button className="link-btn" onClick={() => setDialog({ task: t })}><Icon name={KIND[t.type][0]} className="ic" /> {t.title}</button>
                <div className="small muted">
                  <span style={{ color: t.overdue ? 'var(--bad)' : undefined }}>{relTime(t.dueAt)}</span>
                  {t.leadId && <> · <Link href={`/app/leads/${t.leadId}`}>{t.leadName}</Link></>}
                  {t.assigneeId !== me.user.id && <> · {t.assignee}</>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {picked && (
        <div className="modal-bg" onClick={() => setPicked(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="small muted"><Icon name={KIND[picked.kind][0]} className="ic" /> {KIND[picked.kind][1]}{picked.done ? ' · done' : ''}</div>
            <h2 style={{ marginTop: 4 }}>{picked.title}</h2>
            <p className="small">{new Date(picked.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' })}{picked.durationMin ? ` · ${picked.durationMin} min` : ''}</p>
            {picked.location && <p className="small"><Icon name="pin" className="ic" /> {/^https?:/.test(picked.location) ? <a href={picked.location} target="_blank" rel="noreferrer">{picked.location}</a> : picked.location}</p>}
            {picked.assignee && <p className="small muted">Assigned to {picked.assignee}</p>}
            <div className="row end">
              {picked.leadId && <Link className="btn outline" href={`/app/leads/${picked.leadId}`}>Open {picked.leadName ?? 'lead'}</Link>}
              {!(picked.kind === 'follow_up' && picked.done) && <button className="btn" onClick={() => complete(picked)}>{picked.done ? 'Mark not done' : 'Mark done'}</button>}
            </div>
          </div>
        </div>
      )}
      {dialog && (
        <TaskDialog task={dialog.task} defaultDate={dialog.date} people={people} canAssign={can('crm.lead.assign')} meId={me.user.id}
          onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); setMsg({ type: 'notice', text: 'Saved.' }); }} />
      )}
    </>
  );
}
