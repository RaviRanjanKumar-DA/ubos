'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface Template { id: string; channel: string; name: string; category: string; subject: string | null; body: string; variables: string[]; dltTemplateId: string | null; providerTemplateId: string | null }
interface Broadcast { id: string; name: string; total: number; sent: number; skipped: number; failed: number; createdAt: string }
type Tab = 'sms' | 'email' | 'bulk';
const blank = { name: '', category: 'marketing', subject: '', body: '', variables: '', dltTemplateId: '', providerTemplateId: '' };

/** SMS and email templates, and the history of bulk sends. */
export default function OutreachPage() {
  const { can } = useShell();
  const [tab, setTab] = useState<Tab>('sms');
  const [data, setData] = useState<{ canManage: boolean; templates: Template[] } | null>(null);
  const [bulk, setBulk] = useState<Broadcast[] | null>(null);
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const manage = can('crm.message.manage');
  const load = useCallback(() => api<NonNullable<typeof data>>('/api/v1/outreach/templates').then(setData).catch(() => setData(null)), []);
  useEffect(() => { load(); if (manage) api<Broadcast[]>('/api/v1/outreach/broadcasts').then(setBulk).catch(() => setBulk([])); }, [load, manage]);
  const rows = data?.templates.filter((t) => t.channel === tab) ?? [];
  const blanks = tab === 'sms' ? (f.body.match(/\{#var#\}/gi) ?? []).length : Math.max(0, ...[...`${f.subject} ${f.body}`.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
  function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    api('/api/v1/outreach/templates', { method: 'POST', body: { channel: tab, name: f.name, category: f.category, body: f.body, subject: tab === 'email' ? f.subject : null, variables: f.variables.split(',').map((x) => x.trim()).filter(Boolean), dltTemplateId: tab === 'sms' ? f.dltTemplateId : null, providerTemplateId: tab === 'sms' ? f.providerTemplateId || null : null } })
      .then(() => { setF(blank); setMsg({ type: 'notice', text: 'Template saved.' }); load(); })
      .catch((x) => setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }));
  }
  return (
    <>
      <div className="page-head"><div><h1>SMS & Email</h1><p className="muted small" style={{ margin: 0 }}>Templates your team sends from a lead, or to many leads from the Leads page (tick leads → SMS / Email). People who opted out are always skipped.</p></div></div>
      <div className="dash-tabs" role="tablist">
        {([['sms', 'SMS templates'], ['email', 'Email templates'], ...(manage ? [['bulk', 'Bulk sends']] : [])] as [Tab, string][]).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`dash-tab ${tab === k ? 'on' : ''}`} onClick={() => { setTab(k); setF(blank); setMsg(null); }}>{l}</button>)}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {tab === 'bulk' ? (
        <div className="card">{!bulk?.length ? <p className="small muted" style={{ margin: 0 }}>No bulk sends yet.</p> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>When</th><th>Leads</th><th>Sent</th><th>Skipped</th><th>Failed</th></tr></thead>
            <tbody>{bulk.map((b) => <tr key={b.id}><td><b>{b.name}</b></td><td className="small">{new Date(b.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}</td><td>{b.total}</td><td>{b.sent}</td><td>{b.skipped}</td><td>{b.failed}</td></tr>)}</tbody></table></div>
        )}</div>
      ) : (
        <div className={data?.canManage ? 'prod-grid' : ''}>
          <div className="card">
            {!rows.length && <p className="small muted" style={{ margin: 0 }}>No {tab === 'sms' ? 'SMS' : 'email'} templates yet.</p>}
            {rows.map((t) => (
              <div key={t.id} className="run-card">
                <div className="row" style={{ justifyContent: 'space-between' }}><span><b>{t.name}</b> <span className="badge grey">{t.category}</span></span>
                  {data?.canManage && <button className="btn sm ghost" onClick={() => api(`/api/v1/outreach/templates/${t.id}`, { method: 'PATCH', body: { isArchived: true } }).then(load)}>Archive</button>}</div>
                {t.subject && <div className="small"><b>{t.subject}</b></div>}
                <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{t.body}</div>
                <div className="small muted">{t.dltTemplateId ? `DLT ${t.dltTemplateId} · ` : ''}{t.variables.map((v, i) => `${tab === 'sms' ? `blank ${i + 1}` : `{{${i + 1}}}`} = ${v}`).join(' · ')}</div>
              </div>
            ))}
          </div>
          {data?.canManage && (
            <form className="card" onSubmit={save}>
              <h2>New {tab === 'sms' ? 'SMS' : 'email'} template</h2>
              <div className="grid cols-2">
                <div className="field"><label>Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="visit_reminder" /></div>
                <div className="field"><label>Type</label><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="marketing">Marketing</option><option value="utility">Service / utility</option></select></div>
              </div>
              {tab === 'email' && <div className="field"><label>Subject</label><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required placeholder="Welcome {{1}}" /></div>}
              <div className="field"><label>{tab === 'sms' ? 'Text (exactly as approved on DLT)' : 'Text'}</label><textarea className="input" style={{ height: 100, paddingTop: 8 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required placeholder={tab === 'sms' ? 'Dear {#var#}, your visit is booked.' : 'Hello {{1}}, …'} /></div>
              <div className="field"><label>What fills the blanks{blanks ? ` (${blanks}, comma separated, in order)` : ''}</label><input className="input" value={f.variables} onChange={(e) => setF({ ...f, variables: e.target.value })} placeholder="name, owner" /><div className="small muted" style={{ marginTop: 4 }}>name, mobile, city, owner, cf:&lt;lead field&gt;, or text:&lt;fixed words&gt;</div></div>
              {tab === 'sms' && (
                <div className="grid cols-2">
                  <div className="field"><label>DLT template ID</label><input className="input" value={f.dltTemplateId} onChange={(e) => setF({ ...f, dltTemplateId: e.target.value })} required /></div>
                  <div className="field"><label>MSG91 template ID (MSG91 only)</label><input className="input" value={f.providerTemplateId} onChange={(e) => setF({ ...f, providerTemplateId: e.target.value })} /></div>
                </div>
              )}
              <div className="row end"><button className="btn">Save</button></div>
            </form>
          )}
        </div>
      )}
    </>
  );
}
