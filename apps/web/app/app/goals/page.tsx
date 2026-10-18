'use client';

import { useCallback, useEffect, useState } from 'react';
import { GOAL_METRICS, METRICS } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { fmt } from '@/components/dashboard/charts';

interface Goal {
  id: string; name: string; metric: string; format: string; period: 'week' | 'month' | 'quarter'; target: number; value: number; percent: number;
  onTrack: boolean; periodLabel: string; who: string; isMine: boolean; userId: string | null; teamId: string | null; workspaceId: string | null;
}
type Opt = { id: string; name: string };
const PERIOD: Record<string, string> = { week: 'Weekly', month: 'Monthly', quarter: 'Quarterly' };

/** Goals & targets: managers set them; everyone sees their own (and their team's) progress, updated live. */
export default function GoalsPage() {
  const { me, can, version } = useShell();
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [people, setPeople] = useState<Opt[]>([]);
  const [teams, setTeams] = useState<Opt[]>([]);
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const canManage = can('crm.goal.manage');

  const load = useCallback(() => api<Goal[]>('/api/v1/goals').then(setGoals).catch((e) => setMsg({ type: 'error', text: e.message })), []);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    if (!canManage) return;
    (me.currentWorkspaceId ? api<Opt[]>(`/api/v1/workspaces/${me.currentWorkspaceId}/assignees`) : api<(Opt & { isActive: boolean })[]>('/api/v1/users').then((u) => u.filter((x) => x.isActive)))
      .then((p) => setPeople(p.map((x) => ({ id: x.id, name: x.name })))).catch(() => setPeople([]));
    api<{ branches: { departments: { teams: Opt[] }[] }[] }>('/api/v1/org/structure', { noWorkspace: true })
      .then((o) => setTeams(o.branches.flatMap((b) => b.departments.flatMap((d) => d.teams)))).catch(() => setTeams([]));
  }, [canManage, me.currentWorkspaceId, version]);

  const save = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); await load(); setMsg({ type: 'notice', text }); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  };
  const mine = goals?.filter((g) => g.isMine) ?? [];
  const others = goals?.filter((g) => !g.isMine) ?? [];

  const Card = ({ g }: { g: Goal }) => (
    <div className="card goal-card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="small muted">{g.who} · {PERIOD[g.period]} · {g.periodLabel}</div>
          <b style={{ fontSize: 15 }}>{g.name}</b>
        </div>
        <span className={`badge ${g.percent >= 100 ? 'ok' : g.onTrack ? '' : 'warn'}`}>{g.percent >= 100 ? 'Achieved' : g.onTrack ? 'On track' : 'Behind'}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 750, margin: '8px 0 4px' }}>{fmt(g.value, g.format)} <span className="small muted" style={{ fontWeight: 500 }}>of {fmt(g.target, g.format)}</span></div>
      <div className="goal-bar" style={{ height: 9 }}><span style={{ width: `${Math.min(100, g.percent)}%`, background: g.percent >= 100 ? 'var(--ok)' : g.onTrack ? 'var(--brand)' : '#e08a1e' }} /></div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <span className="small">{g.percent}%</span>
        {canManage && (
          <span className="row" style={{ gap: 4 }}>
            <button className="btn sm ghost" onClick={() => setEditing(g)}>Edit</button>
            <button className="btn sm ghost" onClick={() => { if (confirm(`Archive the goal “${g.name}”?`)) save(() => api(`/api/v1/goals/${g.id}`, { method: 'PATCH', body: { isArchived: true } }), 'Goal archived.'); }}>Archive</button>
          </span>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Goals & targets</h1>
          <div className="small muted">Targets per person, team or business line. Progress updates as work is logged — calls, wins, revenue and more.</div>
        </div>
        {canManage && <button className="btn" onClick={() => setEditing('new')}>+ New goal</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {!goals && <div className="muted">Loading…</div>}
      {goals && !goals.length && <div className="card empty">No goals yet.{canManage ? ' Set the first one with “New goal”.' : ' Your manager sets them.'}</div>}
      {mine.length > 0 && <><h2>My goals</h2><div className="goal-grid">{mine.map((g) => <Card key={g.id} g={g} />)}</div></>}
      {others.length > 0 && <><h2 style={{ marginTop: 18 }}>{canManage ? 'Team & business-line goals' : 'Team goals'}</h2><div className="goal-grid">{others.map((g) => <Card key={g.id} g={g} />)}</div></>}
      {editing && <GoalDialog goal={editing === 'new' ? null : editing} people={people} teams={teams} onClose={() => setEditing(null)}
        onSave={async (body) => { if (await save(() => (editing === 'new' ? api('/api/v1/goals', { method: 'POST', body }) : api(`/api/v1/goals/${editing.id}`, { method: 'PATCH', body })), 'Goal saved.')) setEditing(null); }} />}
    </>
  );
}

function GoalDialog({ goal, people, teams, onClose, onSave }: { goal: Goal | null; people: Opt[]; teams: Opt[]; onClose: () => void; onSave: (b: unknown) => void }) {
  const [f, setF] = useState({ metric: goal?.metric ?? 'won', period: goal?.period ?? 'month', target: goal ? String(goal.format === 'currency' ? goal.target / 100 : goal.target) : '', name: goal?.name ?? '', who: 'person', userId: people[0]?.id ?? '', teamId: teams[0]?.id ?? '' });
  const format = METRICS[f.metric]?.format ?? 'count';
  const target = Math.round(Number(f.target) * (format === 'currency' ? 100 : 1));
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onSave(goal ? { target, name: f.name || undefined } : { metric: f.metric, period: f.period, target, name: f.name || undefined, ...(f.who === 'person' ? { userId: f.userId } : f.who === 'team' ? { teamId: f.teamId } : {}) }); }}>
        <h2>{goal ? `Edit goal · ${goal.who}` : 'New goal'}</h2>
        {!goal && (
          <>
            <div className="grid cols-2">
              <div className="field"><label>Measure</label>
                <select className="input" value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}>
                  {GOAL_METRICS.map((m) => <option key={m} value={m}>{METRICS[m].label}</option>)}
                </select>
              </div>
              <div className="field"><label>Every</label>
                <select className="input" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value as Goal['period'] })}>
                  <option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option>
                </select>
              </div>
            </div>
            <div className="field"><label>For</label>
              <div className="row">
                {([['person', 'A person'], ['team', 'A team'], ['all', 'This business line / organization']] as const).map(([k, l]) => (
                  <button type="button" key={k} className={`chip ${f.who === k ? 'on' : ''}`} onClick={() => setF({ ...f, who: k })}>{l}</button>
                ))}
              </div>
            </div>
            {f.who === 'person' && <div className="field"><label>Person</label><select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
            {f.who === 'team' && <div className="field"><label>Team</label><select className="input" value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>}
          </>
        )}
        <div className="grid cols-2">
          <div className="field"><label>Target {format === 'currency' ? '(₹)' : format === 'minutes' ? '(minutes)' : ''}</label><input className="input" type="number" min={1} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} required /></div>
          <div className="field"><label>Name (optional)</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={METRICS[f.metric]?.label} /></div>
        </div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!target}>Save goal</button>
        </div>
      </form>
    </div>
  );
}
