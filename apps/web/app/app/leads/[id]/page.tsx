'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';
import { FieldInput } from '@/components/FieldInput';
import { LostDialog } from '@/components/LostDialog';
import { relTime, showValue, STATUS_TONE, WorkspaceSettings } from '@/lib/workspace';

interface Activity { id: string; type: string; disposition: string | null; connected: boolean | null; durationSec: number | null; remark: string | null; data: Record<string, unknown> | null; user: string | null; at: string }
interface FollowUp { id: string; dueAt: string; note: string | null; doneAt: string | null; outcome: string | null; user: string | null }
interface LeadDetail {
  id: string; customerId: string; customerCode: string; name: string; mobile: string | null; alternateMobiles: string[]; email: string | null; city: string | null;
  workspace: { id: string; name: string }; pipeline: { id: string; name: string; stages: { id: string; name: string; isWon: boolean; isLost: boolean }[] };
  stageId: string; status: string | null; lostReason: string | null; source: string; customFields: Record<string, unknown>;
  owner: { id: string; name: string } | null; createdAt: string; assignedAt: string | null; firstResponseAt: string | null;
  lastActivityAt: string | null; lastDisposition: string | null; nextFollowUpAt: string | null; canUpdate: boolean; canAssign: boolean;
  activities: Activity[]; followUps: FollowUp[];
}
type Tab = 'call' | 'remark' | 'follow_up';

