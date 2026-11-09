'use client';

import { Icon } from '@/components/Icon';
import { PickWorkspace } from '@/components/PickWorkspace';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { inr } from '@/lib/money';
import type { Product } from '@/components/deals/DealsPanel';

interface FieldDef { key: string; label: string; type: string; options: string[]; required: boolean }
interface StepDef {
  id?: string; name: string; instructions: string | null; assignTo: 'lead_owner' | 'user' | 'role'; assigneeUserId: string | null; ownerRoleId: string | null;
  dueDays: number | null; fields: FieldDef[]; minPaymentPct: number | null; requiresApproval: boolean; access: Record<string, 'edit' | 'view' | 'none'>;
}
interface Template { id: string; name: string; description: string | null; trigger: 'won' | 'manual'; packageIds: string[]; isArchived: boolean; steps: StepDef[]; activeRuns: number; completedRuns: number; canManage: boolean }
interface RunRow {
  id: string; leadId: string; templateId: string; templateName: string; customerName: string; customerCode: string; status: string; dealValuePaise: number; receivedPaise: number;
  balancePaise: number; currentStep: string | null; currentStepId: string | null; currentStatus: string | null; currentAssignee: string | null; currentDueAt: string | null;
  overdue: boolean; doneSteps: number; totalSteps: number; rating: number | null; startedAt: string;
}
type Tab = 'board' | 'mine' | 'templates';

