'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { Menu } from '@/components/Menu';
import { PickWorkspace } from '@/components/PickWorkspace';

interface Opt { value: string; label: string }
interface Options { ops: Opt[]; routingFields: Opt[]; scoringFields: Opt[]; stages: Opt[]; statuses: Opt[]; sources: Opt[]; users: Opt[] }
interface Cond { field: string; op: string; value?: string }
interface RoutingRule { id: string; name: string; conditions: Cond[]; userIds: string[]; hits: number; isActive: boolean }
interface ScoreRule { id: string; name: string; conditions: Cond[]; points: number; isActive: boolean }
type Draft = { id: string | null; kind: 'routing' | 'scoring'; name: string; conditions: Cond[]; userIds: string[]; points: number };

const NO_VALUE = ['empty', 'not_empty'];

export default function LeadRulesPage() {
  const { me, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [tab, setTab] = useState<'routing' | 'scoring'>('routing');
  const [o, setO] = useState<Options | null>(null);
  const [routing, setRouting] = useState<RoutingRule[]>([]);
  const [scoring, setScoring] = useState<ScoreRule[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const [a, b, c] = await Promise.all([api<Options>('/api/v1/lead-rules/options'), api<RoutingRule[]>('/api/v1/routing-rules'), api<ScoreRule[]>('/api/v1/score-rules')]);
      setO(a); setRouting(b); setScoring(c);
    } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  }, [ws]);
  useEffect(() => { load(); }, [load, version]);
  if (!ws) return <><div className="page-head"><h1>Lead rules</h1></div><PickWorkspace text="Routing and scoring rules belong to a business line." /></>;

  const act = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; } };
  const base = (k: 'routing' | 'scoring') => (k === 'routing' ? '/api/v1/routing-rules' : '/api/v1/score-rules');
  const fieldName = (k: 'routing' | 'scoring', f: string) => (k === 'routing' ? o?.routingFields : o?.scoringFields)?.find((x) => x.value === f)?.label ?? f;
  const valueName = (c: Cond) => (c.field === 'stage' ? o?.stages : c.field === 'status' ? o?.statuses : c.field === 'source' ? o?.sources : [])?.find((x) => x.value === c.value)?.label ?? c.value;
  const describe = (k: 'routing' | 'scoring', cs: Cond[]) => cs.map((c) => `${fieldName(k, c.field)} ${o?.ops.find((x) => x.value === c.op)?.label ?? c.op}${NO_VALUE.includes(c.op) ? '' : ` ${valueName(c)}`}`).join(' and ');
  const firstCond = (k: 'routing' | 'scoring'): Cond => ({ field: k === 'routing' ? 'city' : 'source', op: 'eq', value: '' });
  const blank = (kind: 'routing' | 'scoring'): Draft => ({ id: null, kind, name: '', conditions: [firstCond(kind)], userIds: [], points: 10 });
  const flags = (k: 'routing' | 'scoring', id: string, body: object, text: string) => act(() => api(`${base(k)}/${id}`, { method: 'PATCH', body }), text);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const { id, kind, name, conditions, userIds, points } = draft;
    const body = kind === 'routing' ? { name, conditions, userIds } : { name, conditions, points };
    const ok = await act(() => (id ? api(`${base(kind)}/${id}`, { method: 'PATCH', body }) : api(base(kind), { method: 'POST', body })), kind === 'routing' ? 'Routing rule saved.' : 'Scoring rule saved. Use Recalculate to apply it to existing leads.');
    if (ok) setDraft(null);
  }
  const move = (i: number, by: number) => { const ids = routing.map((r) => r.id); [ids[i], ids[i + by]] = [ids[i + by], ids[i]]; act(() => api('/api/v1/routing-rules/order', { method: 'POST', body: { ids } }), 'Order saved.'); };
  async function recalc() {
    setBusy(true);
    await act(async () => { const r = await api<{ leads: number; changed: number }>('/api/v1/score-rules/recalculate', { method: 'POST' }); setTimeout(() => setMsg({ type: 'notice', text: `Checked ${r.leads} leads. ${r.changed} scores changed.` }), 0); }, 'Done.');
    setBusy(false);
  }

  const cond = (i: number, p: Partial<Cond>) => draft && setDraft({ ...draft, conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const valueInput = (c: Cond, i: number) => {
    const list = c.field === 'stage' ? o?.stages : c.field === 'status' ? o?.statuses : c.field === 'source' ? o?.sources : null;
    if (list && c.op !== 'in' && c.op !== 'contains') return <select className="input" required aria-label="Value" value={c.value ?? ''} onChange={(e) => cond(i, { value: e.target.value })}><option value="">Choose…</option>{list.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>;
    return <input className="input" required aria-label="Value" placeholder={c.op === 'in' ? 'Pune, Mumbai, Nashik' : ''} value={c.value ?? ''} onChange={(e) => cond(i, { value: e.target.value })} />;
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Lead rules</h1><div className="muted small">Send leads to the right people, and score them, by what you know about them.</div></div>
        <div className="row">
          {tab === 'scoring' && <button className="btn outline" disabled={busy} onClick={recalc}>{busy ? 'Working…' : 'Recalculate'}</button>}
          <button className="btn" disabled={!o} onClick={() => setDraft(blank(tab))}><Icon name="plus" className="ic" />New rule</button>
        </div>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="dash-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'routing'} className={`dash-tab${tab === 'routing' ? ' on' : ''}`} onClick={() => setTab('routing')}>Routing</button>
        <button role="tab" aria-selected={tab === 'scoring'} className={`dash-tab${tab === 'scoring' ? ' on' : ''}`} onClick={() => setTab('scoring')}>Scoring</button>
      </div>

      {tab === 'routing' && (
        <>
          <p className="small muted">The first matching rule decides, for leads from forms, integrations and uploads. If none match, your normal assignment applies. A returning customer&rsquo;s own RM comes first when Sticky RM is on.</p>
          {!routing.length && <div className="card empty">No routing rules yet. Example: City is one of Pune, Nashik goes to the West team.</div>}
          {routing.map((r, i) => (
            <div key={r.id} className={`card rule-card${r.isActive ? '' : ' off'}`}>
              <div className="rule-main">
                <div className="row"><b>{r.name}</b><span className={`badge ${r.isActive ? 'ok' : 'grey'}`}>{r.isActive ? 'On' : 'Paused'}</span></div>
                <div className="small"><b>If</b> {describe('routing', r.conditions)}</div>
                <div className="small"><b>Then</b> {r.userIds.map((u) => o?.users.find((x) => x.value === u)?.label ?? 'Former staff').join(', ')}</div>
                <div className="small muted">{r.hits} {r.hits === 1 ? 'lead' : 'leads'} routed</div>
              </div>
              <div className="row rule-tools">
                <button className="btn sm ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" className="ic" /></button>
                <button className="btn sm ghost" aria-label="Move down" disabled={i === routing.length - 1} onClick={() => move(i, 1)}><Icon name="down" className="ic" /></button>
                <Menu sm items={[
                  { label: 'Edit', icon: 'edit', onClick: () => setDraft({ id: r.id, kind: 'routing', name: r.name, conditions: r.conditions, userIds: r.userIds, points: 10 }) },
                  { label: r.isActive ? 'Pause' : 'Switch on', icon: 'radio', onClick: () => flags('routing', r.id, { isActive: !r.isActive }, r.isActive ? 'Rule paused.' : 'Rule switched on.') },
                  { label: 'Archive', icon: 'trash', onClick: () => flags('routing', r.id, { isArchived: true }, 'Rule archived.') },
                ]} />
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'scoring' && (
        <>
          <p className="small muted">Every matching rule adds its points. Points go away if the rule stops matching. Scores from custom actions are kept. New leads and changes are scored automatically.</p>
          {!scoring.length && <div className="card empty">No scoring rules yet. Example: Source is Facebook adds 10 points.</div>}
          {scoring.map((r) => (
            <div key={r.id} className={`card rule-card${r.isActive ? '' : ' off'}`}>
              <div className="rule-main">
                <div className="row"><b>{r.name}</b><span className={`badge ${r.points > 0 ? 'ok' : 'bad'}`}>{r.points > 0 ? `+${r.points}` : r.points}</span>{!r.isActive && <span className="badge grey">Paused</span>}</div>
                <div className="small"><b>If</b> {describe('scoring', r.conditions)}</div>
              </div>
              <div className="row rule-tools">
                <Menu sm items={[
                  { label: 'Edit', icon: 'edit', onClick: () => setDraft({ id: r.id, kind: 'scoring', name: r.name, conditions: r.conditions, userIds: [], points: r.points }) },
                  { label: r.isActive ? 'Pause' : 'Switch on', icon: 'radio', onClick: () => flags('scoring', r.id, { isActive: !r.isActive }, r.isActive ? 'Rule paused.' : 'Rule switched on.') },
                  { label: 'Archive', icon: 'trash', onClick: () => flags('scoring', r.id, { isArchived: true }, 'Rule archived.') },
                ]} />
              </div>
            </div>
          ))}
        </>
      )}

      {draft && o && (
        <div className="modal-bg">
          <form className="modal book-modal" onSubmit={save}>
            <div className="org-head"><h2>{draft.id ? 'Edit rule' : 'New rule'}</h2><button type="button" className="btn sm ghost" aria-label="Close" onClick={() => setDraft(null)}><Icon name="close" className="ic" /></button></div>
            <div className="field"><label htmlFor="rn">Name</label><input id="rn" className="input" required minLength={2} maxLength={80} placeholder={draft.kind === 'routing' ? 'e.g. West zone' : 'e.g. Facebook leads'} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            <div className="book-hours-title">If all of these match</div>
            {draft.conditions.map((c, i) => (
              <div key={i} className="rule-cond">
                <select className="input" aria-label="Field" value={c.field} onChange={(e) => cond(i, { field: e.target.value, value: '' })}>{(draft.kind === 'routing' ? o.routingFields : o.scoringFields).map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select>
                <select className="input" aria-label="Comparison" value={c.op} onChange={(e) => cond(i, { op: e.target.value, value: '' })}>{o.ops.filter((x) => draft.kind === 'scoring' || !['gt', 'lt'].includes(x.value)).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
                {NO_VALUE.includes(c.op) ? <span /> : valueInput(c, i)}
                <button type="button" className="btn sm ghost" aria-label="Remove condition" disabled={draft.conditions.length === 1} onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })}><Icon name="close" className="ic" /></button>
              </div>
            ))}
            <button type="button" className="btn sm ghost" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, firstCond(draft.kind)] })}><Icon name="plus" className="ic" />Condition</button>
            {draft.kind === 'routing' ? (
              <>
                <div className="book-hours-title" style={{ marginTop: 14 }}>Then share leads between</div>
                <div className="chips">{o.users.map((u) => <button key={u.value} type="button" className={`chip${draft.userIds.includes(u.value) ? ' on' : ''}`} aria-pressed={draft.userIds.includes(u.value)} onClick={() => setDraft({ ...draft, userIds: draft.userIds.includes(u.value) ? draft.userIds.filter((x) => x !== u.value) : [...draft.userIds, u.value] })}>{u.label}</button>)}</div>
              </>
            ) : (
              <div className="field" style={{ marginTop: 14, maxWidth: 200 }}><label htmlFor="rp">Points (minus to subtract)</label><input id="rp" className="input" type="number" required min={-100} max={100} value={draft.points} onChange={(e) => setDraft({ ...draft, points: Number(e.target.value) })} /></div>
            )}
            <div className="row end" style={{ marginTop: 16 }}><button type="button" className="btn ghost" onClick={() => setDraft(null)}>Go back</button><button className="btn" disabled={draft.kind === 'routing' && !draft.userIds.length}>Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
