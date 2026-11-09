'use client';

import { PickWorkspace } from '@/components/PickWorkspace';
import { askConfirm } from '@/components/Dialogs';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

type Opt = { value: string; label: string };
interface Options { canManage: boolean; users: Opt[]; stages: Opt[]; statuses: Opt[]; sources: Opt[]; dispositions: Opt[] }
interface Campaign {
  id: string; name: string; status: string; maxAttempts: number; retryAfterMin: number; agents: string[]; pending: number; active: number; done: number; closed: number;
  isAgent: boolean; hasMyOpenCall: boolean; canManage: boolean;
}
const TONE: Record<string, string> = { active: 'ok', paused: 'warn', completed: 'grey' };
const LABEL: Record<string, string> = { active: 'Running', paused: 'Paused', completed: 'Complete' };

/** Calling campaigns: callers open their list; managers build lists and read the results. */
export default function CampaignsPage() {
  const { me, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [rows, setRows] = useState<Campaign[] | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  const load = useCallback(() => api<Campaign[]>('/api/v1/call-campaigns').then(setRows).catch(() => setRows([])), []);
  useEffect(() => {
    if (!ws) return;
    setRows(null);
    load();
    api<Options>('/api/v1/call-campaigns/options').then(setOpts).catch(() => setOpts(null));
  }, [ws, version, load]);

  if (!ws) return <><div className="page-head"><h1>Call campaigns</h1></div><PickWorkspace text="Campaigns belong to a business line." /></>;

  const act = async (id: string, body: object, done: string) => {
    try { await api(`/api/v1/call-campaigns/${id}`, { method: 'PATCH', body }); setMsg({ type: 'notice', text: done }); load(); }
    catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Call campaigns</h1>
          <p className="muted small page-note">Work through a list one lead at a time. Every call needs an outcome before the next lead opens.</p>
        </div>
        {opts?.canManage && <button className="btn" onClick={() => setCreating(true)}>+ New campaign</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {!rows ? <div className="card muted">Loading…</div> : !rows.length ? (
        <div className="card empty">{opts?.canManage ? 'No campaigns yet. Create one to give your callers a list.' : 'You are not on any campaign yet.'}</div>
      ) : (
        <div className="camp-grid">
          {rows.map((c) => {
            const total = c.pending + c.active + c.done + c.closed;
            const finished = c.done + c.closed;
            return (
              <div className="card camp-card" key={c.id}>
                <div className="camp-top"><h2>{c.name}</h2><span className={`badge ${TONE[c.status] ?? ''}`}>{LABEL[c.status] ?? c.status}</span></div>
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={finished} aria-label="Leads finished"><span style={{ width: `${total ? Math.round((finished / total) * 100) : 0}%` }} /></div>
                <p className="small muted camp-meta">{finished} of {total} leads finished · {c.pending} waiting{c.active ? ` · ${c.active} on a call` : ''}</p>
                <p className="small muted camp-meta">Up to {c.maxAttempts} tries, {c.retryAfterMin} minutes apart · {c.agents.join(', ')}</p>
                <div className="row camp-actions">
                  {c.isAgent && c.status !== 'completed' && <Link className="btn sm" href={`/app/campaigns/${c.id}`}>{c.hasMyOpenCall ? 'Resume call' : 'Start calling'}</Link>}
                  {c.canManage && <Link className="btn sm outline" href={`/app/campaigns/${c.id}/report`}>Report</Link>}
                  {c.canManage && c.status === 'active' && <button className="btn sm ghost" onClick={() => act(c.id, { status: 'paused' }, `${c.name} paused.`)}>Pause</button>}
                  {c.canManage && c.status === 'paused' && <button className="btn sm ghost" onClick={() => act(c.id, { status: 'active' }, `${c.name} resumed.`)}>Resume</button>}
                  {c.canManage && <button className="btn sm ghost" onClick={async () => { if (await askConfirm(`Archive ${c.name}? Its calls stay in the call log.`)) act(c.id, { archived: true }, `${c.name} archived.`); }}>Archive</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {creating && opts && <NewCampaign opts={opts} onClose={() => setCreating(false)} onDone={(t) => { setCreating(false); setMsg({ type: 'notice', text: t }); load(); }} />}
    </>
  );
}

function Pick({ label, options, value, onChange, hint }: { label: string; options: Opt[]; value: string[]; onChange: (v: string[]) => void; hint?: string }) {
  if (!options.length) return null;
  return (
    <div className="field">
      <label>{label}</label>
      <div className="chips">
        {options.map((o) => (
          <button type="button" key={o.value} className={`chip ${value.includes(o.value) ? 'on' : ''}`} aria-pressed={value.includes(o.value)} onClick={() => onChange(value.includes(o.value) ? value.filter((x) => x !== o.value) : [...value, o.value])}>{o.label}</button>
        ))}
      </div>
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}

function NewCampaign({ opts, onClose, onDone }: { opts: Options; onClose: () => void; onDone: (t: string) => void }) {
  const [name, setName] = useState('');
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [filter, setFilter] = useState({ stageIds: [] as string[], statuses: [] as string[], sources: [] as string[], owners: [] as string[], dispositions: [] as string[], contacted: 'any' });
  const [maxAttempts, setMax] = useState(3);
  const [retryAfterMin, setRetry] = useState(60);
  const [count, setCount] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCount(null);
    const t = setTimeout(() => api<{ leads: number }>('/api/v1/call-campaigns/preview', { method: 'POST', body: filter }).then((r) => setCount(r.leads)).catch(() => setCount(null)), 300);
    return () => clearTimeout(t);
  }, [filter]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api<{ leads: number }>('/api/v1/call-campaigns', { method: 'POST', body: { name, agentIds, filter, maxAttempts, retryAfterMin } });
      onDone(`${name} created with ${r.leads} leads.`);
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); setBusy(false); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>New call campaign</h2>
        {err && <div className="error">{err}</div>}
        <div className="field"><label htmlFor="camp-name">Name</label><input id="camp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} placeholder="e.g. Website leads this week" /></div>
        <Pick label="Callers" options={opts.users} value={agentIds} onChange={setAgentIds} hint="Callers receive only leads they can already open, so include the owners or their managers." />
        <h3 className="form-sub">Which leads</h3>
        <Pick label="Stage" options={opts.stages} value={filter.stageIds} onChange={(stageIds) => setFilter({ ...filter, stageIds })} />
        <Pick label="Status" options={opts.statuses} value={filter.statuses} onChange={(statuses) => setFilter({ ...filter, statuses })} />
        <Pick label="Source" options={opts.sources} value={filter.sources} onChange={(sources) => setFilter({ ...filter, sources })} />
        <Pick label="Lead owner" options={[{ value: 'unassigned', label: 'Unassigned' }, ...opts.users]} value={filter.owners} onChange={(owners) => setFilter({ ...filter, owners })} />
        <Pick label="Last call outcome" options={opts.dispositions} value={filter.dispositions} onChange={(dispositions) => setFilter({ ...filter, dispositions })} />
        <div className="field"><label htmlFor="camp-contacted">Called before</label><select id="camp-contacted" className="input" value={filter.contacted} onChange={(e) => setFilter({ ...filter, contacted: e.target.value })}><option value="any">Any</option><option value="no">Never contacted</option><option value="yes">Contacted before</option></select></div>
        <div className="form-two">
          <div className="field"><label htmlFor="camp-max">Tries per lead</label><input id="camp-max" className="input" type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMax(Number(e.target.value))} required /></div>
          <div className="field"><label htmlFor="camp-gap">Minutes between tries</label><input id="camp-gap" className="input" type="number" min={5} max={10080} value={retryAfterMin} onChange={(e) => setRetry(Number(e.target.value))} required /></div>
        </div>
        <p className="small"><b>{count === null ? 'Counting…' : `${count} lead(s)`}</b> <span className="muted">with a mobile number. Won and lost leads are left out.</span></p>
        <div className="row modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || !agentIds.length || !count}>{busy ? 'Creating…' : 'Create campaign'}</button>
        </div>
      </form>
    </div>
  );
}
