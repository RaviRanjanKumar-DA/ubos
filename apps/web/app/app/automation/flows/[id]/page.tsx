'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { FlowAction, FlowNode } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm } from '@/components/Dialogs';
import { Icon } from '@/components/Icon';
import { findStep, insertStep, moveStep, newId, removeStep, updateStep, waitLabel, type Slot } from '@/components/flow/tree';

interface Opt { value: string; label: string }
interface Options { canManage: boolean; triggers: Opt[]; actions: Opt[]; ops: Opt[]; fields: Opt[]; stages: Opt[]; statuses: Opt[]; sources: Opt[]; labels: Opt[]; users: Opt[]; templates: Opt[]; sequences: Opt[]; apiTemplates?: Opt[] }
interface Flow { id: string; name: string; trigger: string; idleDays: number | null; stopWhenClosed: boolean; isActive: boolean; graph: { steps: FlowNode[] } }
interface Run { id: string; leadId: string; leadName: string; status: string; nodeId: string | null; nextAt: string | null; error: string | null; createdAt: string; log: { nodeId: string; at: string; result: string }[] }
type Cond = { field: string; op: string; value?: string };
const NO_VALUE = ['empty', 'not_empty'];
const RUN_TONE: Record<string, [string, string]> = { running: ['ok', 'Running'], waiting: ['warn', 'Waiting'], done: ['grey', 'Finished'], failed: ['bad', 'Failed'], stopped: ['grey', 'Stopped'] };
const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

type Drag = { kind: 'new'; node: 'action' | 'wait' | 'condition'; action?: string } | { kind: 'move'; id: string } | { kind: 'trigger'; value: string };
const ACTION_ICON: Record<string, string> = { assign: 'leads', change_stage: 'board', set_status: 'flag', add_label: 'tag', create_task: 'checklist', add_remark: 'edit', send_template: 'chat', notify_owner: 'bell', enroll_sequence: 'list', call_api: 'code' };
const TRIGGER_ICON: Record<string, string> = { 'lead.created': 'plus', 'lead.updated': 'refresh', 'lead.stage_changed': 'board', 'lead.won': 'star', 'lead.lost': 'close', 'call.logged': 'phone', 'whatsapp.received': 'chat', 'payment.received': 'receipt', 'quote.accepted': 'tick', 'process.completed': 'checklist', 'lead.idle': 'clock' };

