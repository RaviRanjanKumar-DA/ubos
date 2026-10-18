'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Cover { id: string; userId: string; coverUserId: string; userName: string; coverName: string; startsAt: string; endsAt: string; note: string | null; isActive: boolean }

const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' });

/** Accepting new leads on / off, and "I'm away — X covers for me" (user managers can set it for anyone). */
export function AvailabilityCard() {
  const { me, can } = useShell();
  const [accepting, setAccepting] = useState(true);
  const [covers, setCovers] = useState<Cover[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ userId: '', coverUserId: '', startsAt: '', endsAt: '', note: '' });
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const manager = can('org.user.manage');

  const load = useCallback(async () => {
    const a = await api<{ acceptingLeads: boolean; covers: Cover[] }>('/api/v1/me/availability', { noWorkspace: true }).catch(() => null);
    if (a) setAccepting(a.acceptingLeads);
    const all = manager ? await api<Cover[]>('/api/v1/covers', { noWorkspace: true }).catch(() => null) : null;
    setCovers(all ?? a?.covers ?? []);
  }, [manager]);
  useEffect(() => {
    load();
    api<{ id: string; name: string; isActive?: boolean }[]>('/api/v1/users', { noWorkspace: true })
      .then((u) => setPeople(u.filter((x) => x.isActive !== false).map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => (me.currentWorkspaceId
        ? api<{ id: string; name: string }[]>(`/api/v1/workspaces/${me.currentWorkspaceId}/assignees`).then(setPeople)
        : Promise.resolve(setPeople([]))).catch(() => setPeople([])));
  }, [load, me.currentWorkspaceId]);

  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Availability</h2>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <label className="row">
        <input type="checkbox" checked={accepting} onChange={(e) => {
          const v = e.target.checked;
          act(() => api('/api/v1/me/accepting-leads', { method: 'PUT', noWorkspace: true, body: { accepting: v } }), v ? 'You will receive new leads again.' : 'Automatic assignment will skip you until you switch this back on.');
        }} />
        I’m accepting new leads (automatic assignment)
      </label>
      <p className="small muted" style={{ marginTop: 4 }}>Switch off when you are full. Managers can still hand you a lead by hand.</p>

      <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>Away / temporary cover</h3>
      <p className="small muted" style={{ marginTop: 0 }}>While someone is away, their new leads and process steps go to the cover person, who can also open their leads.</p>
      {covers.map((c) => (
        <div key={c.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <span className="small"><b>{c.userName}</b> → covered by <b>{c.coverName}</b> · {day(c.startsAt)} – {day(c.endsAt)} {c.isActive ? <span className="badge warn">Now</span> : <span className="badge grey">Upcoming</span>}{c.note ? ` · ${c.note}` : ''}</span>
          {(c.userId === me.user.id || manager) && <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/covers/${c.id}/cancel`, { method: 'POST', noWorkspace: true }), 'Cover ended.')}>End</button>}
        </div>
      ))}
      <form className="grid cols-3" style={{ marginTop: 10 }} onSubmit={(e) => {
        e.preventDefault();
        act(() => api('/api/v1/covers', { method: 'POST', noWorkspace: true, body: {
          userId: form.userId || undefined, coverUserId: form.coverUserId, note: form.note || null,
          startsAt: new Date(`${form.startsAt}T00:00:00`).toISOString(), endsAt: new Date(`${form.endsAt}T23:59:00`).toISOString(),
        } }), 'Cover set — the cover person has been notified.').then((ok) => ok && setForm({ userId: '', coverUserId: '', startsAt: '', endsAt: '', note: '' }));
      }}>
        {manager && (
          <div className="field"><label>Who is away</label>
            <select className="input" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
              <option value="">Me</option>
              {people.filter((p) => p.id !== me.user.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div className="field"><label>Covered by</label>
          <select className="input" value={form.coverUserId} onChange={(e) => setForm({ ...form, coverUserId: e.target.value })} required>
            <option value="">Choose…</option>
            {people.filter((p) => p.id !== (form.userId || me.user.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field"><label>From</label><input className="input" type="date" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required /></div>
        <div className="field"><label>To</label><input className="input" type="date" value={form.endsAt} min={form.startsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} required /></div>
        <div className="field"><label>Note</label><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="On leave, training…" /></div>
        <div className="row end" style={{ alignSelf: 'end', marginBottom: 12 }}><button className="btn outline">Set cover</button></div>
      </form>
      {!people.length && <p className="small muted">Ask your administrator to set a cover for you.</p>}
    </div>
  );
}
