'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface Template { id: string; channel: string; name: string; subject: string | null; body: string }
interface Log { smsConnected: boolean; smsOptOut: boolean; emailOptOut: boolean; hasMobile: boolean; hasEmail: boolean; messages: { id: string; channel: string; templateName: string | null; body: string | null; status: string; error: string | null; at: string; by: string | null }[] }
const TONE: Record<string, string> = { delivered: 'ok', sent: '', queued: 'grey', failed: 'bad' };

/** SMS & email on a lead: send an approved template, see what was sent, record opt-outs. */
export function LeadOutreach({ leadId, workspace, canUpdate }: { leadId: string; workspace: string; canUpdate: boolean }) {
  const [log, setLog] = useState<Log | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tpl, setTpl] = useState('');
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Log>(`/api/v1/leads/${leadId}/outreach`, { workspace }).then(setLog).catch(() => setLog(null)), [leadId, workspace]);
  useEffect(() => { load(); api<{ templates: Template[] }>('/api/v1/outreach/templates', { workspace }).then((r) => setTemplates(r.templates)).catch(() => setTemplates([])); }, [load, workspace]);
  if (!log) return <p className="small muted">SMS and email are not available for this lead.</p>;
  const t = templates.find((x) => x.id === tpl);
  async function send() {
    setBusy(true); setMsg(null);
    try { await api(`/api/v1/leads/${leadId}/outreach`, { method: 'POST', body: { templateId: tpl }, workspace }); setMsg({ type: 'notice', text: `${t?.channel === 'sms' ? 'SMS' : 'Email'} sent.` }); setTpl(''); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
    await load(); setBusy(false);
  }
  const toggle = (channel: 'sms' | 'email', optedOut: boolean) => api(`/api/v1/leads/${leadId}/outreach/opt-out`, { method: 'POST', body: { channel, optedOut }, workspace }).then(load).catch((e) => setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }));
  return (
    <>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="row" style={{ flexWrap: 'nowrap', maxWidth: 560 }}>
        <select className="input" value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Template">
          <option value="">{templates.length ? 'Choose a template…' : 'No templates yet (SMS & Email page)'}</option>
          {templates.map((x) => <option key={x.id} value={x.id}>{x.channel === 'sms' ? 'SMS' : 'Email'} · {x.name}</option>)}
        </select>
        <button className="btn" disabled={busy || !tpl} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
      {t && <p className="small muted" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{t.subject ? `${t.subject}\n` : ''}{t.body}</p>}
      <div className="row small" style={{ gap: 14, margin: '10px 0' }}>
        {!log.smsConnected && <span className="muted">SMS gateway not connected.</span>}
        {canUpdate && <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={log.smsOptOut} onChange={(e) => toggle('sms', e.target.checked)} /> Customer opted out of SMS</label>}
        {canUpdate && <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={log.emailOptOut} onChange={(e) => toggle('email', e.target.checked)} /> Customer opted out of email</label>}
      </div>
      <LeadSequences leadId={leadId} workspace={workspace} onMsg={setMsg} />
      {!log.messages.length ? <p className="small muted">Nothing sent yet.</p> : log.messages.map((m) => (
        <div key={m.id} className="run-card">
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="small"><b>{m.channel === 'sms' ? 'SMS' : 'Email'}</b> · {m.templateName}{m.by ? ` · ${m.by}` : ''} · {new Date(m.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}</span><span className={`badge ${TONE[m.status] ?? 'grey'}`}>{m.status}</span></div>
          <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{m.body}</div>
          {m.error && <div className="small" style={{ color: 'var(--bad)' }}>{m.error}</div>}
        </div>
      ))}
    </>
  );
}

interface Enrollment { id: string; name: string; status: string; stopReason: string | null; stepIndex: number; totalSteps: number; nextAt: string }

/** Sequences on this lead: start one, see where it is, stop it. */
function LeadSequences({ leadId, workspace, onMsg }: { leadId: string; workspace: string; onMsg: (m: { type: 'error' | 'notice'; text: string }) => void }) {
  const [rows, setRows] = useState<Enrollment[] | null>(null);
  const [seqs, setSeqs] = useState<{ id: string; name: string }[]>([]);
  const [pick, setPick] = useState('');
  const load = useCallback(() => api<Enrollment[]>(`/api/v1/leads/${leadId}/sequences`, { workspace }).then(setRows).catch(() => setRows(null)), [leadId, workspace]);
  useEffect(() => { load(); api<{ id: string; name: string }[]>('/api/v1/automation/sequences', { workspace }).then(setSeqs).catch(() => setSeqs([])); }, [load, workspace]);
  if (!rows) return null; // plan without automation
  const run = (fn: () => Promise<unknown>, text: string) => fn().then(() => { onMsg({ type: 'notice', text }); setPick(''); load(); }).catch((e) => onMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }));
  return (
    <div style={{ margin: '10px 0' }}>
      {seqs.length > 0 && (
        <div className="row" style={{ flexWrap: 'nowrap', maxWidth: 560 }}>
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Sequence"><option value="">Start a sequence…</option>{seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <button className="btn outline" disabled={!pick} onClick={() => run(() => api(`/api/v1/leads/${leadId}/sequences`, { method: 'POST', body: { sequenceId: pick }, workspace }), 'Sequence started.')}>Start</button>
        </div>
      )}
      {rows.map((e) => (
        <div key={e.id} className="row small" style={{ justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
          <span><b>{e.name}</b> <span className={`badge ${e.status === 'active' ? '' : e.status === 'completed' ? 'ok' : 'grey'}`}>{e.status}</span> <span className="muted">step {Math.min(e.stepIndex + 1, e.totalSteps)} of {e.totalSteps}{e.status === 'active' ? ` · next ${new Date(e.nextAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}` : e.stopReason ? ` · ${e.stopReason}` : ''}</span></span>
          {e.status === 'active' && <button className="btn sm ghost" onClick={() => run(() => api(`/api/v1/leads/${leadId}/sequences/${e.id}/stop`, { method: 'POST', workspace }), 'Sequence stopped.')}>Stop</button>}
        </div>
      ))}
    </div>
  );
}
