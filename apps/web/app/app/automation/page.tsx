'use client';

import { Icon } from '@/components/Icon';
import { PickWorkspace } from '@/components/PickWorkspace';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Opt { value: string; label: string }
interface Options { canManage: boolean; triggers: Opt[]; actions: Opt[]; ops: Opt[]; fields: Opt[]; stages: Opt[]; statuses: Opt[]; sources: Opt[]; labels: Opt[]; users: Opt[]; templates: Opt[]; sequences: Opt[]; apiTemplates?: Opt[] }
interface Cond { field: string; op: string; value?: string }
interface Act { type: string; userId?: string; stageId?: string; status?: string; labelId?: string; title?: string; dueHours?: number; text?: string; templateId?: string; sequenceId?: string; apiTemplateId?: string }
interface Rule { id: string; name: string; trigger: string; idleDays: number | null; conditions: Cond[]; actions: Act[]; isActive: boolean; runCount: number; lastRunAt: string | null }
interface Run { id: string; ruleName: string; event: string; leadId: string | null; leadName: string | null; status: string; detail: string | null; createdAt: string }
interface Seq { id: string; name: string; stopOnReply: boolean; steps: { delayHours: number; templateId: string }[]; counts: Record<string, number> }
type Tab = 'rules' | 'sequences' | 'log';
type Draft = { id?: string; name: string; trigger: string; idleDays: number | null; conditions: Cond[]; actions: Act[]; isActive: boolean };
const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const empty = (): Draft => ({ name: '', trigger: 'lead.created', idleDays: null, conditions: [], actions: [{ type: 'add_remark', text: '' }], isActive: true });
const NO_VALUE = ['empty', 'not_empty'];