const ICON: Record<string, string> = { call: '📞', remark: '📝', status: '🏷️', assignment: '👤', stage: '➜', follow_up: '⏰', import: '⬆' };
const at = (h: number, addDays: number) => { const d = new Date(); d.setDate(d.getDate() + addDays); d.setHours(h, 0, 0, 0); return d; };
const QUICK = [
  { label: 'In 2 hours', date: () => new Date(Date.now() + 2 * 3_600_000) },
  { label: 'Tomorrow 11 am', date: () => at(11, 1) },
  { label: 'In 3 days', date: () => at(11, 3) },
  { label: 'Next week', date: () => at(11, 7) },
];
const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const wsParam = useSearchParams().get('ws');
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [ws, setWs] = useState<WorkspaceSettings | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [losing, setLosing] = useState<string | null>(null);
  const workspace = wsParam ?? session.get()?.workspaceId ?? null;

  const load = useCallback(async () => {
    try {
      const l = await api<LeadDetail>(`/api/v1/leads/${id}`, { workspace });
      setLead(l);
      setWs((cur) => cur ?? null);
      api<WorkspaceSettings>(`/api/v1/workspaces/${l.workspace.id}/settings`, { workspace: l.workspace.id }).then(setWs).catch(() => {});
      if (l.canAssign) api<{ id: string; name: string }[]>(`/api/v1/workspaces/${l.workspace.id}/assignees`, { workspace: l.workspace.id }).then(setPeople).catch(() => {});
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed' });
    }
  }, [id, workspace]);
  useEffect(() => { load(); }, [load]);

  const call = (path: string, method: string, body?: unknown) => api(path, { method, body, workspace: lead?.workspace.id ?? workspace });
  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
      return false;
    }
  };

  if (!lead) return msg ? <div className="error">{msg.text} <Link href="/app/leads">Back to leads</Link></div> : <div className="muted">Loading…</div>;

  const stageIdx = lead.pipeline.stages.findIndex((s) => s.id === lead.stageId);
  const current = lead.pipeline.stages[stageIdx];
  const label = (kind: 'sources' | 'statuses' | 'dispositions', v: string | null) => (v ? ws?.[kind].find((o) => o.value === v)?.label ?? v : '');
  const stageName = (sid: unknown) => lead.pipeline.stages.find((s) => s.id === sid)?.name ?? 'another stage';
  const openFollowUps = lead.followUps.filter((f) => !f.doneAt);
  const moveTo = (stageId: string, reason?: string) => {
    const st = lead.pipeline.stages.find((s) => s.id === stageId)!;
    if (st.isLost && !reason && ws?.lostReasons.length) return setLosing(stageId);
    act(() => call(`/api/v1/leads/${id}/stage`, 'PATCH', { stageId, lostReason: reason }), `Moved to ${st.name}.`).then(() => setLosing(null));
  };

  function describe(a: Activity) {
    const d = a.data ?? {};
    switch (a.type) {
      case 'call': return `Call — ${label('dispositions', a.disposition)}${a.durationSec ? ` · ${Math.round(a.durationSec / 60)} min` : ''}`;
      case 'remark': return 'Remark';
      case 'status': return `Status → ${label('statuses', d.to as string) || 'none'}`;
      case 'assignment': return `Assigned to ${people.find((p) => p.id === d.to)?.name ?? 'a new owner'}`;
      case 'stage': return `Stage → ${stageName(d.to)}${d.lostReason ? ` (${d.lostReason})` : ''}`;
      case 'follow_up': return `Follow-up planned for ${new Date(String(d.dueAt)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`;
      case 'import': return `Imported from ${String(d.file ?? 'file')}`;
      default: return a.type;
    }
  }

  return (
    <>
      <div className="page-head" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="small muted"><Link href="/app/leads">Leads</Link> / {lead.workspace.name} · {lead.pipeline.name}</div>
          <h1>{lead.name} {lead.status && <span className={`badge ${STATUS_TONE[lead.status] ?? ''}`} style={{ verticalAlign: 'middle' }}>{label('statuses', lead.status)}</span>}</h1>
          <div className="small muted">
            {lead.mobile && <a href={`tel:${lead.mobile}`}>{lead.mobile}</a>}{lead.email ? ` · ${lead.email}` : ''}{lead.city ? ` · ${lead.city}` : ''}
            {' · '}<Link href={`/app/customers/${lead.customerId}`}>Customer {lead.customerCode} (360°)</Link>
          </div>
        </div>
        <div className="row">
          {lead.canAssign && people.length > 0 ? (
            <label className="row small" style={{ gap: 6 }}>Owner
              <select className="input" style={{ width: 180 }} value={lead.owner?.id ?? ''} onChange={(e) => act(() => call(`/api/v1/leads/${id}`, 'PATCH', { ownerId: e.target.value }), 'Owner changed.')}>
                {!lead.owner && <option value="">Unassigned</option>}
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          ) : <span className="small">Owner: <b>{lead.owner?.name ?? 'Unassigned'}</b></span>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Journey</h2>
          <span className="small muted">Click a stage to move the lead</span>
        </div>
        <div className="journey" role="list">
          {lead.pipeline.stages.map((s, i) => (
            <button key={s.id} role="listitem" disabled={!lead.canUpdate || s.id === lead.stageId}
              className={`${i < stageIdx ? 'passed' : ''} ${s.id === lead.stageId ? 'current' : ''} ${s.isWon ? 'won' : ''} ${s.isLost ? 'lost' : ''}`}
              onClick={() => moveTo(s.id)} title={s.name}>{s.name}</button>
          ))}
        </div>
        {current?.isLost && lead.lostReason && <div className="small" style={{ color: 'var(--bad)' }}>Lost: {lead.lostReason}</div>}
        <div className="grid cols-4 small" style={{ marginTop: 10 }}>
          <div><span className="muted">Enquiry</span><br />{new Date(lead.createdAt).toLocaleDateString('en-IN')} · {label('sources', lead.source)}</div>
          <div><span className="muted">First response</span><br />{lead.firstResponseAt ? relTime(lead.firstResponseAt) : <span style={{ color: 'var(--warn)' }}>Not called yet</span>}</div>
          <div><span className="muted">Last call</span><br />{lead.lastDisposition ? `${label('dispositions', lead.lastDisposition)} · ${relTime(lead.lastActivityAt)}` : '—'}</div>
          <div><span className="muted">Next follow-up</span><br />{lead.nextFollowUpAt ? <span style={{ color: new Date(lead.nextFollowUpAt) < new Date() ? 'var(--bad)' : undefined }}>{relTime(lead.nextFollowUpAt)}</span> : '—'}</div>
        </div>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, alignItems: 'start' }} className="lead-grid">
        <div style={{ display: 'grid', gap: 14 }}>
          {lead.canUpdate && ws && <ActionPanel ws={ws} lead={lead} act={act} call={call} />}
          {lead.canUpdate && ws && ws.statuses.length > 0 && (
            <div className="card">
              <h2>Lead status</h2>
              <div className="chips">
                {ws.statuses.map((s) => (
                  <button key={s.value} className={`chip ${lead.status === s.value ? 'on' : ''}`}
                    onClick={() => act(() => call(`/api/v1/leads/${id}`, 'PATCH', { status: lead.status === s.value ? null : s.value }), 'Status updated.')}>{s.label}</button>
                ))}
              </div>
            </div>
          )}
          <div className="card">
            <h2>Follow-ups</h2>
            {!openFollowUps.length && <p className="small muted">No open follow-up. Plan one so this lead is not forgotten.</p>}
            {openFollowUps.map((f) => (
              <div key={f.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)', flexWrap: 'nowrap' }}>
                <div style={{ minWidth: 0 }}>
                  <b style={{ color: new Date(f.dueAt) < new Date() ? 'var(--bad)' : undefined }}>{new Date(f.dueAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</b>
                  <span className="small muted"> · {relTime(f.dueAt)} · {f.user}</span>
                  {f.note && <div className="small">{f.note}</div>}
                </div>
                {lead.canUpdate && <button className="btn sm outline" onClick={() => act(() => call(`/api/v1/follow-ups/${f.id}`, 'PATCH', { done: true }), 'Follow-up done.')}>Done</button>}
              </div>
            ))}
          </div>
          {ws && <DetailsCard ws={ws} lead={lead} act={act} call={call} />}
        </div>

        <div className="card">
          <h2>Customer journey</h2>
          <div className="timeline">
            {lead.activities.map((a) => (
              <div key={a.id} className={`tl-item ${a.type} ${a.type === 'call' && !a.connected ? 'missed' : ''}`}>
                <span className="tl-dot" aria-hidden="true">{ICON[a.type] ?? '•'}</span>
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'baseline' }}>
                  <b style={{ fontSize: 13.5 }}>{describe(a)}</b>
                  <span className="small muted" style={{ whiteSpace: 'nowrap' }}>{relTime(a.at)}</span>
                </div>
                {a.remark && <div style={{ fontSize: 13.5, margin: '2px 0' }}>{a.remark}</div>}
                <div className="small muted">{a.user ?? 'System'} · {new Date(a.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
              </div>
            ))}
            <div className="tl-item">
              <span className="tl-dot" aria-hidden="true">★</span>
              <b style={{ fontSize: 13.5 }}>Enquiry received</b>
              <div className="small muted">{label('sources', lead.source)} · {new Date(lead.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
            </div>
          </div>
        </div>
      </div>
      {losing && ws && <LostDialog ws={ws} name={lead.name} onClose={() => setLosing(null)} onPick={(r) => moveTo(losing, r)} />}
      <style>{`@media (max-width: 960px) { .lead-grid { grid-template-columns: 1fr !important; } }`}</style>
    </>
  );
}

function ActionPanel({ ws, lead, act, call }: {
  ws: WorkspaceSettings; lead: LeadDetail;
  act: (fn: () => Promise<unknown>, text: string) => Promise<boolean>; call: (p: string, m: string, b?: unknown) => Promise<unknown>;
}) {
  const [tab, setTab] = useState<Tab>('call');
  const [disposition, setDisposition] = useState('');
  const [minutes, setMinutes] = useState('');
  const [remark, setRemark] = useState('');
  const [next, setNext] = useState('');
  const reset = () => { setDisposition(''); setMinutes(''); setRemark(''); setNext(''); };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const followUpAt = next ? new Date(next).toISOString() : undefined;
    let ok = false;
    if (tab === 'call') {
      ok = await act(() => call(`/api/v1/leads/${lead.id}/activities`, 'POST', {
        type: 'call', disposition, durationSec: minutes ? Math.round(Number(minutes) * 60) : undefined, remark: remark || undefined, followUpAt,
      }), 'Call logged.');
    } else if (tab === 'remark') {
      ok = await act(() => call(`/api/v1/leads/${lead.id}/activities`, 'POST', { type: 'remark', remark, followUpAt }), 'Remark added.');
    } else {
      ok = await act(() => call(`/api/v1/leads/${lead.id}/follow-ups`, 'POST', { dueAt: followUpAt, note: remark || undefined }), 'Follow-up planned.');
    }
    if (ok) reset();
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="row" style={{ gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 12 }}>
        {([['call', '📞 Log call'], ['remark', '📝 Remark'], ['follow_up', '⏰ Follow-up']] as [Tab, string][]).map(([k, l]) => (
          <button type="button" key={k} className="btn ghost sm" onClick={() => setTab(k)}
            style={{ borderRadius: 0, borderBottom: tab === k ? '2px solid var(--brand)' : '2px solid transparent', color: tab === k ? 'var(--brand)' : undefined }}>{l}</button>
        ))}
      </div>
      {tab === 'call' && (
        <>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>What happened on the call?</div>
          <div className="chips" style={{ marginBottom: 10 }}>
            {ws.dispositions.map((d) => (
              <button type="button" key={d.value} className={`chip ${disposition === d.value ? 'on' : ''}`} onClick={() => setDisposition(d.value ?? '')}
                style={disposition !== d.value && d.connected ? { borderColor: '#b9e3c8' } : undefined}>{d.label}</button>
            ))}
          </div>
          <div className="field" style={{ maxWidth: 160 }}><label>Talk time (minutes)</label><input className="input" type="number" min={0} step="0.5" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></div>
        </>
      )}
      <div className="field">
        <label>{tab === 'follow_up' ? 'Note (optional)' : tab === 'call' ? 'Remark (optional)' : 'Remark'}</label>
        <textarea className="input" style={{ height: 70, paddingTop: 8 }} value={remark} onChange={(e) => setRemark(e.target.value)} required={tab === 'remark'} placeholder={tab === 'call' ? 'What did the customer say?' : ''} />
      </div>
      <div className="field">
        <label>{tab === 'follow_up' ? 'Follow-up on' : 'Next follow-up (optional)'}</label>
        <div className="chips" style={{ marginBottom: 6 }}>
          {QUICK.map((q) => <button type="button" key={q.label} className="chip" onClick={() => setNext(toLocal(q.date()))}>{q.label}</button>)}
        </div>
        <input className="input" type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} required={tab === 'follow_up'} />
      </div>
      <div className="row end">
        <button className="btn" disabled={tab === 'call' && !disposition}>{tab === 'call' ? 'Save call' : tab === 'remark' ? 'Add remark' : 'Plan follow-up'}</button>
      </div>
    </form>
  );
}