export default function FlowBuilder() {
  const { id } = useParams<{ id: string }>();
  const { version } = useShell();
  const [o, setO] = useState<Options | null>(null);
  const [f, setF] = useState<Flow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [tab, setTab] = useState<'editor' | 'runs'>('editor');
  const [edit, setEdit] = useState<{ node: FlowNode; slot: Slot | null } | null>(null);
  const [adding, setAdding] = useState<Slot | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [armed, setArmed] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [palette, setPalette] = useState(true);
  const [path, setPath] = useState<{ label: string; results: Map<string, string> } | null>(null);
  const [leadQ, setLeadQ] = useState('');
  const [leads, setLeads] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const [opts, flow, rs] = await Promise.all([api<Options>('/api/v1/automation/options'), api<Flow>(`/api/v1/automation/flows/${id}`), api<Run[]>(`/api/v1/automation/flows/${id}/runs`)]);
      setO(opts); setF(flow); setRuns(rs); setDirty(false);
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed' }); }
  }, [id]);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => {
    if (leadQ.trim().length < 2) return setLeads([]);
    const t = setTimeout(() => { api<{ rows?: { id: string; name: string }[] }>(`/api/v1/leads?q=${encodeURIComponent(leadQ.trim())}&limit=6`).then((r) => setLeads((r.rows ?? (r as unknown as { id: string; name: string }[])).slice(0, 6))).catch(() => setLeads([])); }, 250);
    return () => clearTimeout(t);
  }, [leadQ]);
  if (!f || !o) return <>{msg && <div className={msg.type}>{msg.text}</div>}</>;

  const can = o.canManage;
  const label = (list: Opt[], v?: string) => list.find((x) => x.value === v)?.label ?? v ?? '';
  const describe = (n: FlowNode): [string, string] => {
    if (n.type === 'wait') return ['Time delay', waitLabel(n.hours)];
    if (n.type === 'condition') return ['Check lead', n.conditions.map((c) => `${label(o.fields, c.field)} ${label(o.ops, c.op)}${NO_VALUE.includes(c.op) ? '' : ` ${label(c.field === 'stage' ? o.stages : c.field === 'status' ? o.statuses : c.field === 'source' ? o.sources : c.field === 'owner' ? o.users : [], c.value) || c.value}`}`).join(' and ')];
    const a = n.action;
    const detail = a.type === 'assign' ? (a.userId && a.userId !== 'rules' ? label(o.users, a.userId) : 'next person in turn') : a.type === 'change_stage' ? label(o.stages, a.stageId) : a.type === 'set_status' ? label(o.statuses, a.status) : a.type === 'add_label' ? label(o.labels, a.labelId) : a.type === 'send_template' ? label(o.templates, a.templateId) : a.type === 'enroll_sequence' ? label(o.sequences, a.sequenceId) : a.type === 'call_api' ? label(o.apiTemplates ?? [], a.apiTemplateId) : a.type === 'create_task' ? `${a.title} (due in ${a.dueHours ?? 24} h)` : a.text ?? '';
    return [label(o.actions, a.type), detail];
  };
  const change = (steps: FlowNode[]) => { setF({ ...f, graph: { steps } }); setDirty(true); setPath(null); };
  const setTrigger = (value: string) => { setF({ ...f, trigger: value, idleDays: value === 'lead.idle' ? f.idleDays ?? 7 : null }); setDirty(true); };
  const save = async () => {
    setMsg(null);
    try { await api(`/api/v1/automation/flows/${f.id}`, { method: 'PUT', body: { name: f.name, trigger: f.trigger, idleDays: f.trigger === 'lead.idle' ? f.idleDays : null, stopWhenClosed: f.stopWhenClosed, graph: f.graph } }); setMsg({ type: 'notice', text: 'Flow saved.' }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  };
  const toggle = async () => {
    if (dirty && !(await save())) return;
    try { await api(`/api/v1/automation/flows/${f.id}`, { method: 'PATCH', body: { isActive: !f.isActive } }); setMsg({ type: 'notice', text: f.isActive ? 'Flow switched off. Leads already in it carry on.' : 'Flow switched on.' }); load(); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  };
  const archive = async () => { if (!(await askConfirm('Archive this flow? Leads still in it stop; the history stays.'))) return; await api(`/api/v1/automation/flows/${f.id}`, { method: 'PATCH', body: { isArchived: true } }); window.location.href = '/app/automation/flows'; };
  const preview = async (lead: { id: string; name: string }) => {
    setLeadQ(''); setLeads([]);
    if (dirty && !(await save())) return;
    try { const r = await api<{ leadName: string; path: { nodeId: string; result: string }[] }>(`/api/v1/automation/flows/${f.id}/preview`, { method: 'POST', body: { leadId: lead.id } }); setPath({ label: `Path for ${r.leadName} (nothing was done)`, results: new Map(r.path.map((p) => [p.nodeId, p.result])) }); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  };
  const runNow = async (leadId: string) => { try { await api(`/api/v1/automation/flows/${f.id}/start`, { method: 'POST', body: { leadId } }); setMsg({ type: 'notice', text: 'Started for this lead. See Executions.' }); setTimeout(load, 800); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); } };
  const blank = (kind: 'action' | 'wait' | 'condition', action?: string): FlowNode => kind === 'action' ? { id: newId(), type: 'action', action: { type: action ?? 'add_remark', ...(action === 'assign' ? { userId: 'rules' } : action === 'create_task' ? { dueHours: 24 } : {}) } } : kind === 'wait' ? { id: newId(), type: 'wait', hours: 24 } : { id: newId(), type: 'condition', conditions: [{ field: 'source', op: 'eq', value: '' }], yes: [], no: [] };

  /** What a palette item or dragged card does when it lands on a connection point. */
  const place = (d: Drag, slot: Slot) => {
    setDrag(null); setArmed(null); setOver(null);
    if (d.kind === 'trigger') return;
    if (d.kind === 'move') {
      const next = moveStep(f.graph.steps, d.id, slot);
      if (!next) return setMsg({ type: 'error', text: 'A "Check lead" step cannot be moved inside its own paths.' });
      if (next !== f.graph.steps) change(next);
      return;
    }
    const node = blank(d.node, d.action);
    // Steps that need details open their settings; the rest drop straight in.
    if (d.node === 'action' && ['add_remark', 'notify_owner', 'create_task', 'change_stage', 'set_status', 'add_label', 'send_template', 'enroll_sequence', 'call_api'].includes(d.action ?? '') || d.node !== 'action') setEdit({ node, slot });
    else change(insertStep(f.graph.steps, slot, node));
  };
  const slotKey = (s: Slot) => `${s.parentId ?? 'root'}:${s.branch ?? ''}:${s.index}`;
  const live = drag ?? armed;
  const dragProps = (d: Drag) => ({
    draggable: can, onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', 'ubos-flow'); e.dataTransfer.effectAllowed = 'move'; setDrag(d); setArmed(null); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  });

  const plus = (slot: Slot) => {
    const k = slotKey(slot);
    if (!can) return <div key={k} className="flow-link" />;
    const accepts = !!live && live.kind !== 'trigger';
    return (
      <div key={k} className="flow-link">
        <button type="button" className={`flow-plus${accepts ? ' ready' : ''}${over === k ? ' over' : ''}`} aria-label={accepts ? 'Drop the step here' : 'Add a step here'}
          onClick={() => (armed && armed.kind !== 'trigger' ? place(armed, slot) : setAdding(slot))}
          onDragOver={(e) => { if (drag && drag.kind !== 'trigger') { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== k) setOver(k); } }}
          onDragLeave={() => setOver((x) => (x === k ? null : x))}
          onDrop={(e) => { e.preventDefault(); if (drag) place(drag, slot); }}>
          <Icon name="plus" className="ic" />
        </button>
      </div>
    );
  };
  const steps = (list: FlowNode[], parentId: string | null, branch: 'yes' | 'no' | null) => (
    <div className="flow-col">
      {plus({ parentId, branch, index: 0 })}
      {list.map((n, i) => {
        const [title, detail] = describe(n);
        const hit = path?.results.get(n.id);
        return (
          <div key={n.id} className="flow-col">
            <button type="button" {...dragProps({ kind: 'move', id: n.id })} className={`flow-card t-${n.type}${hit ? ' hit' : ''}${drag?.kind === 'move' && drag.id === n.id ? ' dragging' : ''}`} disabled={!can} onClick={() => setEdit({ node: n, slot: null })} title={can ? 'Click to change, drag to move' : undefined}>
              <span className="flow-kind">{can && <Icon name="grip" className="ic flow-grip" />}{title}</span>
              <span className="flow-detail">{detail || '—'}</span>
              {hit && <span className="badge brand">{hit}</span>}
            </button>
            {n.type === 'condition' ? (
              <div className="flow-split">
                <div><div className="flow-branch yes">Yes</div>{steps(n.yes, n.id, 'yes')}</div>
                <div><div className="flow-branch no">No</div>{steps(n.no, n.id, 'no')}</div>
              </div>
            ) : plus({ parentId, branch, index: i + 1 })}
          </div>
        );
      })}
      {!list.length && <div className="flow-end small muted">End</div>}
    </div>
  );
  const item = (d: Drag, icon: string, text: string) => {
    const on = armed && JSON.stringify(armed) === JSON.stringify(d);
    return (
      <button key={JSON.stringify(d)} type="button" {...dragProps(d)} className={`flow-tool${on ? ' on' : ''}`} disabled={!can}
        onClick={() => (d.kind === 'trigger' ? setTrigger(d.value) : setArmed(on ? null : d))} title={d.kind === 'trigger' ? 'Click or drop on "When" to use this event' : 'Drag onto a + in the flow, or click then click a +'}>
        <Icon name={icon} className="ic" /><span>{text}</span>
      </button>
    );
  };
  const triggerDrop = { onDragOver: (e: React.DragEvent) => { if (drag?.kind === 'trigger') e.preventDefault(); }, onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag?.kind === 'trigger') { setTrigger(drag.value); setDrag(null); } } };

  return (
    <>
      <div className="page-head">
        <div className="flow-head">
          <div className="small"><Link href="/app/automation/flows">Flows</Link></div>
          <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            {can ? <input className="input flow-name" aria-label="Flow name" value={f.name} onChange={(e) => { setF({ ...f, name: e.target.value }); setDirty(true); }} /> : <h1>{f.name}</h1>}
            <span className={`badge ${f.isActive ? 'ok' : 'grey'}`}>{f.isActive ? 'On' : 'Draft'}</span>
          </div>
        </div>
        {can && <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={archive}>Archive</button>
          <button className="btn outline" disabled={!dirty} onClick={save}>{dirty ? 'Save' : 'Saved'}</button>
          <button className={`btn ${f.isActive ? 'outline' : ''}`} onClick={toggle}>{f.isActive ? 'Switch off' : 'Switch on'}</button>
        </div>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="dash-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'editor'} className={`dash-tab${tab === 'editor' ? ' on' : ''}`} onClick={() => setTab('editor')}>Editor</button>
        <button role="tab" aria-selected={tab === 'runs'} className={`dash-tab${tab === 'runs' ? ' on' : ''}`} onClick={() => setTab('runs')}>Executions ({runs.length})</button>
      </div>

      {tab === 'editor' && (
        <div className={`flow-shell${palette && can ? '' : ' closed'}`}>
          {can && palette && (
            <aside className="flow-palette" aria-label="Steps you can add">
              <div className="flow-pal-head"><b>Events</b><span className="small muted">When this happens</span></div>
              <div className="flow-tools">{o.triggers.map((t) => item({ kind: 'trigger', value: t.value }, TRIGGER_ICON[t.value] ?? 'bolt', t.label))}</div>
              <div className="flow-pal-head"><b>Actions</b><span className="small muted">Do this…</span></div>
              <div className="flow-tools">
                {o.actions.map((a) => item({ kind: 'new', node: 'action', action: a.value }, ACTION_ICON[a.value] ?? 'bolt', a.label))}
                {item({ kind: 'new', node: 'wait' }, 'clock', 'Time delay')}
                {item({ kind: 'new', node: 'condition' }, 'funnel', 'Check lead (if / else)')}
              </div>
              {armed && <div className="small flow-armed">Now click a <b>+</b> in the flow to place it. <button className="btn ghost sm" onClick={() => setArmed(null)}>Cancel</button></div>}
            </aside>
          )}
          <div className="flow-main">
            <div className="card flow-top">
              {can && <button className="btn ghost sm" onClick={() => setPalette(!palette)}>{palette ? 'Hide steps' : 'Show steps'}</button>}
              <label className="small" htmlFor="fl-t">Starts when</label>
              <select id="fl-t" className="input" disabled={!can} value={f.trigger} onChange={(e) => setTrigger(e.target.value)}>{o.triggers.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
              {f.trigger === 'lead.idle' && <input className="input" style={{ maxWidth: 110 }} type="number" min={1} max={365} aria-label="Days without activity" disabled={!can} value={f.idleDays ?? 7} onChange={(e) => { setF({ ...f, idleDays: Number(e.target.value) }); setDirty(true); }} />}
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" disabled={!can} checked={f.stopWhenClosed} onChange={(e) => { setF({ ...f, stopWhenClosed: e.target.checked }); setDirty(true); }} />Leave when the lead is won or lost</label>
            </div>
            <div className="card flow-try">
              <div className="small"><b>Try it on a lead</b>: see the path, nothing is done.</div>
              <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
                <input className="input" aria-label="Find a lead" placeholder="Search a lead by name or mobile" value={leadQ} onChange={(e) => setLeadQ(e.target.value)} />
                {leads.length > 0 && <div className="flow-results">{leads.map((l) => <div key={l.id} className="row" style={{ justifyContent: 'space-between' }}><button type="button" className="btn ghost sm" onClick={() => preview(l)}>{l.name}</button>{can && <button type="button" className="btn ghost sm" onClick={() => runNow(l.id)}>Run now</button>}</div>)}</div>}
              </div>
              {path && <div className="small"><b>{path.label}</b> <button className="btn ghost sm" onClick={() => setPath(null)}>Clear</button></div>}
            </div>
            <div className={`card flow-canvas${live ? ' dragging' : ''}`}>
              <div className="flow-col">
                <div className={`flow-card t-trigger${drag?.kind === 'trigger' ? ' ready' : ''}`} aria-label="Trigger" {...triggerDrop}><span className="flow-kind">When</span><span className="flow-detail">{label(o.triggers, f.trigger)}{f.trigger === 'lead.idle' ? ` for ${f.idleDays ?? 7} days` : ''}</span></div>
                {steps(f.graph.steps, null, null)}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'runs' && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Lead</th><th>Status</th><th>Now at</th><th>Started</th><th /></tr></thead>
              <tbody>
                {runs.map((r) => {
                  const at = r.nodeId && r.nodeId !== '__end__' ? findStep(f.graph.steps, r.nodeId) : null;
                  return (
                    <tr key={r.id}>
                      <td><Link href={`/app/leads/${r.leadId}`}>{r.leadName}</Link></td>
                      <td><span className={`badge ${RUN_TONE[r.status]?.[0]}`}>{RUN_TONE[r.status]?.[1] ?? r.status}</span>{r.error && <div className="small muted">{r.error}</div>}</td>
                      <td className="small">{r.status === 'waiting' && r.nextAt ? `Wakes ${when(r.nextAt)}` : at ? describe(at).join(': ') : '—'}</td>
                      <td className="small">{when(r.createdAt)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn ghost sm" onClick={() => { setPath({ label: `What happened for ${r.leadName}`, results: new Map(r.log.map((x) => [x.nodeId, x.result])) }); setTab('editor'); }}>Show path</button>
                        {can && (r.status === 'running' || r.status === 'waiting') && <button className="btn ghost sm" onClick={async () => { await api(`/api/v1/automation/flow-runs/${r.id}/stop`, { method: 'POST' }); load(); }}>Stop</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!runs.length && <div className="empty">No leads have entered this flow yet.</div>}
          </div>
        </div>
      )}

      {adding && (
        <div className="modal-bg">
          <div className="modal">
            <h2>Add a step</h2>
            <div className="flow-pick">
              <button className="btn outline" onClick={() => { setEdit({ node: blank('action'), slot: adding }); setAdding(null); }}>Do something<span className="small muted">Assign, task, message, stage…</span></button>
              <button className="btn outline" onClick={() => { setEdit({ node: blank('wait'), slot: adding }); setAdding(null); }}>Time delay<span className="small muted">Minutes, hours or days</span></button>
              <button className="btn outline" onClick={() => { setEdit({ node: blank('condition'), slot: adding }); setAdding(null); }}>Check lead (if / else)<span className="small muted">Split into Yes and No</span></button>
            </div>
            <div className="row end"><button className="btn ghost" onClick={() => setAdding(null)}>Go back</button></div>
          </div>
        </div>
      )}
      {edit && <StepEditor o={o} node={edit.node} isNew={!!edit.slot} onClose={() => setEdit(null)}
        onSave={(n) => { change(edit.slot ? insertStep(f.graph.steps, edit.slot, n) : updateStep(f.graph.steps, n.id, n)); setEdit(null); }}
        onDelete={async () => { if (edit.node.type === 'condition' && !(await askConfirm('Delete this check? The Yes steps stay; the No steps are removed.'))) return; change(removeStep(f.graph.steps, edit.node.id)); setEdit(null); }} />}
    </>
  );
}

function StepEditor({ o, node, isNew, onClose, onSave, onDelete }: { o: Options; node: FlowNode; isNew: boolean; onClose: () => void; onSave: (n: FlowNode) => void; onDelete: () => void }) {
  const [n, setN] = useState<FlowNode>(node);
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days'>(node.type === 'wait' ? (node.hours >= 24 && node.hours % 24 === 0 ? 'days' : node.hours < 1 ? 'minutes' : 'hours') : 'hours');
  const pick = (list: Opt[], value: string | undefined, on: (v: string) => void, aria: string) => <select className="input" value={value ?? ''} onChange={(e) => on(e.target.value)} aria-label={aria} required><option value="">Choose…</option>{list.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>;
  const factor = unit === 'days' ? 24 : unit === 'minutes' ? 1 / 60 : 1;
  return (
    <div className="modal-bg">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); onSave(n); }}>
        <h2>{n.type === 'wait' ? 'Time delay' : n.type === 'condition' ? 'Check lead' : 'Do something'}</h2>
        {n.type === 'action' && (() => {
          const a = n.action;
          const set = (p: Partial<FlowAction>) => setN({ ...n, action: { ...a, ...p } });
          return (
            <>
              <div className="field"><label htmlFor="se-a">Action</label><select id="se-a" className="input" value={a.type} onChange={(e) => setN({ ...n, action: { type: e.target.value } })}>{o.actions.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></div>
              {a.type === 'assign' && <div className="field"><label>To</label><select className="input" value={a.userId ?? 'rules'} onChange={(e) => set({ userId: e.target.value })} aria-label="Assign to"><option value="rules">Next person in turn</option>{o.users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></div>}
              {a.type === 'change_stage' && <div className="field"><label>Stage</label>{pick(o.stages, a.stageId, (v) => set({ stageId: v }), 'Stage')}</div>}
              {a.type === 'set_status' && <div className="field"><label>Status</label>{pick(o.statuses, a.status, (v) => set({ status: v }), 'Status')}</div>}
              {a.type === 'add_label' && <div className="field"><label>Label</label>{pick(o.labels, a.labelId, (v) => set({ labelId: v }), 'Label')}</div>}
              {a.type === 'send_template' && <div className="field"><label>Template</label>{pick(o.templates, a.templateId, (v) => set({ templateId: v }), 'Template')}</div>}
              {a.type === 'enroll_sequence' && <div className="field"><label>Sequence</label>{pick(o.sequences, a.sequenceId, (v) => set({ sequenceId: v }), 'Sequence')}</div>}
              {a.type === 'call_api' && <div className="field"><label>API template</label>{pick(o.apiTemplates ?? [], a.apiTemplateId, (v) => set({ apiTemplateId: v }), 'API template')}{!(o.apiTemplates ?? []).length && <span className="small muted">Add one under Automations → API templates.</span>}</div>}
              {a.type === 'create_task' && <div className="grid cols-2"><div className="field"><label htmlFor="se-tt">Task</label><input id="se-tt" className="input" required value={a.title ?? ''} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Call {name}" /></div><div className="field"><label htmlFor="se-td">Due after (hours)</label><input id="se-td" className="input" type="number" min={0} value={a.dueHours ?? 24} onChange={(e) => set({ dueHours: Number(e.target.value) })} /></div></div>}
              {(a.type === 'add_remark' || a.type === 'notify_owner') && <div className="field"><label htmlFor="se-tx">Text</label><input id="se-tx" className="input" required value={a.text ?? ''} onChange={(e) => set({ text: e.target.value })} placeholder="Use {name} for the customer's name" /></div>}
            </>
          );
        })()}
        {n.type === 'wait' && (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input" style={{ maxWidth: 120 }} type="number" min={unit === 'minutes' ? 15 : 1} step={1} required aria-label="How long" value={Math.round((n.hours / factor) * 100) / 100} onChange={(e) => setN({ ...n, hours: Number(e.target.value) * factor })} />
            <select className="input" style={{ maxWidth: 140 }} aria-label="Unit" value={unit} onChange={(e) => { const u = e.target.value as typeof unit; const f2 = u === 'days' ? 24 : u === 'minutes' ? 1 / 60 : 1; setN({ ...n, hours: Math.max(0.25, Math.round(n.hours / factor) * f2) }); setUnit(u); }}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select>
          </div>
        )}
        {n.type === 'condition' && (
          <>
            <p className="small muted" style={{ marginTop: -6 }}>All must match for Yes.</p>
            {n.conditions.map((c: Cond, i) => {
              const set = (p: Partial<Cond>) => setN({ ...n, conditions: n.conditions.map((x, j) => (j === i ? { ...x, ...p } : x)) as typeof n.conditions });
              const list = c.field === 'stage' ? o.stages : c.field === 'status' ? o.statuses : c.field === 'source' ? o.sources : c.field === 'owner' ? o.users : null;
              return (
                <div key={i} className="flow-cond">
                  <select className="input" aria-label="Field" value={c.field} onChange={(e) => set({ field: e.target.value, value: '' })}>{o.fields.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
                  <select className="input" aria-label="Comparison" value={c.op} onChange={(e) => set({ op: e.target.value })}>{o.ops.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
                  {!NO_VALUE.includes(c.op) && (list ? pick(list, c.value, (v) => set({ value: v }), 'Value') : <input className="input" aria-label="Value" required value={c.value ?? ''} onChange={(e) => set({ value: e.target.value })} />)}
                  <button type="button" className="btn ghost sm" aria-label="Remove condition" disabled={n.conditions.length === 1} onClick={() => setN({ ...n, conditions: n.conditions.filter((_, j) => j !== i) })}><Icon name="close" className="ic" /></button>
                </div>
              );
            })}
            <button type="button" className="btn ghost sm" onClick={() => setN({ ...n, conditions: [...n.conditions, { field: 'source', op: 'eq', value: '' }] as typeof n.conditions })}>+ Condition</button>
          </>
        )}
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          {!isNew ? <button type="button" className="btn ghost" onClick={onDelete}>Delete step</button> : <span />}
          <div className="row"><button type="button" className="btn ghost" onClick={onClose}>Go back</button><button className="btn">{isNew ? 'Add' : 'Done'}</button></div>
        </div>
      </form>
    </div>
  );
}