/** Rules ("when, if, then") and sequences of the selected business line. */
export default function AutomationPage() {
  const { me, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [tab, setTab] = useState<Tab>('rules');
  const [o, setO] = useState<Options | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [seqs, setSeqs] = useState<Seq[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(async () => {
    if (!ws) return;
    const [a, b, c, d] = await Promise.all([api<Options>('/api/v1/automation/options').catch(() => null), api<Rule[]>('/api/v1/automation/rules').catch(() => []), api<Run[]>('/api/v1/automation/runs').catch(() => []), api<Seq[]>('/api/v1/automation/sequences').catch(() => [])]);
    setO(a); setRules(b); setRuns(c); setSeqs(d);
  }, [ws]);
  useEffect(() => { load(); }, [load, version]);
  const act = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; } };

  if (!ws) return <><div className="page-head"><h1>Automation</h1></div><PickWorkspace text="Automation belongs to a business line." /></>;
  if (!o) return <><div className="page-head"><h1>Automation</h1></div><div className="card muted">Automation is not available on this plan or for your role.</div></>;
  const label = (list: Opt[], v?: string | null) => list.find((x) => x.value === v)?.label ?? v ?? '';
  const describeAct = (a: Act) => `${label(o.actions, a.type)}${a.type === 'assign' ? `: ${a.userId && a.userId !== 'rules' ? label(o.users, a.userId) : 'next person in turn'}` : a.stageId ? `: ${label(o.stages, a.stageId)}` : a.status ? `: ${label(o.statuses, a.status)}` : a.labelId ? `: ${label(o.labels, a.labelId)}` : a.templateId ? `: ${label(o.templates, a.templateId)}` : a.sequenceId ? `: ${label(o.sequences, a.sequenceId)}` : a.apiTemplateId ? `: ${label(o.apiTemplates ?? [], a.apiTemplateId)}` : a.title ? `: ${a.title}` : ''}`;
  const describeCond = (c: Cond) => `${label(o.fields, c.field)} ${label(o.ops, c.op)}${NO_VALUE.includes(c.op) ? '' : ` ${c.field === 'stage' ? label(o.stages, c.value) : c.field === 'owner' ? label(o.users, c.value) : c.field === 'status' ? label(o.statuses, c.value) : c.field === 'source' ? label(o.sources, c.value) : c.value}`}`;
  return (
    <>
      <div className="page-head">
        <div><h1>Automation</h1><p className="muted small" style={{ margin: 0 }}>Let UBOS do the routine work: when something happens, if it matches, then act. Rules run in the background within seconds.</p></div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Link className="btn outline" href="/app/automation/flows">Flows</Link>
          {o.canManage && tab === 'rules' && !draft && <button className="btn" onClick={() => setDraft(empty())}>+ New rule</button>}
        </div>
      </div>
      <div className="dash-tabs" role="tablist">{([['rules', `Rules (${rules.length})`], ['sequences', `Sequences (${seqs.length})`], ['log', 'Activity']] as [Tab, string][]).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`dash-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {tab === 'rules' && draft && <RuleForm o={o} d={draft} set={setDraft} onCancel={() => setDraft(null)} onSave={async () => {
        const { id, ...body } = draft;
        const clean = { ...body, conditions: draft.conditions.map((c) => (NO_VALUE.includes(c.op) ? { field: c.field, op: c.op } : c)) };
        if (await act(() => api(id ? `/api/v1/automation/rules/${id}` : '/api/v1/automation/rules', { method: id ? 'PUT' : 'POST', body: clean }), 'Rule saved.')) setDraft(null);
      }} />}
      {tab === 'rules' && !draft && (
        <div className="card">
          {!rules.length && <p className="small muted" style={{ margin: 0 }}>No rules yet. Example: when a lead arrives from the website, create a call task and notify the owner.</p>}
          {rules.map((r) => (
            <div key={r.id} className="run-card" style={r.isActive ? undefined : { opacity: 0.6 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span><b>{r.name}</b> <span className={`badge ${r.isActive ? 'ok' : 'grey'}`}>{r.isActive ? 'On' : 'Paused'}</span></span>
                {o.canManage && <span className="row" style={{ gap: 4 }}>
                  <button className="btn sm ghost" onClick={() => setDraft({ id: r.id, name: r.name, trigger: r.trigger, idleDays: r.idleDays, conditions: r.conditions, actions: r.actions, isActive: r.isActive })}>Edit</button>
                  <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/automation/rules/${r.id}`, { method: 'PATCH', body: { isActive: !r.isActive } }), r.isActive ? 'Rule paused.' : 'Rule switched on.')}>{r.isActive ? 'Pause' : 'Switch on'}</button>
                  <button className="btn sm ghost" title="Copy this rule into a flow (switched off) to add waits and paths" onClick={async () => { try { const fl = await api<{ id: string }>(`/api/v1/automation/rules/${r.id}/to-flow`, { method: 'POST' }); window.location.href = `/app/automation/flows/${fl.id}`; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } }}>Open as flow</button>
                  <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/automation/rules/${r.id}`, { method: 'PATCH', body: { isArchived: true } }), 'Rule archived.')}>Archive</button>
                </span>}
              </div>
              <div className="small" style={{ marginTop: 4 }}><b>When</b> {label(o.triggers, r.trigger)}{r.trigger === 'lead.idle' ? ` (${r.idleDays} days)` : ''}{r.conditions.length > 0 && <> · <b>if</b> {r.conditions.map(describeCond).join(' and ')}</>} · <b>then</b> {r.actions.map(describeAct).join(', ')}</div>
              <div className="small muted">Ran {r.runCount} time(s){r.lastRunAt ? ` · last ${when(r.lastRunAt)}` : ''}</div>
            </div>
          ))}
        </div>
      )}
      {tab === 'sequences' && <Sequences o={o} seqs={seqs} act={act} />}
      {tab === 'log' && (
        <div className="card">{!runs.length ? <p className="small muted" style={{ margin: 0 }}>Nothing has run yet.</p> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>When</th><th>Rule</th><th>Lead</th><th>Result</th></tr></thead>
            <tbody>{runs.map((r) => <tr key={r.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{when(r.createdAt)}</td><td className="small"><b>{r.ruleName}</b></td><td className="small">{r.leadId ? <Link href={`/app/leads/${r.leadId}`}>{r.leadName ?? 'Lead'}</Link> : '—'}</td><td className="small"><span className={`badge ${r.status === 'done' ? 'ok' : 'bad'}`}>{r.status}</span> {r.detail}</td></tr>)}</tbody></table></div>
        )}</div>
      )}
    </>
  );
}

function RuleForm({ o, d, set, onSave, onCancel }: { o: Options; d: Draft; set: (d: Draft) => void; onSave: () => void; onCancel: () => void }) {
  const cond = (i: number, p: Partial<Cond>) => set({ ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const action = (i: number, p: Partial<Act>) => set({ ...d, actions: d.actions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  const pick = (list: Opt[], value: string | undefined, onChange: (v: string) => void, aria: string) => <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={aria} required><option value="">Choose…</option>{list.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>;
  const valueInput = (c: Cond, i: number) => {
    const list = c.field === 'stage' ? o.stages : c.field === 'status' ? o.statuses : c.field === 'source' ? o.sources : c.field === 'owner' ? o.users : null;
    return list ? pick(list, c.value, (v) => cond(i, { value: v }), 'Value') : <input className="input" value={c.value ?? ''} onChange={(e) => cond(i, { value: e.target.value })} aria-label="Value" required />;
  };
  return (
    <form className="card" style={{ maxWidth: 900 }} onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <h2>{d.id ? 'Edit rule' : 'New rule'}</h2>
      <div className="field"><label>Name</label><input className="input" value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} required minLength={2} placeholder="e.g. Website leads get a call task" /></div>
      <h3 className="rule-h">When</h3>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <select className="input" value={d.trigger} onChange={(e) => set({ ...d, trigger: e.target.value })} aria-label="Trigger">{o.triggers.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
        {d.trigger === 'lead.idle' && <input className="input" style={{ maxWidth: 130 }} type="number" min={1} max={365} value={d.idleDays ?? ''} onChange={(e) => set({ ...d, idleDays: e.target.value ? Number(e.target.value) : null })} placeholder="Days" aria-label="Days" required />}
      </div>
      <h3 className="rule-h">If <span className="small muted" style={{ fontWeight: 400 }}>(all must match; leave empty for every lead)</span></h3>
      {d.conditions.map((c, i) => (
        <div key={i} className="row" style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
          <select className="input" value={c.field} onChange={(e) => cond(i, { field: e.target.value, value: '' })} aria-label="Field">{o.fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select>
          <select className="input" style={{ maxWidth: 130 }} value={c.op} onChange={(e) => cond(i, { op: e.target.value })} aria-label="Comparison">{o.ops.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
          {!NO_VALUE.includes(c.op) && valueInput(c, i)}
          <button type="button" className="btn sm ghost" aria-label="Remove condition" onClick={() => set({ ...d, conditions: d.conditions.filter((_, j) => j !== i) })}><Icon name="close" className="ic" /></button>
        </div>
      ))}
      <button type="button" className="btn sm ghost" onClick={() => set({ ...d, conditions: [...d.conditions, { field: 'source', op: 'eq', value: '' }] })}>+ Condition</button>
      <h3 className="rule-h">Then</h3>
      {d.actions.map((a, i) => (
        <div key={i} className="row" style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
          <select className="input" style={{ maxWidth: 260 }} value={a.type} onChange={(e) => set({ ...d, actions: d.actions.map((x, j) => (j === i ? { type: e.target.value } : x)) })} aria-label="Action">{o.actions.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
          {a.type === 'assign' && <select className="input" value={a.userId ?? 'rules'} onChange={(e) => action(i, { userId: e.target.value })} aria-label="Assign to"><option value="rules">Next person in turn</option>{o.users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select>}
          {a.type === 'change_stage' && pick(o.stages, a.stageId, (v) => action(i, { stageId: v }), 'Stage')}
          {a.type === 'set_status' && pick(o.statuses, a.status, (v) => action(i, { status: v }), 'Status')}
          {a.type === 'add_label' && pick(o.labels, a.labelId, (v) => action(i, { labelId: v }), 'Label')}
          {a.type === 'send_template' && pick(o.templates, a.templateId, (v) => action(i, { templateId: v }), 'Template')}
          {a.type === 'enroll_sequence' && pick(o.sequences, a.sequenceId, (v) => action(i, { sequenceId: v }), 'Sequence')}
          {a.type === 'call_api' && pick(o.apiTemplates ?? [], a.apiTemplateId, (v) => action(i, { apiTemplateId: v }), 'API template')}
          {a.type === 'create_task' && <><input className="input" value={a.title ?? ''} onChange={(e) => action(i, { title: e.target.value })} placeholder="Task title (use {name})" aria-label="Task title" required /><input className="input" style={{ maxWidth: 110 }} type="number" min={0} value={a.dueHours ?? 24} onChange={(e) => action(i, { dueHours: Number(e.target.value) })} aria-label="Due after hours" title="Due after this many hours" /></>}
          {(a.type === 'add_remark' || a.type === 'notify_owner') && <input className="input" value={a.text ?? ''} onChange={(e) => action(i, { text: e.target.value })} placeholder="Text (use {name})" aria-label="Text" required />}
          <button type="button" className="btn sm ghost" disabled={d.actions.length === 1} aria-label="Remove action" onClick={() => set({ ...d, actions: d.actions.filter((_, j) => j !== i) })}><Icon name="close" className="ic" /></button>
        </div>
      ))}
      <button type="button" className="btn sm ghost" onClick={() => set({ ...d, actions: [...d.actions, { type: 'add_remark', text: '' }] })}>+ Action</button>
      <div className="row end" style={{ marginTop: 12 }}><button type="button" className="btn ghost" onClick={onCancel}>Cancel</button><button className="btn">Save rule</button></div>
    </form>
  );
}

function Sequences({ o, seqs, act }: { o: Options; seqs: Seq[]; act: (fn: () => Promise<unknown>, t: string) => Promise<boolean> }) {
  const [f, setF] = useState<{ name: string; stopOnReply: boolean; steps: { delayHours: number; templateId: string }[] }>({ name: '', stopOnReply: true, steps: [{ delayHours: 0, templateId: '' }] });
  const name = (id: string) => o.templates.find((t) => t.value === id)?.label ?? 'Template';
  return (
    <div className={o.canManage ? 'prod-grid' : ''}>
      <div className="card">
        {!seqs.length && <p className="small muted" style={{ margin: 0 }}>No sequences yet. A sequence sends messages over days and stops when the customer replies.</p>}
        {seqs.map((s) => (
          <div key={s.id} className="run-card">
            <div className="row" style={{ justifyContent: 'space-between' }}><span><b>{s.name}</b> {s.stopOnReply && <span className="badge grey">Stops on reply</span>}</span>{o.canManage && <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/automation/sequences/${s.id}/archive`, { method: 'POST' }), 'Sequence archived.')}>Archive</button>}</div>
            <ol className="small" style={{ margin: '6px 0', paddingLeft: 20 }}>{s.steps.map((x, i) => <li key={i}>{x.delayHours ? `After ${x.delayHours >= 24 && x.delayHours % 24 === 0 ? `${x.delayHours / 24} day(s)` : `${x.delayHours} hour(s)`}` : 'Straight away'}: {name(x.templateId)}</li>)}</ol>
            <div className="small muted">{Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'Nobody on it yet'}</div>
          </div>
        ))}
      </div>
      {o.canManage && (
        <form className="card" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('/api/v1/automation/sequences', { method: 'POST', body: f }), 'Sequence saved.')) setF({ name: '', stopOnReply: true, steps: [{ delayHours: 0, templateId: '' }] }); }}>
          <h2>New sequence</h2>
          <div className="field"><label>Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} placeholder="e.g. New lead nurture" /></div>
          {f.steps.map((s, i) => (
            <div key={i} className="row" style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
              <input className="input" style={{ maxWidth: 90 }} type="number" min={0} value={s.delayHours} onChange={(e) => setF({ ...f, steps: f.steps.map((x, j) => (j === i ? { ...x, delayHours: Number(e.target.value) } : x)) })} aria-label="Wait hours" title="Hours to wait before this step" />
              <select className="input" value={s.templateId} onChange={(e) => setF({ ...f, steps: f.steps.map((x, j) => (j === i ? { ...x, templateId: e.target.value } : x)) })} aria-label="Template" required><option value="">Choose a template…</option>{o.templates.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
              <button type="button" className="btn sm ghost" disabled={f.steps.length === 1} aria-label="Remove step" onClick={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })}><Icon name="close" className="ic" /></button>
            </div>
          ))}
          <div className="small muted" style={{ marginBottom: 6 }}>Hours to wait before each step (0 = straight away).</div>
          <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, steps: [...f.steps, { delayHours: 24, templateId: '' }] })}>+ Step</button>
          <label className="row small" style={{ margin: '8px 0' }}><input type="checkbox" checked={f.stopOnReply} onChange={(e) => setF({ ...f, stopOnReply: e.target.checked })} /> Stop when the customer replies on WhatsApp</label>
          <div className="row end"><button className="btn">Save sequence</button></div>
        </form>
      )}
    </div>
  );
}
