'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { FieldInput } from '@/components/FieldInput';
import { useShell } from '@/components/AppShell';
import { inr, QUOTE_STATUS, toPaise } from '@/lib/money';
import { ReasonDialog } from './ReasonDialog';
import { LeadWhatsApp } from '@/components/whatsapp/Chat';
import { LeadOutreach } from '@/components/messaging/LeadOutreach';

interface QuoteItem { id?: string; packageId: string | null; name: string; qty: number; listPricePaise: number; pricePaise: number; gstRate: number }
export interface Quote {
  id: string; number: string; status: string; subtotalPaise: number; discountPaise: number; taxPaise: number; totalPaise: number; needsApproval: boolean;
  validUntil: string | null; notes: string | null; terms: string | null; priceListId: string | null; createdAt: string; sentAt: string | null; items: QuoteItem[];
  approval: { status: string; decisionNote: string | null } | null;
}
export interface Product { id: string; name: string; code: string | null; category: string | null; unit: string; mrpPaise: number; gstRate: number; isArchived: boolean; description: string | null }
export interface PriceList { id: string; name: string; isDefault: boolean; validFrom: string | null; validTo: string | null; items: { packageId: string; pricePaise: number; minPricePaise: number | null }[] }
interface StepField { key: string; label: string; type: string; options?: string[]; required?: boolean }
interface StepRow {
  id: string; position: number; name: string; instructions: string | null; status: string; locked: boolean; assigneeName: string | null; dueAt: string | null;
  completedAt: string | null; completedByName: string | null; sentBackCount: number; minPaymentPct: number | null; requiresApproval: boolean;
  access: 'edit' | 'view' | 'none'; fields: StepField[]; data: Record<string, unknown>; approval: { status: string; decisionNote: string | null } | null;
}
interface Run {
  id: string; status: string; templateId: string; templateName: string; dealValuePaise: number; receivedPaise: number; balancePaise: number; paidPct: number; startedAt: string;
  completedAt: string | null; cancelledReason: string | null; rating: number | null; ratingNote: string | null; steps: StepRow[];
}
interface Payment { id: string; amountPaise: number; kind: string; mode: string; reference: string | null; receivedAt: string; note: string | null; isVoided: boolean; voidReason: string | null; runId: string | null; source: string }
interface Processes { canStart: boolean; canUnlock: boolean; canPay: boolean; startable: { id: string; name: string; trigger: string }[]; runs: Run[]; payments: Payment[] }
interface Member { id: string; userId: string; name: string; roleLabel: string }

type Tab = 'process' | 'quotes' | 'payments' | 'team' | 'whatsapp' | 'outreach';
const STEP_TONE: Record<string, string> = { done: 'ok', active: '', awaiting_approval: 'warn', pending: 'grey' };
const STEP_LABEL: Record<string, string> = { done: 'Done', active: 'In progress', awaiting_approval: 'Waiting for sign-off', pending: 'Waiting' };
const toField = (f: StepField) => ({ id: f.key, key: f.key, label: f.label, type: f.type, options: f.options ?? [], required: !!f.required, isArchived: false });
const show = (f: StepField, v: unknown) => (v === undefined || v === null || v === '' ? '—' : f.type === 'checkbox' ? (v ? 'Yes' : 'No') : f.type === 'url' ? <a href={String(v)} target="_blank" rel="noreferrer">{String(v)}</a> : String(v));

