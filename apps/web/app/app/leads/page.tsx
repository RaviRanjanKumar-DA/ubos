'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { FieldInput } from '@/components/FieldInput';
import { LostDialog } from '@/components/LostDialog';
import { relTime, showValue, STATUS_TONE, WorkspaceSettings } from '@/lib/workspace';

interface Lead {
  id: string; name: string; mobile: string | null; customerId: string; customerCode: string; source: string;
  workspace: string; pipeline: string; stageId: string; stage: string; lostReason: string | null; status: string | null;
  customFields: Record<string, unknown>; ownerId: string | null; owner: string | null;
  nextFollowUpAt: string | null; lastActivityAt: string | null; lastDisposition: string | null; createdAt: string;
}
interface Person { id: string; name: string }
type Filters = { status: string; owner: string; followUp: string; stageId: string; q: string };
type BulkAction = 'assign' | 'stage' | 'status' | 'remark' | 'follow_up';

const EMPTY: Filters = { status: '', owner: '', followUp: '', stageId: '', q: '' };

export default function LeadsPage() {
  const { me, can, version } = useShell();
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [ws, setWs] = useState<WorkspaceSettings | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [counts, setCounts] = useState<{ today: number; overdue: number }>({ today: 0, overdue: 0 });
  const [f, setF] = useState<Filters>(EMPTY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [adding, setAdding] = useState(false);
  const [losing, setLosing] = useState<{ lead: Lead; stageId: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
    api<Lead[]>(`/api/v1/leads${qs ? `?${qs}` : ''}`).then((l) => { setLeads(l); setSelected(new Set()); }).catch((e) => setMsg({ type: 'error', text: e.message }));
    Promise.all([api<unknown[]>('/api/v1/follow-ups?when=today'), api<unknown[]>('/api/v1/follow-ups?when=overdue')])
      .then(([t, o]) => setCounts({ today: t.length, overdue: o.length })).catch(() => {});
  }, [f]);

  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    setF(EMPTY);
    if (me.currentWorkspaceId && can('org.workspace.view')) {
      api<WorkspaceSettings>(`/api/v1/workspaces/${me.currentWorkspaceId}/settings`).then(setWs).catch(() => setWs(null));
      api<Person[]>(`/api/v1/workspaces/${me.currentWorkspaceId}/assignees`).then(setPeople).catch(() => setPeople([]));
    } else { setWs(null); setPeople([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const stagesFor = (l: Lead) => ws?.pipelines.find((p) => p.name === l.pipeline)?.stages ?? [];
  const label = (kind: 'sources' | 'statuses' | 'dispositions', v: string | null) => (v ? ws?.[kind].find((o) => o.value === v)?.label ?? v : '');
  const firstField = ws?.fields.find((x) => !x.isArchived);
  const allStages = useMemo(() => ws?.pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name }))) ?? [], [ws]);
  const set = (k: keyof Filters, v: string) => setF({ ...f, [k]: f[k] === v ? '' : v });
  const toggle = (id: string) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); };
  const allChecked = !!leads?.length && leads.every((l) => selected.has(l.id));

  async function moveStage(l: Lead, stageId: string, lostReason?: string) {
    const target = stagesFor(l).find((s) => s.id === stageId);
    if (target?.isLost && !lostReason && ws?.lostReasons.length) return setLosing({ lead: l, stageId });
    try {
      await api(`/api/v1/leads/${l.id}/stage`, { method: 'PATCH', body: { stageId, lostReason } });
      setLosing(null);
      load();
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed' }); }
  }

  async function exportCsv() {
    try {
      const blob = await api<Blob>('/api/v1/leads/export');
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: 'leads.csv' }).click();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Export failed' }); }
  }

  const canBulk = can('crm.lead.update') || can('crm.lead.assign');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="muted small">{ws?.name ?? 'All business lines'} · {leads?.length ?? 0} shown · your access: {me.permissions['crm.lead.view']?.toLowerCase()}</div>
        </div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); load(); }}>
            <input className="input" style={{ width: 210 }} placeholder="Search name or mobile" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          </form>
          {can('crm.lead.export') && <button className="btn outline" onClick={exportCsv}>Export</button>}
          {can('crm.lead.import') && me.currentWorkspaceId && <Link className="btn outline" href="/app/leads/import">Bulk upload</Link>}
          {can('crm.lead.create') && ws && <button className="btn" onClick={() => setAdding(true)}>+ Add lead</button>}
        </div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="chips" style={{ marginBottom: ws ? 10 : 0 }}>
          <button className={`chip ${f.followUp === 'today' ? 'on' : ''}`} onClick={() => set('followUp', 'today')}>Follow-ups today <span className="count">{counts.today}</span></button>
          <button className={`chip ${f.followUp === 'overdue' ? 'on' : counts.overdue ? 'alert' : ''}`} onClick={() => set('followUp', 'overdue')}>Overdue <span className="count">{counts.overdue}</span></button>
          <button className={`chip ${f.followUp === 'none' ? 'on' : ''}`} onClick={() => set('followUp', 'none')}>No follow-up planned</button>
          <span style={{ width: 1, background: 'var(--line)', margin: '0 4px' }} />
          <button className={`chip ${f.owner === 'me' ? 'on' : ''}`} onClick={() => set('owner', 'me')}>My leads</button>
          {can('crm.lead.assign') && <button className={`chip ${f.owner === 'unassigned' ? 'on' : ''}`} onClick={() => set('owner', 'unassigned')}>Unassigned</button>}
          {Object.values(f).some(Boolean) && <button className="chip" onClick={() => setF(EMPTY)}>✕ Clear filters</button>}
        </div>
        {ws && (
          <div className="row" style={{ gap: 8 }}>
            <select className="input" style={{ width: 'auto' }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status filter">
              <option value="">All statuses</option>
              {ws.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select className="input" style={{ width: 'auto' }} value={f.stageId} onChange={(e) => setF({ ...f, stageId: e.target.value })} aria-label="Stage filter">
              <option value="">All stages</option>
              {allStages.map((s) => <option key={s.id} value={s.id}>{ws.pipelines.length > 1 ? `${s.pipeline} · ` : ''}{s.name}</option>)}
            </select>
            {people.length > 0 && can('crm.lead.assign') && (
              <select className="input" style={{ width: 'auto' }} value={['me', 'unassigned'].includes(f.owner) ? '' : f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} aria-label="Owner filter">
                <option value="">Any owner</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
        )}
      </div>
      {!me.currentWorkspaceId && can('crm.lead.create') && <div className="notice">Select a workspace (business line) at the top to add, upload or bulk-edit leads.</div>}
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                {canBulk && <th style={{ width: 34 }}><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(leads?.map((l) => l.id)))} /></th>}
                <th>Customer</th>{!me.currentWorkspaceId && <th>Business line</th>}
                {firstField && <th>{firstField.label}</th>}
                <th>Status</th><th>Stage</th><th>Owner</th><th>Next follow-up</th><th>Last call</th>
              </tr>
            </thead>
            <tbody>
              {leads?.map((l) => {
                const overdue = l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date();
                return (
                  <tr key={l.id} className={`clickable ${selected.has(l.id) ? 'selected' : ''}`} onClick={() => router.push(`/app/leads/${l.id}`)}>
                    {canBulk && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} /></td>}
                    <td>
                      <b>{l.name}</b>
                      <div className="small muted">{l.mobile} · {label('sources', l.source)}</div>
                    </td>
                    {!me.currentWorkspaceId && <td><span className="badge">{l.workspace}</span></td>}
                    {firstField && <td className="small">{showValue(firstField, l.customFields?.[firstField.key]) || <span className="muted">—</span>}</td>}
                    <td>{l.status ? <span className={`badge ${STATUS_TONE[l.status] ?? ''}`}>{label('statuses', l.status)}</span> : <span className="muted small">—</span>}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {can('crm.lead.update') && stagesFor(l).length ? (
                        <select className="input" style={{ height: 30, width: 150 }} value={l.stageId} onChange={(e) => moveStage(l, e.target.value)} aria-label="Stage">
                          {stagesFor(l).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      ) : <span className="badge grey">{l.stage}</span>}
                      {l.lostReason && <div className="small muted">{l.lostReason}</div>}
                    </td>
                    <td className="small">{l.owner ?? <span className="badge warn">Unassigned</span>}</td>
                    <td className="small">
                      {l.nextFollowUpAt ? <span style={{ color: overdue ? 'var(--bad)' : undefined, fontWeight: overdue ? 600 : undefined }}>{relTime(l.nextFollowUpAt)}</span> : <span className="muted">—</span>}
                    </td>
                    <td className="small muted">{l.lastDisposition ? `${label('dispositions', l.lastDisposition)} · ${relTime(l.lastActivityAt)}` : 'Not called yet'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {leads && !leads.length && <div className="empty">No leads match these filters.</div>}
          {!leads && <div className="empty">Loading…</div>}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bulkbar">
          <b>{selected.size} selected</b>
          <span style={{ flex: 1 }} />
          {can('crm.lead.assign') && <button className="btn sm" onClick={() => setBulk('assign')}>Assign</button>}
          {can('crm.lead.update') && ws && <button className="btn sm" onClick={() => setBulk('stage')}>Change stage</button>}
          {can('crm.lead.update') && ws && <button className="btn sm" onClick={() => setBulk('status')}>Change status</button>}
          {can('crm.lead.update') && <button className="btn sm" onClick={() => setBulk('remark')}>Add remark</button>}
          {can('crm.lead.update') && <button className="btn sm" onClick={() => setBulk('follow_up')}>Schedule follow-up</button>}
          <button className="btn sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {bulk && (
        <BulkDialog
          action={bulk} ids={[...selected]} ws={ws} people={people}
          onClose={() => setBulk(null)}
          onDone={(text) => { setBulk(null); setMsg({ type: 'notice', text }); load(); }}
        />
      )}
      {adding && ws && <AddLead ws={ws} onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); router.push(`/app/leads/${id}`); }} />}
      {losing && ws && (
        <LostDialog ws={ws} name={losing.lead.name} onClose={() => setLosing(null)} onPick={(r) => moveStage(losing.lead, losing.stageId, r)} />
      )}
    </>
  );
}

