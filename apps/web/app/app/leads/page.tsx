'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { FieldInput } from '@/components/FieldInput';
import { showValue, WorkspaceSettings } from '@/lib/workspace';

interface Lead {
  id: string;
  name: string;
  mobile: string | null;
  customerId: string;
  customerCode: string;
  source: string;
  workspace: string;
  pipeline: string;
  stageId: string;
  stage: string;
  lostReason: string | null;
  customFields: Record<string, unknown>;
  owner: string | null;
  createdAt: string;
}

export default function LeadsPage() {
  const { me, can, version } = useShell();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [ws, setWs] = useState<WorkspaceSettings | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [losing, setLosing] = useState<{ lead: Lead; stageId: string } | null>(null);

  const load = useCallback(() => {
    setError('');
    api<Lead[]>(`/api/v1/leads${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then(setLeads)
      .catch((e) => setError(e.message));
  }, [q]);

  useEffect(() => {
    load();
    if (me.currentWorkspaceId && can('org.workspace.view')) {
      api<WorkspaceSettings>(`/api/v1/workspaces/${me.currentWorkspaceId}/settings`).then(setWs).catch(() => setWs(null));
    } else setWs(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const stagesFor = (lead: Lead) => ws?.pipelines.find((p) => p.name === lead.pipeline)?.stages ?? [];
  const sourceLabel = (v: string) => ws?.sources.find((s) => s.value === v)?.label ?? v;
  const activeFields = ws?.fields.filter((f) => !f.isArchived) ?? [];
  const shownFields = activeFields.slice(0, 2); // first two custom fields appear as table columns

  async function moveStage(lead: Lead, stageId: string, lostReason?: string) {
    const target = stagesFor(lead).find((s) => s.id === stageId);
    if (target?.isLost && !lostReason && ws?.lostReasons.length) return setLosing({ lead, stageId });
    try {
      await api(`/api/v1/leads/${lead.id}/stage`, { method: 'PATCH', body: { stageId, lostReason } });
      setLosing(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function exportCsv() {
    try {
      const blob = await api<Blob>('/api/v1/leads/export');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'leads.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  }

  const canCreate = can('crm.lead.create') && !!me.currentWorkspaceId && !!ws;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="muted small">
            {ws?.name ?? 'All business lines'} · your access: {me.permissions['crm.lead.view']?.toLowerCase()} scope
          </div>
        </div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); load(); }}>
            <input className="input" style={{ width: 200 }} placeholder="Search name or mobile" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          {can('crm.lead.export') && <button className="btn outline" onClick={exportCsv}>Export CSV</button>}
          {canCreate && <button className="btn" onClick={() => setAdding(true)}>+ Add lead</button>}
        </div>
      </div>
      {!me.currentWorkspaceId && can('crm.lead.create') && (
        <div className="notice">Select a workspace (business line) at the top to add leads to it.</div>
      )}
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th><th>Mobile</th>{!me.currentWorkspaceId && <th>Workspace</th>}
                {shownFields.map((f) => <th key={f.key}>{f.label}</th>)}
                <th>Stage</th><th>Source</th><th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {leads?.map((l) => (
                <tr key={l.id}>
                  <td>{can('crm.customer.view') ? <Link href={`/app/customers/${l.customerId}`}><b>{l.name}</b></Link> : <b>{l.name}</b>}<div className="small muted">{l.customerCode} · {l.pipeline}</div></td>
                  <td>{l.mobile}</td>
                  {!me.currentWorkspaceId && <td><span className="badge">{l.workspace}</span></td>}
                  {shownFields.map((f) => <td key={f.key} className="small">{showValue(f, l.customFields?.[f.key]) || <span className="muted">—</span>}</td>)}
                  <td>
                    {can('crm.lead.update') && stagesFor(l).length ? (
                      <select className="input" style={{ height: 30, width: 150 }} value={l.stageId} onChange={(e) => moveStage(l, e.target.value)}>
                        {stagesFor(l).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    ) : (
                      <span className={`badge ${l.stage === 'Won' ? 'ok' : l.lostReason || l.stage === 'Lost' ? 'bad' : ''}`}>{l.stage}</span>
                    )}
                    {l.lostReason && <div className="small muted">{l.lostReason}</div>}
                  </td>
                  <td className="muted">{sourceLabel(l.source)}</td>
                  <td>{l.owner ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {leads && !leads.length && <div className="empty">No leads in your view yet.</div>}
          {!leads && !error && <div className="empty">Loading…</div>}
        </div>
      </div>

      {adding && ws && (
        <AddLead
          ws={ws}
          onClose={() => setAdding(false)}
          onSaved={(existing) => {
            setAdding(false);
            setNotice(existing ? 'Lead added and linked to the existing customer record (same mobile number).' : 'Lead added.');
            load();
          }}
        />
      )}
      {losing && ws && (
        <div className="modal-bg" onClick={() => setLosing(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            const reason = new FormData(e.currentTarget).get('reason') as string;
            moveStage(losing.lead, losing.stageId, reason);
          }}>
            <h2>Why was {losing.lead.name} lost?</h2>
            <div className="field">
              <select name="reason" className="input" required defaultValue="">
                <option value="" disabled>Choose a reason…</option>
                {ws.lostReasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div className="row end">
              <button type="button" className="btn ghost" onClick={() => setLosing(null)}>Cancel</button>
              <button className="btn danger">Mark as lost</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function AddLead({ ws, onClose, onSaved }: { ws: WorkspaceSettings; onClose: () => void; onSaved: (existing: boolean) => void }) {
  const [form, setForm] = useState({
    name: '', mobile: '', email: '',
    source: ws.sources.find((s) => s.value === 'manual')?.value ?? ws.sources[0]?.value ?? 'manual',
    pipelineId: ws.pipelines[0]?.id ?? '',
  });
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const fields = ws.fields.filter((f) => !f.isArchived);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const r = await api<{ existingCustomer: boolean }>('/api/v1/leads', { method: 'POST', body: { ...form, customFields: custom } });
      onSaved(r.existingCustomer);
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
            <div className="small" style={{ fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '6px 0 8px' }}>
              {ws.name} details
            </div>
            <div className="grid cols-2">
              {fields.map((f) => (
                <div key={f.key} className="field" style={f.type === 'multiselect' || f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                  <label htmlFor={`f_${f.key}`}>{f.label}{f.required && ' *'}</label>
                  <FieldInput field={f} value={custom[f.key]} onChange={(v) => setCustom({ ...custom, [f.key]: v })} />
                  {fieldErrors[f.key] && <span className="small" style={{ color: 'var(--bad)' }}>{fieldErrors[f.key]}</span>}
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