/** After-sale processes: the board of running processes, my steps, and the template designer. */
export default function ProcessesPage() {
  const { me, can, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [tab, setTab] = useState<Tab>('board');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [mine, setMine] = useState<RunRow[]>([]);
  const [status, setStatus] = useState<'active' | 'completed' | 'all'>('active');
  const [templateId, setTemplateId] = useState('');
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [t, r, m] = await Promise.all([
      ws ? api<Template[]>('/api/v1/process-templates').catch(() => []) : Promise.resolve([]),
      api<RunRow[]>(`/api/v1/process-runs?status=${status}${templateId ? `&templateId=${templateId}` : ''}`).catch(() => []),
      api<RunRow[]>('/api/v1/process-runs?mine=true').catch(() => []),
    ]);
    setTemplates(t); setRuns(r); setMine(m);
    if (!templateId && t.length === 1) setTemplateId(t[0].id);
  }, [ws, status, templateId]);
  useEffect(() => { load(); }, [load, version]);

  async function exportCsv() {
    try {
      const blob = await api<Blob>(`/api/v1/process-runs/report.csv?status=${status}${templateId ? `&templateId=${templateId}` : ''}`);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: 'process-report.csv' }).click();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Export failed' }); }
  }

  const tpl = templates.find((t) => t.id === templateId);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Processes</h1>
          <p className="muted small" style={{ margin: 0 }}>What happens after a sale: each step has an owner, a form and rules. Completed steps lock; payments and sign-offs gate the next step.</p>
        </div>
        {can('crm.lead.export') && <button className="btn outline" onClick={exportCsv}><Icon name="download" className="ic" />Process report</button>}
      </div>
      <div className="dash-tabs" role="tablist">
        {([['board', 'Board'], ['mine', `My steps${mine.length ? ` (${mine.length})` : ''}`], ['templates', `Templates (${templates.length})`]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`dash-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      {tab === 'board' && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <select className="input" style={{ maxWidth: 260 }} value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Process">
              <option value="">All processes</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select className="input" style={{ maxWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
              <option value="active">Running</option><option value="completed">Completed</option><option value="all">All</option>
            </select>
            <span className="small muted">{runs.length} process(es) · balance due {inr(runs.reduce((s, r) => s + r.balancePaise, 0))}</span>
          </div>
          {tpl && status === 'active' ? (
            <div className="board-cols">
              {tpl.steps.map((s) => {
                const here = runs.filter((r) => r.currentStepId === s.id);
                return (
                  <div key={s.id} className="board-col">
                    <h3><span>{s.name}</span><span className="tab-count">{here.length}</span></h3>
                    {here.map((r) => <RunTile key={r.id} r={r} />)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="card">
              {!runs.length ? <p className="small muted" style={{ margin: 0 }}>{templates.length ? 'No process here yet. A process starts when a lead is won.' : 'Design a process template first (Templates tab).'}</p> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Customer</th><th>Process</th><th>Current step</th><th>Progress</th><th style={{ textAlign: 'right' }}>Received / value</th><th>Rating</th></tr></thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.id}>
                          <td><Link href={`/app/leads/${r.leadId}?tab=process`}><b>{r.customerName}</b></Link><div className="small muted">{r.customerCode}</div></td>
                          <td className="small">{r.templateName}</td>
                          <td className="small">{r.currentStep ? <>{r.currentStep}{r.currentStatus === 'awaiting_approval' && <span className="badge warn" style={{ marginLeft: 4 }}>sign-off</span>}<div className="muted">{r.currentAssignee ?? ''}{r.currentDueAt ? ` · due ${new Date(r.currentDueAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}</div></> : <span className={`badge ${r.status === 'completed' ? 'ok' : 'bad'}`}>{r.status}</span>}</td>
                          <td className="small">{r.doneSteps}/{r.totalSteps}</td>
                          <td style={{ textAlign: 'right' }} className="small">{inr(r.receivedPaise)} / {inr(r.dealValuePaise)}</td>
                          <td className="stars">{r.rating ? '★'.repeat(r.rating) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'mine' && (
        <div className="card">
          {!mine.length ? <p className="small muted" style={{ margin: 0 }}>No step is waiting on you.</p> : mine.map((r) => <RunTile key={r.id} r={r} wide />)}
        </div>
      )}

      {tab === 'templates' && (ws
        ? <Templates ws={ws} templates={templates} reload={load} setMsg={setMsg} canManage={can('process.manage')} />
        : <PickWorkspace text="Process templates belong to a business line." />)}
    </>
  );
}

function RunTile({ r, wide }: { r: RunRow; wide?: boolean }) {
  return (
    <Link href={`/app/leads/${r.leadId}?tab=process`} className={`run-tile ${r.overdue ? 'overdue' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>{r.customerName}</b><span className="small muted">{r.doneSteps}/{r.totalSteps}</span></div>
      {wide && <div className="small">{r.templateName} · <b>{r.currentStep}</b></div>}
      <div className="small muted">{r.currentAssignee ?? 'Unassigned'}{r.currentDueAt ? ` · due ${new Date(r.currentDueAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}</div>
      <div className="small">{r.currentStatus === 'awaiting_approval' && <span className="badge warn">Waiting for sign-off</span>} {r.balancePaise > 0 && <span className="muted">Balance {inr(r.balancePaise)}</span>}</div>
    </Link>
  );
}

// ── Template designer ──

const newStep = (): StepDef => ({ name: '', instructions: null, assignTo: 'lead_owner', assigneeUserId: null, ownerRoleId: null, dueDays: null, fields: [], minPaymentPct: null, requiresApproval: false, access: {} });
const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field';
const NEXT_ACCESS = { edit: 'view', view: 'none', none: 'edit' } as const;

function Templates({ ws, templates, reload, setMsg, canManage }: { ws: string; templates: Template[]; reload: () => void; setMsg: (m: { type: 'error' | 'notice'; text: string } | null) => void; canManage: boolean }) {
  const [edit, setEdit] = useState<Omit<Template, 'activeRuns' | 'completedRuns' | 'canManage' | 'isArchived' | 'id'> & { id?: string } | null>(null);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  useEffect(() => {
    if (!canManage) return;
    api<{ id: string; name: string }[]>('/api/v1/roles').then(setRoles).catch(() => setRoles([]));
    api<{ id: string; name: string }[]>(`/api/v1/workspaces/${ws}/assignees`).then(setPeople).catch(() => setPeople([]));
    api<Product[]>('/api/v1/products').then(setProducts).catch(() => setProducts([]));
  }, [ws, canManage]);

  const setStep = (i: number, patch: Partial<StepDef>) => edit && setEdit({ ...edit, steps: edit.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const moveStep = (i: number, d: number) => { if (!edit) return; const n = [...edit.steps]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setEdit({ ...edit, steps: n }); };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setMsg(null);
    try {
      const body = { name: edit.name, description: edit.description, trigger: edit.trigger, packageIds: edit.packageIds, steps: edit.steps };
      await api(edit.id ? `/api/v1/process-templates/${edit.id}` : '/api/v1/process-templates', { method: edit.id ? 'PUT' : 'POST', body });
      setMsg({ type: 'notice', text: 'Process saved. Running processes keep their steps; new sales use the new version.' });
      setEdit(null); reload();
    } catch (x) { setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }); }
  }

  if (edit) return (
    <form className="card" onSubmit={save} style={{ maxWidth: 1000 }}>
      <h2>{edit.id ? 'Edit process' : 'New process'}</h2>
      <div className="grid cols-2">
        <div className="field"><label>Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required minLength={2} placeholder="e.g. Course onboarding / Logo delivery" /></div>
        <div className="field"><label>Starts</label>
          <select className="input" value={edit.trigger} onChange={(e) => setEdit({ ...edit, trigger: e.target.value as 'won' | 'manual' })}>
            <option value="won">Automatically when a lead is won</option><option value="manual">Only when someone starts it on a lead</option>
          </select>
        </div>
      </div>
      <div className="field"><label>Description</label><input className="input" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value || null })} /></div>
      {products.length > 0 && (
        <div className="field"><label>Only for sales of (none selected = every sale)</label>
          <div className="chips">{products.map((p) => <button type="button" key={p.id} className={`chip ${edit.packageIds.includes(p.id) ? 'on' : ''}`} onClick={() => setEdit({ ...edit, packageIds: edit.packageIds.includes(p.id) ? edit.packageIds.filter((x) => x !== p.id) : [...edit.packageIds, p.id] })}>{p.name}</button>)}</div>
        </div>
      )}
      <h3 style={{ fontSize: 15, margin: '14px 0 8px' }}>Steps</h3>
      {edit.steps.map((s, i) => (
        <div key={s.id ?? `n${i}`} className="tpl-step">
          <div className="tpl-step-head">
            <span className="step-num">{i + 1}</span>
            <input className="input" value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} required minLength={2} placeholder="Step name, e.g. Kick-off call" aria-label="Step name" />
            <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => moveStep(i, -1)} aria-label="Move up"><Icon name="up" className="ic" /></button>
            <button type="button" className="btn sm ghost" disabled={i === edit.steps.length - 1} onClick={() => moveStep(i, 1)} aria-label="Move down"><Icon name="down" className="ic" /></button>
            <button type="button" className="btn sm ghost" disabled={edit.steps.length === 1} onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_, j) => j !== i) })} aria-label="Remove step"><Icon name="close" className="ic" /></button>
          </div>
          <div className="grid cols-4" style={{ marginTop: 8 }}>
            <div className="field"><label>Done by</label>
              <select className="input" value={s.assignTo} onChange={(e) => setStep(i, { assignTo: e.target.value as StepDef['assignTo'] })}>
                <option value="lead_owner">Lead owner (RM)</option><option value="role">Someone with a role</option><option value="user">A fixed person</option>
              </select>
            </div>
            {s.assignTo === 'role' && <div className="field"><label>Responsible role</label><select className="input" value={s.ownerRoleId ?? ''} onChange={(e) => setStep(i, { ownerRoleId: e.target.value || null })} required><option value="">Choose…</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>}
            {s.assignTo === 'user' && <div className="field"><label>Person</label><select className="input" value={s.assigneeUserId ?? ''} onChange={(e) => setStep(i, { assigneeUserId: e.target.value || null })} required><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
            <div className="field"><label>Due after (days)</label><input className="input" type="number" min={0} max={365} value={s.dueDays ?? ''} onChange={(e) => setStep(i, { dueDays: e.target.value === '' ? null : Number(e.target.value) })} placeholder="No due date" /></div>
            <div className="field"><label>Payment needed (%)</label><input className="input" type="number" min={1} max={100} value={s.minPaymentPct ?? ''} onChange={(e) => setStep(i, { minPaymentPct: e.target.value === '' ? null : Number(e.target.value) })} placeholder="None" title="The step can be completed only after this share of the deal value is received" /></div>
          </div>
          <div className="field"><label>Instructions</label><textarea className="input" style={{ height: 50, paddingTop: 6 }} value={s.instructions ?? ''} onChange={(e) => setStep(i, { instructions: e.target.value || null })} placeholder="What to do in this step (shown to the person doing it)" /></div>
          <label className="row small"><input type="checkbox" checked={s.requiresApproval} onChange={(e) => setStep(i, { requiresApproval: e.target.checked })} /> Needs sign-off by an approver before it counts as done</label>
          <details style={{ marginTop: 8 }} open={s.fields.length > 0}>
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>Form fields ({s.fields.length})</summary>
            {s.fields.map((f, k) => (
              <div key={k} className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'nowrap' }}>
                <input className="input" value={f.label} onChange={(e) => setStep(i, { fields: s.fields.map((x, j) => (j === k ? { ...x, label: e.target.value, key: x.key && x.key !== keyOf(x.label) ? x.key : keyOf(e.target.value) } : x)) })} placeholder="Label" aria-label="Field label" required />
                <select className="input" style={{ maxWidth: 130 }} value={f.type} onChange={(e) => setStep(i, { fields: s.fields.map((x, j) => (j === k ? { ...x, type: e.target.value } : x)) })} aria-label="Field type">
                  {['text', 'textarea', 'number', 'date', 'dropdown', 'checkbox', 'url'].map((t) => <option key={t}>{t}</option>)}
                </select>
                {f.type === 'dropdown' && <input className="input" value={f.options.join(', ')} onChange={(e) => setStep(i, { fields: s.fields.map((x, j) => (j === k ? { ...x, options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) } : x)) })} placeholder="Options, comma separated" aria-label="Options" />}
                <label className="row small" style={{ whiteSpace: 'nowrap' }}><input type="checkbox" checked={f.required} onChange={(e) => setStep(i, { fields: s.fields.map((x, j) => (j === k ? { ...x, required: e.target.checked } : x)) })} /> Required</label>
                <button type="button" className="btn sm ghost" onClick={() => setStep(i, { fields: s.fields.filter((_, j) => j !== k) })} aria-label="Remove field"><Icon name="close" className="ic" /></button>
              </div>
            ))}
            <button type="button" className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setStep(i, { fields: [...s.fields, { key: '', label: '', type: 'text', options: [], required: false }] })}>+ Field</button>
          </details>
          {roles.length > 0 && (
            <details style={{ marginTop: 6 }} open={Object.keys(s.access).length > 0}>
              <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>Who can edit / view this step</summary>
              <p className="small muted" style={{ margin: '4px 0' }}>Click a role to switch Edit → View → Hidden. Roles not changed can edit (if they may work on processes).</p>
              <div className="access-grid">
                {roles.map((r) => {
                  const v = s.access[r.id] ?? 'edit';
                  return (
                    <button type="button" key={r.id} className={`chip ${v !== 'edit' ? 'on' : ''}`} onClick={() => {
                      const nv = NEXT_ACCESS[v];
                      const acc = { ...s.access };
                      if (nv === 'edit') delete acc[r.id]; else acc[r.id] = nv;
                      setStep(i, { access: acc });
                    }}>{r.name}: {v === 'edit' ? 'Edit' : v === 'view' ? 'View only' : 'Hidden'}</button>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      ))}
      <button type="button" className="btn sm outline" onClick={() => setEdit({ ...edit, steps: [...edit.steps, newStep()] })}>+ Add step</button>
      <div className="row end" style={{ marginTop: 14 }}>
        <button type="button" className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
        <button className="btn">Save process</button>
      </div>
    </form>
  );

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Process templates</h2>
        {canManage && <button className="btn sm" onClick={() => setEdit({ name: '', description: null, trigger: 'won', packageIds: [], steps: [newStep()] })}>+ New process</button>}
      </div>
      {!templates.length && <p className="small muted">No process yet. Design the steps that follow a sale — who does what, which form they fill, and when payment or sign-off is needed.</p>}
      {templates.map((t) => (
        <div key={t.id} className="run-card" style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b>{t.name}</b> <span className="badge grey">{t.trigger === 'won' ? 'Starts when won' : 'Started by hand'}</span>
              <div className="small muted">{t.description ?? ''} {t.activeRuns} running · {t.completedRuns} completed</div>
            </div>
            {t.canManage && <div className="row" style={{ gap: 6 }}>
              <button className="btn sm ghost" onClick={() => setEdit({ id: t.id, name: t.name, description: t.description, trigger: t.trigger, packageIds: t.packageIds, steps: t.steps.map((s) => ({ ...s, fields: (s.fields ?? []).map((f) => ({ ...f, options: f.options ?? [], required: !!f.required })), access: s.access ?? {} })) })}>Edit</button>
              <button className="btn sm ghost" onClick={async () => { await api(`/api/v1/process-templates/${t.id}/archive`, { method: 'POST' }).catch(() => undefined); reload(); }}>Archive</button>
            </div>}
          </div>
          <ol className="small" style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {t.steps.map((s) => (
              <li key={s.id}>{s.name} <span className="muted">· {s.assignTo === 'lead_owner' ? 'lead owner' : s.assignTo === 'role' ? 'by role' : 'fixed person'}{s.fields.length ? ` · ${s.fields.length} field(s)` : ''}{s.minPaymentPct ? ` · ${s.minPaymentPct}% paid` : ''}{s.requiresApproval ? ' · sign-off' : ''}</span></li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
