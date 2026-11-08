'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Template } from './Chat';

/** Sends an approved template to the selected leads; opted-out customers are skipped by the server. */
export function BroadcastDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (text: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ templates: Template[] }>('/api/v1/message-templates').then((r) => setTemplates(r.templates)).catch(() => setTemplates([])); }, []);
  const t = templates.find((x) => x.id === templateId);
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { const r = await api<{ sent: number; skipped: number; failed: number }>('/api/v1/broadcasts', { method: 'POST', body: { name, templateId, leadIds: ids } }); onDone(`WhatsApp broadcast: ${r.sent} sent, ${r.skipped} skipped (opted out or no number), ${r.failed} failed.`); }
        catch (x) { setErr(x instanceof ApiError ? x.message : 'Failed'); setBusy(false); }
      }}>
        <h2>Send WhatsApp to {ids.length} lead(s)</h2>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>Broadcast name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="e.g. Diwali offer" /></div>
        <div className="field"><label>Approved template</label><select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} required><option value="">{templates.length ? 'Choose…' : 'No templates yet (WhatsApp Inbox → Templates)'}</option>{templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        {t && <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{t.body}</p>}
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !templateId}>{busy ? 'Sending…' : 'Send'}</button></div>
      </form>
    </div>
  );
}
