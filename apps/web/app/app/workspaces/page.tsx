'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Workspace {
  id: string;
  name: string;
  template: string | null;
  leadCount: number;
  pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[];
}

const TEMPLATES = ['education', 'real_estate', 'consulting', 'design_services', 'software', 'insurance', 'healthcare', 'other'];

export default function WorkspacesPage() {
  const { me, can, version } = useShell();
  const [list, setList] = useState<Workspace[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', template: 'consulting' });

  const load = () => api<Workspace[]>('/api/v1/workspaces').then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [version]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/v1/workspaces', { method: 'POST', body: form, noWorkspace: true });
      setAdding(false);
      setForm({ name: '', template: 'consulting' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  }

  const canManage = me.permissions['org.workspace.manage'] === 'ORGANIZATION';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workspaces</h1>
          <div className="muted small">Each business line has its own leads, pipelines and team. Customers are shared across the organization.</div>
        </div>
        {canManage && <button className="btn" onClick={() => setAdding(true)}>+ New workspace</button>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="grid cols-3">
        {list?.map((w) => (
          <div className="card" key={w.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>{w.name}</h2>
              <span className="badge grey">{w.leadCount} leads</span>
            </div>
            <div className="small muted" style={{ margin: '4px 0 10px' }}>Template: {w.template ?? '—'}</div>
            {w.pipelines.map((p) => (
              <div key={p.id} style={{ marginBottom: 8 }}>
                <div className="small" style={{ fontWeight: 600 }}>{p.name} pipeline</div>
                <div className="row" style={{ gap: 4, marginTop: 4 }}>
                  {p.stages.map((s) => <span key={s.id} className="badge grey" style={{ fontWeight: 500 }}>{s.name}</span>)}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {!can('org.workspace.view') && <div className="empty">You do not have access to workspaces.</div>}

      {adding && (
        <div className="modal-bg" onClick={() => setAdding(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={create}>
            <h2>New workspace (business line)</h2>
            <div className="field"><label>Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Numerology Courses" required /></div>
            <div className="field">
              <label>Industry template</label>
              <select className="input" value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
                {TEMPLATES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <p className="small muted">A default "Sales" pipeline with standard stages is created; you can customise it later.</p>
            <div className="row end">
              <button type="button" className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn">Create</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