function BulkDialog({ action, ids, ws, people, onClose, onDone }: {
  action: BulkAction; ids: string[]; ws: WorkspaceSettings | null; people: Person[]; onClose: () => void; onDone: (text: string) => void;
}) {
  const [owners, setOwners] = useState<string[]>([]);
  const [stageId, setStageId] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [status, setStatus] = useState('');
  const [remark, setRemark] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stage = ws?.pipelines.flatMap((p) => p.stages).find((s) => s.id === stageId);
  const titles: Record<BulkAction, string> = {
    assign: 'Assign leads', stage: 'Change stage', status: 'Change status', remark: 'Add remark', follow_up: 'Schedule follow-up',
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ updated: number; skipped: { reason: string }[] }>('/api/v1/leads/bulk', {
        method: 'POST',
        body: {
          leadIds: ids, action,
          ...(action === 'assign' ? { ownerIds: owners } : {}),
          ...(action === 'stage' ? { stageId, lostReason: lostReason || undefined } : {}),
          ...(action === 'status' ? { status: status || undefined } : {}),
          ...(action === 'remark' || action === 'follow_up' ? { remark: remark || undefined } : {}),
          ...(action === 'follow_up' ? { followUpAt: new Date(date).toISOString() } : {}),
        },
      });
      const reasons = [...new Set(r.skipped.map((s) => s.reason))];
      onDone(`${r.updated} lead(s) updated${r.skipped.length ? ` · ${r.skipped.length} skipped (${reasons.join('; ')})` : ''}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{titles[action]} · {ids.length} lead(s)</h2>
        {error && <div className="error">{error}</div>}
        {action === 'assign' && (
          <>
            <p className="small muted" style={{ marginTop: -4 }}>Pick one person, or several to share the leads equally (round-robin).</p>
            <div className="chips" style={{ marginBottom: 12 }}>
              {people.map((p) => (
                <button type="button" key={p.id} className={`chip ${owners.includes(p.id) ? 'on' : ''}`} onClick={() => setOwners(owners.includes(p.id) ? owners.filter((x) => x !== p.id) : [...owners, p.id])}>{p.name}</button>
              ))}
            </div>
            {!people.length && <div className="notice">Select a workspace to see who can receive these leads.</div>}
          </>
        )}
        {action === 'stage' && ws && (
          <>
            <div className="field">
              <label>New stage</label>
              <select className="input" value={stageId} onChange={(e) => setStageId(e.target.value)} required>
                <option value="">Choose…</option>
                {ws.pipelines.map((p) => <optgroup key={p.id} label={p.name}>{p.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
              </select>
              <span className="small muted">Leads in a different pipeline are skipped.</span>
            </div>
            {stage?.isLost && ws.lostReasons.length > 0 && (
              <div className="field">
                <label>Lost reason</label>
                <select className="input" value={lostReason} onChange={(e) => setLostReason(e.target.value)} required>
                  <option value="">Choose…</option>
                  {ws.lostReasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            )}
          </>
        )}
        {action === 'status' && ws && (
          <div className="chips" style={{ marginBottom: 12 }}>
            {ws.statuses.map((s) => <button type="button" key={s.value} className={`chip ${status === s.value ? 'on' : ''}`} onClick={() => setStatus(s.value ?? '')}>{s.label}</button>)}
          </div>
        )}
        {action === 'follow_up' && (
          <div className="field"><label>Follow-up on</label><input className="input" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
        )}
        {(action === 'remark' || action === 'follow_up') && (
          <div className="field">
            <label>{action === 'remark' ? 'Remark' : 'Note (optional)'}</label>
            <textarea className="input" style={{ height: 80, paddingTop: 8 }} value={remark} onChange={(e) => setRemark(e.target.value)} required={action === 'remark'} />
          </div>
        )}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || (action === 'assign' && !owners.length) || (action === 'status' && !status)}>{busy ? 'Applying…' : 'Apply'}</button>
        </div>
      </form>
    </div>
  );
}

function AddLead({ ws, onClose, onSaved }: { ws: WorkspaceSettings; onClose: () => void; onSaved: (id: string) => void }) {
  const [form, setForm] = useState({
    name: '', mobile: '', email: '',
    source: ws.sources.find((s) => s.value === 'manual')?.value ?? ws.sources[0]?.value ?? 'manual',
    pipelineId: ws.pipelines[0]?.id ?? '',
  });
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const fields = ws.fields.filter((x) => !x.isArchived);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ id: string }>('/api/v1/leads', { method: 'POST', body: { ...form, customFields: custom } });
      onSaved(r.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 560, maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Add lead · {ws.name}</h2>
        {error && <div className="error">{error}</div>}
        <div className="grid cols-2">
          <div className="field"><label>Name</label><input className="input" value={form.name} onChange={set('name')} required autoFocus /></div>
          <div className="field"><label>Mobile</label><input className="input" value={form.mobile} onChange={set('mobile')} placeholder="98765 43210" required /></div>
          <div className="field"><label>Email (optional)</label><input className="input" type="email" value={form.email} onChange={set('email')} /></div>
          <div className="field">
            <label>Source</label>
            <select className="input" value={form.source} onChange={set('source')}>
              {ws.sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          {ws.pipelines.length > 1 && (
            <div className="field">
              <label>Pipeline</label>
              <select className="input" value={form.pipelineId} onChange={set('pipelineId')}>
                {ws.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
        </div>
        {fields.length > 0 && (
          <>
            <div className="small" style={{ fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '6px 0 8px' }}>{ws.name} details</div>
            <div className="grid cols-2">
              {fields.map((x) => (
                <div key={x.key} className="field" style={x.type === 'multiselect' || x.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                  <label htmlFor={`f_${x.key}`}>{x.label}{x.required && ' *'}</label>
                  <FieldInput field={x} value={custom[x.key]} onChange={(v) => setCustom({ ...custom, [x.key]: v })} />
                </div>
              ))}
            </div>
          </>
        )}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save lead'}</button>
        </div>
      </form>
    </div>
  );
}