/** After-sale work on a lead: its process steps, quotes, payments and lead team. */
export function DealsPanel({ lead, people, initialTab, onChange }: {
  lead: { id: string; name: string; workspace: { id: string; name: string }; canUpdate: boolean; ownerId?: string | null };
  people: { id: string; name: string }[]; initialTab?: string | null; onChange: () => void;
}) {
  const { can } = useShell();
  const [tab, setTab] = useState<Tab>((['process', 'quotes', 'payments', 'team', 'whatsapp', 'outreach'].includes(initialTab ?? '') ? initialTab : 'process') as Tab);
  const [proc, setProc] = useState<Processes | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [team, setTeam] = useState<Member[]>([]);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const ws = lead.workspace.id;

  const load = useCallback(async () => {
    const [p, q, t] = await Promise.all([
      api<Processes>(`/api/v1/leads/${lead.id}/processes`, { workspace: ws }).catch(() => null),
      api<Quote[]>(`/api/v1/leads/${lead.id}/quotes`, { workspace: ws }).catch(() => []),
      api<Member[]>(`/api/v1/leads/${lead.id}/team`, { workspace: ws }).catch(() => []),
    ]);
    setProc(p); setQuotes(q); setTeam(t);
  }, [lead.id, ws]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { const r = await fn(); setMsg({ type: 'notice', text: typeof r === 'string' ? r : text }); await load(); onChange(); return true; } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
      return false;
    }
  };
  const call = (path: string, method: string, body?: unknown) => api(path, { method, body, workspace: ws });

  const active = proc?.runs.find((r) => r.status === 'active');
  const counts: Record<Tab, string> = {
    process: active ? `${active.steps.filter((s) => s.status === 'done').length}/${active.steps.length}` : proc?.runs.length ? '✓' : '',
    quotes: quotes.length ? String(quotes.length) : '',
    payments: proc?.payments.filter((p) => !p.isVoided).length ? String(proc.payments.filter((p) => !p.isVoided).length) : '',
    team: team.length ? String(team.length) : '',
    whatsapp: '',
    outreach: '',
  };

  return (
    <div className="card" style={{ marginBottom: 14 }} id="deals">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="dash-tabs" role="tablist" aria-label="Sale and delivery" style={{ marginBottom: 0 }}>
          {([['process', '⚙ Process'], ['quotes', '🧾 Quotes'], ['payments', '₹ Payments'], ['team', '👥 Lead team'], ...(can('crm.whatsapp.chat') ? [['whatsapp', '💬 WhatsApp']] : []), ...(can('crm.message.send') ? [['outreach', '✉ SMS & Email']] : [])] as [Tab, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`dash-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
              {l}{counts[k] && <span className="tab-count" style={{ marginLeft: 6 }}>{counts[k]}</span>}
            </button>
          ))}
        </div>
        {active && <PaidBar run={active} />}
      </div>
      {msg && <div className={msg.type} style={{ marginTop: 10 }}>{msg.text}</div>}
      <div style={{ marginTop: 12 }}>
        {tab === 'process' && proc && <ProcessTab proc={proc} lead={lead} act={act} call={call} />}
        {tab === 'quotes' && <QuotesTab quotes={quotes} lead={lead} canQuote={can('crm.quote.manage') && lead.canUpdate} act={act} call={call} />}
        {tab === 'payments' && proc && <PaymentsTab proc={proc} lead={lead} act={act} call={call} />}
        {tab === 'team' && <TeamTab team={team} people={people} lead={lead} act={act} call={call} />}
        {tab === 'whatsapp' && <LeadWhatsApp leadId={lead.id} workspace={ws} />}
        {tab === 'outreach' && <LeadOutreach leadId={lead.id} workspace={ws} canUpdate={lead.canUpdate} />}
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, text: string) => Promise<boolean>;
type Call = (path: string, method: string, body?: unknown) => Promise<unknown>;

function PaidBar({ run }: { run: Run }) {
  if (!run.dealValuePaise) return <span className="small muted">Received {inr(run.receivedPaise)}</span>;
  return (
    <div className="paid-bar" title={`${run.paidPct}% received`}>
      <div className="small"><b>{inr(run.receivedPaise)}</b> of {inr(run.dealValuePaise)} · balance <b style={{ color: run.balancePaise ? 'var(--warn)' : 'var(--ok)' }}>{inr(run.balancePaise)}</b></div>
      <div className="bar"><span style={{ width: `${run.paidPct}%` }} /></div>
    </div>
  );
}

// ── Process ──

function ProcessTab({ proc, lead, act, call }: { proc: Processes; lead: { id: string }; act: Act; call: Call }) {
  const [templateId, setTemplateId] = useState('');
  return (
    <>
      {!proc.runs.length && (
        <p className="small muted" style={{ marginTop: 0 }}>
          {proc.startable.some((t) => t.trigger === 'won') ? 'The after-sale process starts by itself when this lead is won (or accept a quote).' : 'No process has started for this lead yet.'}
        </p>
      )}
      {proc.runs.map((r) => <RunCard key={r.id} run={r} proc={proc} act={act} call={call} />)}
      {proc.canStart && proc.startable.length > 0 && (
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <select className="input" style={{ maxWidth: 280 }} value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Process to start">
            <option value="">Start a process by hand…</option>
            {proc.startable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="btn sm outline" disabled={!templateId || proc.runs.some((r) => r.status === 'active' && r.templateId === templateId)}
            onClick={() => act(() => call(`/api/v1/leads/${lead.id}/processes`, 'POST', { templateId }), 'Process started.').then((ok) => ok && setTemplateId(''))}>Start</button>
        </div>
      )}
    </>
  );
}

function RunCard({ run, proc, act, call }: { run: Run; proc: Processes; act: Act; call: Call }) {
  const [open, setOpen] = useState<string | null>(run.steps.find((s) => s.status === 'active' || s.status === 'awaiting_approval')?.id ?? null);
  const [unlocking, setUnlocking] = useState<StepRow | null>(null);
  const [sendingBack, setSendingBack] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const { can } = useShell();
  const current = run.steps.find((s) => s.status === 'active' || s.status === 'awaiting_approval');
  return (
    <div className="run-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <b>{run.templateName}</b>{' '}
          <span className={`badge ${run.status === 'completed' ? 'ok' : run.status === 'cancelled' ? 'bad' : ''}`}>{run.status === 'active' ? 'Running' : run.status === 'completed' ? 'Completed' : 'Cancelled'}</span>
          <div className="small muted">Started {new Date(run.startedAt).toLocaleDateString('en-IN')}{run.completedAt ? ` · ${run.status === 'completed' ? 'completed' : 'closed'} ${new Date(run.completedAt).toLocaleDateString('en-IN')}` : ''}{run.cancelledReason ? ` · ${run.cancelledReason}` : ''}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {run.status === 'active' && current && current.access === 'edit' && current.position > 0 && <button className="btn sm ghost" onClick={() => setSendingBack(true)}>↩ Send back</button>}
          {run.status === 'active' && can('process.approve') && <button className="btn sm ghost" onClick={() => setCancelling(true)}>Cancel process</button>}
        </div>
      </div>
      <ol className="stepper">
        {run.steps.map((s) => (
          <li key={s.id} className={`step ${s.status}`}>
            <button className="step-head" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
              <span className="step-num">{s.status === 'done' ? '✓' : s.position + 1}</span>
              <span className="step-name">{s.name}</span>
              <span className={`badge ${STEP_TONE[s.status] ?? ''}`}>{STEP_LABEL[s.status] ?? s.status}</span>
              {s.locked && <span title="Completed and locked">🔒</span>}
              {s.sentBackCount > 0 && <span className="badge warn" title="Sent back to this step">↩ {s.sentBackCount}</span>}
              <span className="small muted step-meta">{s.assigneeName ?? ''}{s.dueAt && s.status !== 'done' ? ` · due ${new Date(s.dueAt).toLocaleDateString('en-IN')}` : ''}{s.completedAt ? ` · ${s.completedByName ?? ''} ${new Date(s.completedAt).toLocaleDateString('en-IN')}` : ''}</span>
            </button>
            {open === s.id && <StepBody step={s} run={run} canUnlock={proc.canUnlock} onUnlock={() => setUnlocking(s)} act={act} call={call} />}
          </li>
        ))}
      </ol>
      {run.status === 'completed' && <Rating run={run} act={act} call={call} />}
      {unlocking && <ReasonDialog title={`Unlock “${unlocking.name}”`} hint="Say why the completed step must change. This is recorded in the audit log." confirm="Unlock"
        onClose={() => setUnlocking(null)} onSubmit={(reason) => act(() => call(`/api/v1/process-steps/${unlocking.id}/unlock`, 'POST', { reason }), 'Step unlocked for changes.').then((ok) => ok && setUnlocking(null))} />}
      {sendingBack && current && <SendBackDialog run={run} current={current} onClose={() => setSendingBack(false)}
        onSubmit={(toStepRunId, reason) => act(() => call(`/api/v1/process-runs/${run.id}/send-back`, 'POST', { toStepRunId, reason }), 'Sent back.').then((ok) => ok && setSendingBack(false))} />}
      {cancelling && <ReasonDialog title="Cancel this process" hint="The steps and payments stay on record." confirm="Cancel process"
        onClose={() => setCancelling(false)} onSubmit={(reason) => act(() => call(`/api/v1/process-runs/${run.id}/cancel`, 'POST', { reason }), 'Process cancelled.').then((ok) => ok && setCancelling(false))} />}
    </div>
  );
}

function StepBody({ step, run, canUnlock, onUnlock, act, call }: { step: StepRow; run: Run; canUnlock: boolean; onUnlock: () => void; act: Act; call: Call }) {
  const [values, setValues] = useState<Record<string, unknown>>(step.data ?? {});
  useEffect(() => { setValues(step.data ?? {}); }, [step]);
  const editable = run.status === 'active' && step.status === 'active' && !step.locked && step.access === 'edit';
  const paidShort = step.minPaymentPct && run.paidPct < step.minPaymentPct;
  if (step.access === 'none') return <div className="step-body small muted">Your role cannot see this step’s details.</div>;
  return (
    <div className="step-body">
      {step.instructions && <p className="small" style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{step.instructions}</p>}
      <div className="row small" style={{ gap: 8, marginBottom: 8 }}>
        {step.minPaymentPct && <span className={`badge ${paidShort ? 'warn' : 'ok'}`}>Needs {step.minPaymentPct}% paid · now {run.paidPct}%</span>}
        {step.requiresApproval && <span className="badge grey">Needs sign-off</span>}
        {step.access === 'view' && step.status !== 'done' && <span className="badge grey">View only for your role</span>}
        {step.approval?.status === 'rejected' && <span className="badge bad">Sign-off rejected: {step.approval.decisionNote}</span>}
      </div>
      {step.fields.length > 0 && (editable ? (
        <div className="grid cols-2">
          {step.fields.map((f) => (
            <div key={f.key} className="field">
              <label htmlFor={`f_${f.key}`}>{f.label}{f.required && ' *'}</label>
              <FieldInput field={toField(f.type === 'url' ? { ...f, type: 'text' } : f)} value={values[f.key]} onChange={(v) => setValues({ ...values, [f.key]: v })} />
            </div>
          ))}
        </div>
      ) : (
        <dl className="step-data">
          {step.fields.map((f) => [<dt key={`${f.key}-l`} className="muted small">{f.label}</dt>, <dd key={`${f.key}-v`}>{show(f, step.data?.[f.key])}</dd>])}
        </dl>
      ))}
      <div className="row end" style={{ gap: 6 }}>
        {step.locked && canUnlock && run.status !== 'cancelled' && <button className="btn sm ghost" onClick={onUnlock}>🔓 Unlock</button>}
        {editable && step.fields.length > 0 && <button className="btn sm ghost" onClick={() => act(() => call(`/api/v1/process-steps/${step.id}`, 'PUT', { data: values }), 'Saved.')}>Save</button>}
        {editable && <button className="btn sm" onClick={() => act(() => call(`/api/v1/process-steps/${step.id}/complete`, 'POST', { data: values }), step.requiresApproval ? 'Sent for sign-off.' : 'Step completed.')}>{step.requiresApproval ? 'Submit for sign-off' : 'Mark step done'}</button>}
      </div>
    </div>
  );
}

function SendBackDialog({ run, current, onClose, onSubmit }: { run: Run; current: StepRow; onClose: () => void; onSubmit: (to: string, reason: string) => void }) {
  const earlier = run.steps.filter((s) => s.position < current.position);
  const [to, setTo] = useState(earlier[earlier.length - 1]?.id ?? '');
  const [reason, setReason] = useState('');
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(to, reason); }}>
        <h2>Send back from “{current.name}”</h2>
        <p className="small muted" style={{ marginTop: -6 }}>The chosen step opens again for its owner; steps after it wait again. Their data is kept.</p>
        <div className="field"><label>Back to</label>
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>{earlier.map((s) => <option key={s.id} value={s.id}>{s.position + 1}. {s.name}</option>)}</select>
        </div>
        <div className="field"><label>What needs fixing?</label><textarea className="input" style={{ height: 70, paddingTop: 8 }} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} /></div>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={reason.trim().length < 3}>Send back</button></div>
      </form>
    </div>
  );
}

function Rating({ run, act, call }: { run: Run; act: Act; call: Call }) {
  const [stars, setStars] = useState(run.rating ?? 0);
  const [note, setNote] = useState(run.ratingNote ?? '');
  const [editing, setEditing] = useState(!run.rating);
  if (!editing) return <div className="small" style={{ marginTop: 8 }}>Customer rating: <span className="stars">{'★'.repeat(run.rating ?? 0)}{'☆'.repeat(5 - (run.rating ?? 0))}</span>{run.ratingNote ? ` — ${run.ratingNote}` : ''} <button className="link-btn small" onClick={() => setEditing(true)}>change</button></div>;
  return (
    <div className="rating-box">
      <b className="small">How happy is the customer?</b>
      <div className="stars big" role="radiogroup" aria-label="Customer rating">
        {[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={stars === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={n <= stars ? 'on' : ''} onClick={() => setStars(n)}>★</button>)}
      </div>
      <input className="input" placeholder="What did the customer say? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row end" style={{ marginTop: 6 }}>
        <button className="btn sm" disabled={!stars} onClick={() => act(() => call(`/api/v1/process-runs/${run.id}/rating`, 'POST', { rating: stars, note: note || null }), 'Rating saved.').then((ok) => ok && setEditing(false))}>Save rating</button>
      </div>
    </div>
  );
}

// ── Quotes ──

function QuotesTab({ quotes, lead, canQuote, act, call }: { quotes: Quote[]; lead: { id: string; name: string; workspace: { id: string } }; canQuote: boolean; act: Act; call: Call }) {
  const [editing, setEditing] = useState<Quote | 'new' | null>(null);
  const [declining, setDeclining] = useState<Quote | null>(null);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="small muted">{quotes.length ? 'Quotes made for this lead. A discount beyond the business line’s limit goes to a manager first.' : 'No quote yet.'}</span>
        {canQuote && <button className="btn sm" onClick={() => setEditing('new')}>+ New quote</button>}
      </div>
      {quotes.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Quote</th><th>Items</th><th style={{ textAlign: 'right' }}>Total</th><th>Status</th><th /></tr></thead>
            <tbody>
              {quotes.map((q) => {
                const st = QUOTE_STATUS[q.status] ?? { label: q.status, tone: 'grey' };
                return (
                  <tr key={q.id}>
                    <td><b>{q.number}</b><div className="small muted">{new Date(q.createdAt).toLocaleDateString('en-IN')}{q.validUntil ? ` · valid till ${new Date(q.validUntil).toLocaleDateString('en-IN')}` : ''}</div></td>
                    <td className="small">{q.items.map((i) => `${i.name}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ')}</td>
                    <td style={{ textAlign: 'right' }}><b>{inr(q.totalPaise)}</b>{q.discountPaise > 0 && <div className="small muted">−{inr(q.discountPaise)} discount</div>}</td>
                    <td><span className={`badge ${st.tone}`}>{st.label}</span>{q.approval?.status === 'rejected' && q.status === 'draft' && <div className="small" style={{ color: 'var(--bad)' }}>Discount rejected: {q.approval.decisionNote}</div>}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <Link className="btn sm ghost" href={`/print/quote/${q.id}`} target="_blank">Print / PDF</Link>
                      {canQuote && ['draft', 'approved'].includes(q.status) && <button className="btn sm ghost" onClick={() => setEditing(q)}>Edit</button>}
                      {canQuote && ['draft', 'approved'].includes(q.status) && (
                        <button className="btn sm outline" onClick={() => act(async () => {
                          const r = await call(`/api/v1/quotes/${q.id}/send`, 'POST', {}) as { status: string };
                          if (r.status === 'pending_approval') return 'The discount is above the limit — sent to a manager for approval.';
                        }, 'Quote marked as sent.')}>{q.needsApproval && q.status === 'draft' ? 'Ask approval' : 'Mark sent'}</button>
                      )}
                      {canQuote && ['draft', 'approved'].includes(q.status) && q.status === 'approved' && (
                        <button className="btn sm ghost" title="Send by email to the customer" onClick={() => act(() => call(`/api/v1/quotes/${q.id}/send`, 'POST', { email: true }), 'Quote emailed to the customer.')}>✉ Email</button>
                      )}
                      {canQuote && q.status === 'sent' && <button className="btn sm" onClick={() => act(() => call(`/api/v1/quotes/${q.id}/accept`, 'POST', { markWon: true }), 'Accepted — the lead is won and its process has started.')}>Accepted ✓</button>}
                      {canQuote && q.status === 'sent' && <button className="btn sm ghost" onClick={() => setDeclining(q)}>Declined</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <QuoteDialog lead={lead} quote={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={(text) => { setEditing(null); act(async () => undefined, text); }} />}
      {declining && <ReasonDialog title={`Customer declined ${declining.number}`} hint="Why did they say no? This helps with lost-deal reports." confirm="Save"
        onClose={() => setDeclining(null)} onSubmit={(reason) => act(() => call(`/api/v1/quotes/${declining.id}/reject`, 'POST', { reason }), 'Quote marked as declined.').then((ok) => ok && setDeclining(null))} />}
    </>
  );
}

export function QuoteDialog({ lead, quote, onClose, onSaved }: { lead: { id: string; name: string; workspace: { id: string } }; quote: Quote | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const ws = lead.workspace.id;
  const [products, setProducts] = useState<Product[]>([]);
  const [lists, setLists] = useState<PriceList[]>([]);
  const [settings, setSettings] = useState<{ quoteMaxDiscountPct: number; quoteTerms: string | null } | null>(null);
  const [priceListId, setPriceListId] = useState<string>(quote?.priceListId ?? '');
  const [lines, setLines] = useState<{ packageId: string; name: string; qty: number; price: string; gstRate: number }[]>(
    quote?.items.map((i) => ({ packageId: i.packageId ?? '', name: i.name, qty: i.qty, price: String(i.pricePaise / 100), gstRate: i.gstRate })) ?? [],
  );
  const [validUntil, setValidUntil] = useState(quote?.validUntil?.slice(0, 10) ?? new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10));
  const [notes, setNotes] = useState(quote?.notes ?? '');
  const [terms, setTerms] = useState(quote?.terms ?? '');
  const [err, setErr] = useState('');
  useEffect(() => {
    api<Product[]>('/api/v1/products', { workspace: ws }).then(setProducts).catch(() => setProducts([]));
    api<PriceList[]>('/api/v1/price-lists', { workspace: ws }).then((l) => { setLists(l); if (!quote) setPriceListId(l.find((x) => x.isDefault)?.id ?? ''); }).catch(() => setLists([]));
    api<{ quoteMaxDiscountPct: number; quoteTerms: string | null }>(`/api/v1/workspaces/${ws}/quote-settings`, { workspace: ws }).then((s) => { setSettings(s); if (!quote && s.quoteTerms) setTerms(s.quoteTerms); }).catch(() => {});
  }, [ws, quote]);
  const pl = lists.find((l) => l.id === priceListId);
  const listPrice = (pid: string) => { const p = products.find((x) => x.id === pid); return pl?.items.find((i) => i.packageId === pid)?.pricePaise ?? p?.mrpPaise ?? 0; };
  const minPrice = (pid: string) => pl?.items.find((i) => i.packageId === pid)?.minPricePaise ?? null;
  const addProduct = (pid: string) => { const p = products.find((x) => x.id === pid); if (p) setLines([...lines, { packageId: p.id, name: p.name, qty: 1, price: String(listPrice(p.id) / 100), gstRate: p.gstRate }]); };
  const totals = useMemo(() => {
    let list = 0, net = 0, tax = 0;
    for (const l of lines) {
      const price = toPaise(l.price) ?? 0;
      const lp = l.packageId ? listPrice(l.packageId) : price;
      list += lp * l.qty; net += price * l.qty; tax += (price * l.qty * l.gstRate) / 100;
    }
    return { list, net, discount: Math.max(0, list - net), tax: Math.round(tax), total: net + Math.round(tax) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, priceListId, products, lists]);
  const pct = totals.list ? (totals.discount * 100) / totals.list : 0;
  const belowMin = lines.filter((l) => l.packageId && minPrice(l.packageId) !== null && (toPaise(l.price) ?? 0) < minPrice(l.packageId)!);
  const needsApproval = (settings && pct > settings.quoteMaxDiscountPct) || belowMin.length > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    const body = {
      priceListId: priceListId || null, validUntil: validUntil ? new Date(`${validUntil}T23:59:00`).toISOString() : null, notes: notes || null, terms: terms || null,
      items: lines.map((l) => (l.packageId ? { packageId: l.packageId, qty: l.qty, pricePaise: toPaise(l.price) ?? undefined, name: l.name } : { name: l.name, qty: l.qty, pricePaise: toPaise(l.price) ?? 0, gstRate: l.gstRate })),
    };
    try {
      const r = await api<Quote>(quote ? `/api/v1/quotes/${quote.id}` : `/api/v1/leads/${lead.id}/quotes`, { method: quote ? 'PUT' : 'POST', body, workspace: ws });
      onSaved(r.needsApproval ? `Quote ${r.number} saved — it needs a manager’s approval before it goes out.` : `Quote ${r.number} saved.`);
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 820, maxHeight: '94vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{quote ? `Edit ${quote.number}` : `New quote for ${lead.name}`}</h2>
        {err && <div className="error">{err}</div>}
        <div className="grid cols-3">
          <div className="field"><label>Price list</label>
            <select className="input" value={priceListId} onChange={(e) => setPriceListId(e.target.value)}>
              <option value="">MRP (no price list)</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isDefault ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div className="field"><label>Valid until</label><input className="input" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></div>
          <div className="field"><label>Add product</label>
            <select className="input" value="" onChange={(e) => addProduct(e.target.value)}>
              <option value="">{products.length ? 'Choose a product…' : 'No products yet'}</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {inr(listPrice(p.id))}</option>)}
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table quote-lines">
            <thead><tr><th>Item</th><th style={{ width: 70 }}>Qty</th><th style={{ width: 130 }}>Price (₹)</th><th style={{ width: 70 }}>GST %</th><th style={{ textAlign: 'right' }}>Amount</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const lp = l.packageId ? listPrice(l.packageId) : null;
                const low = belowMin.includes(l);
                const set = (patch: Partial<typeof l>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <tr key={i}>
                    <td>{l.packageId ? <b>{l.name}</b> : <input className="input" value={l.name} onChange={(e) => set({ name: e.target.value })} placeholder="Description" required />}
                      {lp !== null && <div className="small muted">List {inr(lp)}{minPrice(l.packageId) !== null ? ` · lowest ${inr(minPrice(l.packageId))}` : ''}</div>}</td>
                    <td><input className="input" type="number" min={1} value={l.qty} onChange={(e) => set({ qty: Math.max(1, Number(e.target.value) || 1) })} aria-label="Quantity" /></td>
                    <td><input className="input" type="number" min={0} step="0.01" value={l.price} onChange={(e) => set({ price: e.target.value })} aria-label="Price" style={low ? { borderColor: 'var(--warn)' } : undefined} required /></td>
                    <td>{l.packageId ? <span className="small">{l.gstRate}%</span> : <input className="input" type="number" min={0} max={28} value={l.gstRate} onChange={(e) => set({ gstRate: Number(e.target.value) || 0 })} aria-label="GST" />}</td>
                    <td style={{ textAlign: 'right' }}>{inr((toPaise(l.price) ?? 0) * l.qty)}</td>
                    <td><button type="button" className="btn sm ghost" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                );
              })}
              {!lines.length && <tr><td colSpan={6} className="small muted">Add products above, or a custom line.</td></tr>}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn sm ghost" onClick={() => setLines([...lines, { packageId: '', name: '', qty: 1, price: '', gstRate: 18 }])}>+ Custom line</button>
        <div className="quote-totals">
          <div><span>List value</span><b>{inr(totals.list)}</b></div>
          <div><span>Discount{pct ? ` (${pct.toFixed(1)}%)` : ''}</span><b>−{inr(totals.discount)}</b></div>
          <div><span>GST</span><b>{inr(totals.tax)}</b></div>
          <div className="grand"><span>Total</span><b>{inr(totals.total)}</b></div>
        </div>
        {needsApproval && <div className="notice" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>Needs a manager’s approval before sending: {[...belowMin.map((l) => `${l.name} is below its lowest price`), ...(settings && pct > settings.quoteMaxDiscountPct ? [`discount is above ${settings.quoteMaxDiscountPct}%`] : [])].join('; ')}.</div>}
        <div className="grid cols-2">
          <div className="field"><label>Notes for the customer</label><textarea className="input" style={{ height: 70, paddingTop: 8 }} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div className="field"><label>Terms</label><textarea className="input" style={{ height: 70, paddingTop: 8 }} value={terms} onChange={(e) => setTerms(e.target.value)} /></div>
        </div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!lines.length}>Save quote</button>
        </div>
      </form>
    </div>
  );
}