function DetailsCard({ ws, lead, act, call }: {
  ws: WorkspaceSettings; lead: LeadDetail;
  act: (fn: () => Promise<unknown>, text: string) => Promise<boolean>; call: (p: string, m: string, b?: unknown) => Promise<unknown>;
}) {
  const fields = ws.fields.filter((f) => !f.isArchived);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>(lead.customFields);
  useEffect(() => { setValues(lead.customFields); }, [lead]);
  if (!fields.length) return null;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{ws.name} details</h2>
        {lead.canUpdate && !editing && <button className="btn sm ghost" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {!editing ? (
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', margin: '10px 0 0' }}>
          {fields.map((f) => [
            <dt key={`${f.key}-l`} className="muted small">{f.label}</dt>,
            <dd key={`${f.key}-v`} style={{ margin: 0 }}>{showValue(f, lead.customFields[f.key]) || '—'}</dd>,
          ])}
        </dl>
      ) : (
        <form style={{ marginTop: 10 }} onSubmit={async (e) => {
          e.preventDefault();
          if (await act(() => call(`/api/v1/leads/${lead.id}/fields`, 'PATCH', { customFields: values }), 'Details saved.')) setEditing(false);
        }}>
          {fields.map((f) => (
            <div key={f.key} className="field">
              <label htmlFor={`f_${f.key}`}>{f.label}{f.required && ' *'}</label>
              <FieldInput field={f} value={values[f.key]} onChange={(v) => setValues({ ...values, [f.key]: v })} />
            </div>
          ))}
          <div className="row end">
            <button type="button" className="btn ghost" onClick={() => { setValues(lead.customFields); setEditing(false); }}>Cancel</button>
            <button className="btn">Save</button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function LeadDetailPage() {
  return (
    <Suspense fallback={null}>
      <LeadPage />
    </Suspense>
  );
}
