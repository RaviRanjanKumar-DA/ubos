'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Lead {
  id: string;
  name: string;
  mobile: string | null;
  customerCode: string;
  source: string;
  workspace: string;
  pipeline: string;
  stageId: string;
  stage: string;
  owner: string | null;
  createdAt: string;
}
interface Workspace {
  id: string;
  name: string;
  pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[];
}

const SOURCES = ['manual', 'website', 'facebook', 'whatsapp', 'google_sheets', 'referral', 'indiamart', 'justdial'];

export default function LeadsPage() {
  const { me, can, version } = useShell();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setError('');
    api<Lead[]>(`/api/v1/leads${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then(setLeads)
      .catch((e) => setError(e.message));
  }, [q]);

  useEffect(() => {
    load();
    if (me.currentWorkspaceId && can('org.workspace.view')) {
      api<Workspace[]>('/api/v1/workspaces').then((ws) => setWorkspace(ws.find((w) => w.id === me.currentWorkspaceId) ?? null));
    } else setWorkspace(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  async function moveStage(lead: Lead, stageId: string) {
    try {
      await api(`/api/v1/leads/${lead.id}/stage`, { method: 'PATCH', body: { stageId } });
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

  const stagesFor = (lead: Lead) => workspace?.pipelines.find((p) => p.name === lead.pipeline)?.stages ?? [];
  const canCreate = can('crm.lead.create') && !!me.currentWorkspaceId;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="muted small">
            {me.currentWorkspaceId ? me.workspaces.find((w) => w.id === me.currentWorkspaceId)?.name : 'All business lines'} ·
            your access: {me.permissions['crm.lead.view']?.toLowerCase()} scope
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
                <th>Pipeline</th><th>Stage</th><th>Source</th><th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {leads?.map((l) => (
                <tr key={l.id}>
                  <td><b>{l.name}</b><div className="small muted">{l.customerCode}</div></td>
                  <td>{l.mobile}</td>
                  {!me.currentWorkspaceId && <td><span className="badge">{l.workspace}</span></td>}
                  <td>{l.pipeline}</td>
                  <td>
                    {can('crm.lead.update') && stagesFor(l).length ? (
                      <select className="input" style={{ height: 30, width: 140 }} value={l.stageId} onChange={(e) => moveStage(l, e.target.value)}>
                        {stagesFor(l).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    ) : (
                      <span className={`badge ${l.stage === 'Won' ? 'ok' : l.stage === 'Lost' ? 'bad' : ''}`}>{l.stage}</span>
                    )}
                  </td>
                  <td className="muted">{l.source}</td>
                  <td>{l.owner ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {leads && !leads.length && <div className="empty">No leads in your view yet.</div>}
          {!leads && !error && <div className="empty">Loading…</div>}
        </div>
      </div>

      {adding && workspace && (
        <AddLead
          workspace={workspace}
          onClose={() => setAdding(false)}
          onSaved={(existing) => {
            setAdding(false);
            setNotice(existing ? 'Lead added and linked to the existing customer record (same mobile number).' : 'Lead added.');
            load();
          }}
        />
      )}
    </>
  );
}

function AddLead({ workspace, onClose, onSaved }: { workspace: Workspace; onClose: () => void; onSaved: (existing: boolean) => void }) {
  const [form, setForm] = useState({ name: '', mobile: '', email: '', source: 'manual', pipelineId: workspace.pipelines[0]?.id ?? '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ existingCustomer: boolean }>('/api/v1/leads', { method: 'POST', body: form });
      onSaved(r.existingCustomer);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Add lead · {workspace.name}</h2>
        {error && <div className="error">{error}</div>}
        <div className="field"><label>Name</label><input className="input" value={form.name} onChange={set('name')} required /></div>
        <div className="field"><label>Mobile</label><input className="input" value={form.mobile} onChange={set('mobile')} placeholder="98765 43210" required /></div>
        <div className="field"><label>Email (optional)</label><input className="input" type="email" value={form.email} onChange={set('email')} /></div>
        <div className="grid cols-2">
          <div className="field">
            <label>Pipeline</label>
            <select className="input" value={form.pipelineId} onChange={set('pipelineId')}>
              {workspace.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Source</label>
            <select className="input" value={form.source} onChange={set('source')}>
              {SOURCES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save lead'}</button>
        </div>
      </form>
    </div>
  );
}