// ── Payments ──

function PaymentsTab({ proc, lead, act, call }: { proc: Processes; lead: { id: string }; act: Act; call: Call }) {
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState('instalment');
  const [mode, setMode] = useState('upi');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const live = proc.payments.filter((p) => !p.isVoided);
  return (
    <>
      {proc.canPay && (
        <form className="pay-form" onSubmit={(e) => {
          e.preventDefault();
          act(() => call(`/api/v1/leads/${lead.id}/payments`, 'POST', { amountPaise: toPaise(amount), kind, mode, reference: reference || null, receivedAt: new Date(`${date}T12:00:00`).toISOString() }), 'Payment recorded.')
            .then((ok) => { if (ok) { setAmount(''); setReference(''); } });
        }}>
          <div className="field"><label>Amount (₹)</label><input className="input" type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
          <div className="field"><label>Type</label><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="token">Token / advance</option><option value="instalment">Instalment</option><option value="balance">Balance</option><option value="full">Full payment</option></select></div>
          <div className="field"><label>Mode</label><select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>{['upi', 'cash', 'card', 'bank', 'cheque', 'online'].map((m) => <option key={m} value={m}>{m.toUpperCase() === 'UPI' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}</option>)}</select></div>
          <div className="field"><label>Reference</label><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></div>
          <div className="field"><label>Received on</label><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <button className="btn" style={{ alignSelf: 'end', marginBottom: 12 }}>Record</button>
        </form>
      )}
      {!proc.payments.length ? <p className="small muted">No payment recorded yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th style={{ textAlign: 'right' }}>Amount</th><th>Type</th><th>Mode</th><th>Reference</th><th /></tr></thead>
            <tbody>
              {proc.payments.map((p) => (
                <tr key={p.id} style={p.isVoided ? { opacity: 0.55 } : undefined}>
                  <td>{new Date(p.receivedAt).toLocaleDateString('en-IN')}</td>
                  <td style={{ textAlign: 'right', textDecoration: p.isVoided ? 'line-through' : undefined }}><b>{inr(p.amountPaise)}</b></td>
                  <td className="small">{p.kind}{p.source === 'rule' ? ' · by rule' : ''}</td>
                  <td className="small">{p.mode}</td>
                  <td className="small">{p.reference ?? ''}{p.isVoided && <div style={{ color: 'var(--bad)' }}>Voided: {p.voidReason}</div>}</td>
                  <td>{proc.canPay && !p.isVoided && <button className="btn sm ghost" onClick={() => setVoiding(p)}>Void</button>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td><b>Total received</b></td><td style={{ textAlign: 'right' }}><b>{inr(live.reduce((s, p) => s + p.amountPaise, 0))}</b></td><td colSpan={4} /></tr></tfoot>
          </table>
        </div>
      )}
      {voiding && <ReasonDialog title={`Void ${inr(voiding.amountPaise)}`} hint="A voided payment stays on record but no longer counts. Say why." confirm="Void payment"
        onClose={() => setVoiding(null)} onSubmit={(reason) => act(() => call(`/api/v1/payments/${voiding.id}/void`, 'POST', { reason }), 'Payment voided.').then((ok) => ok && setVoiding(null))} />}
    </>
  );
}

// ── Lead team ──

function TeamTab({ team, people, lead, act, call }: { team: Member[]; people: { id: string; name: string }[]; lead: { id: string; canUpdate: boolean; ownerId?: string | null }; act: Act; call: Call }) {
  const [userId, setUserId] = useState('');
  const [roleLabel, setRoleLabel] = useState('');
  const options = people.filter((p) => p.id !== lead.ownerId && !team.some((t) => t.userId === p.id));
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>People who work on this lead besides its owner (designer, consultant, accounts …). They can open the lead and get its process steps.</p>
      {team.map((m) => (
        <div key={m.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <span><b>{m.name}</b> <span className="badge grey">{m.roleLabel}</span></span>
          {lead.canUpdate && <button className="btn sm ghost" onClick={() => act(() => call(`/api/v1/leads/${lead.id}/team/${m.id}/remove`, 'POST'), `${m.name} removed from the team.`)}>Remove</button>}
        </div>
      ))}
      {lead.canUpdate && (
        <form className="row" style={{ gap: 8, marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); act(() => call(`/api/v1/leads/${lead.id}/team`, 'POST', { userId, roleLabel }), 'Added to the team.').then((ok) => { if (ok) { setUserId(''); setRoleLabel(''); } }); }}>
          <select className="input" style={{ maxWidth: 220 }} value={userId} onChange={(e) => setUserId(e.target.value)} required aria-label="Person">
            <option value="">Add a person…</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input" style={{ maxWidth: 200 }} placeholder="Role on this lead, e.g. Designer" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} required minLength={2} list="team-roles" />
          <datalist id="team-roles">{['Designer', 'Consultant', 'Site engineer', 'Accounts', 'Co-RM', 'Support'].map((r) => <option key={r} value={r} />)}</datalist>
          <button className="btn sm outline">Add</button>
        </form>
      )}
    </>
  );
}
