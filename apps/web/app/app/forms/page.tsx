'use client';

import { Icon } from '@/components/Icon';
import { PickWorkspace } from '@/components/PickWorkspace';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

interface FormField { target: string; label: string; required: boolean; placeholder?: string }
interface LeadForm {
  id: string; name: string; slug: string; title: string; description: string | null; fields: FormField[]; submitLabel: string; thankYou: string; redirectUrl: string | null;
  source: string; duplicateMode: string; color: string; isActive: boolean; isArchived: boolean; submissions: number; hostedUrl: string; postUrl: string; embedCode: string; createdAt: string;
}
interface Data { canManage: boolean; targets: { value: string; label: string }[]; duplicateModes: { value: string; label: string }[]; forms: LeadForm[] }
type Edit = Omit<LeadForm, 'id' | 'hostedUrl' | 'postUrl' | 'embedCode' | 'submissions' | 'isArchived' | 'createdAt'> & { id?: string };

const blank = (): Edit => ({
  name: '', slug: '', title: 'Talk to us', description: 'Leave your details and we will call you back.', submitLabel: 'Submit', thankYou: 'Thank you! We will contact you soon.', redirectUrl: null,
  source: 'website', duplicateMode: 'add_remark', color: '#5b3cc4', isActive: true,
  fields: [{ target: 'name', label: 'Your name', required: true }, { target: 'mobile', label: 'Mobile number', required: true }, { target: 'email', label: 'Email', required: false }, { target: 'remark', label: 'Message', required: false }],
});

/** Web-to-lead forms of the business line: hosted page link and embed code; submissions become leads. */
export default function FormsPage() {
  const { me, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [data, setData] = useState<Data | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [share, setShare] = useState<LeadForm | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(() => (ws ? api<Data>('/api/v1/forms').then(setData).catch(() => setData(null)) : Promise.resolve()), [ws]);
  useEffect(() => { load(); }, [load, version]);
  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  };

  if (!ws) return (<><div className="page-head"><h1>Web forms</h1></div><PickWorkspace text="Forms belong to a business line." /></>);
  const label = (t: string) => data?.targets.find((x) => x.value === t)?.label ?? t;

  return (
    <>
      <div className="page-head">
        <div><h1>Web forms</h1><p className="muted small" style={{ margin: 0 }}>Share a link or put a form on your website — every submission becomes a lead here, assigned by your rules.</p></div>
        {data?.canManage && !edit && <button className="btn" onClick={() => setEdit(blank())}>+ New form</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {edit && data && (
        <form className="card" style={{ maxWidth: 980, marginBottom: 14 }} onSubmit={(e) => {
          e.preventDefault();
          const body = { ...edit, slug: edit.slug || undefined, redirectUrl: edit.redirectUrl || null, description: edit.description || null };
          act(async () => { await api(edit.id ? `/api/v1/forms/${edit.id}` : '/api/v1/forms', { method: edit.id ? 'PUT' : 'POST', body }); setEdit(null); }, 'Form saved.');
        }}>
          <h2>{edit.id ? 'Edit form' : 'New form'}</h2>
          <div className="form-builder">
            <div>
              <div className="grid cols-2">
                <div className="field"><label>Name (for your team)</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required minLength={2} placeholder="Home audit enquiry" /></div>
                <div className="field"><label>Link name</label><input className="input" value={edit.slug} onChange={(e) => setEdit({ ...edit, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="made from the name" /></div>
              </div>
              <div className="field"><label>Heading</label><input className="input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} required minLength={2} /></div>
              <div className="field"><label>Text under the heading</label><input className="input" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
              <h3 style={{ fontSize: 14, margin: '8px 0' }}>Questions</h3>
              {edit.fields.map((f, i) => (
                <div key={i} className="row" style={{ gap: 6, marginBottom: 6, flexWrap: 'nowrap' }}>
                  <select className="input" style={{ maxWidth: 170 }} value={f.target} aria-label="Lead field" onChange={(e) => setEdit({ ...edit, fields: edit.fields.map((x, j) => (j === i ? { ...x, target: e.target.value, label: x.label || label(e.target.value) } : x)) })}>
                    {data.targets.map((t) => <option key={t.value} value={t.value} disabled={t.value !== f.target && edit.fields.some((x) => x.target === t.value)}>{t.label}</option>)}
                  </select>
                  <input className="input" value={f.label} aria-label="Question" onChange={(e) => setEdit({ ...edit, fields: edit.fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} required />
                  <label className="row small" style={{ whiteSpace: 'nowrap', flexWrap: 'nowrap', gap: 4 }}><input type="checkbox" checked={f.required} onChange={(e) => setEdit({ ...edit, fields: edit.fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} /> Required</label>
                  <button type="button" className="btn sm ghost" disabled={i === 0} aria-label="Move up" onClick={() => { const n = [...edit.fields]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setEdit({ ...edit, fields: n }); }}><Icon name="up" className="ic" /></button>
                  <button type="button" className="btn sm ghost" aria-label="Remove" disabled={f.target === 'name'} onClick={() => setEdit({ ...edit, fields: edit.fields.filter((_, j) => j !== i) })}><Icon name="close" className="ic" /></button>
                </div>
              ))}
              {edit.fields.length < data.targets.length && <button type="button" className="btn sm ghost" onClick={() => { const t = data.targets.find((x) => !edit.fields.some((f) => f.target === x.value))!; setEdit({ ...edit, fields: [...edit.fields, { target: t.value, label: t.label, required: false }] }); }}>+ Question</button>}
              <div className="grid cols-3" style={{ marginTop: 10 }}>
                <div className="field"><label>Button text</label><input className="input" value={edit.submitLabel} onChange={(e) => setEdit({ ...edit, submitLabel: e.target.value })} /></div>
                <div className="field"><label>Lead source</label><input className="input" value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} /></div>
                <div className="field"><label>Colour</label><input className="input" type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} style={{ padding: 2 }} /></div>
              </div>
              <div className="field"><label>Thank-you message</label><input className="input" value={edit.thankYou} onChange={(e) => setEdit({ ...edit, thankYou: e.target.value })} /></div>
              <div className="field"><label>Or open this page after submitting (optional)</label><input className="input" type="url" value={edit.redirectUrl ?? ''} onChange={(e) => setEdit({ ...edit, redirectUrl: e.target.value })} placeholder="https://yoursite.com/thank-you" /></div>
              <div className="field"><label>Someone who already has an open lead</label>
                <select className="input" value={edit.duplicateMode} onChange={(e) => setEdit({ ...edit, duplicateMode: e.target.value })}>{data.duplicateModes.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</select>
              </div>
              <label className="row small"><input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Form is open for submissions</label>
            </div>
            <div className="form-preview" style={{ ['--fc' as string]: edit.color }}>
              <div className="small muted" style={{ marginBottom: 6 }}>Preview</div>
              <div className="pub-form">
                <h2>{edit.title}</h2>
                {edit.description && <p className="small muted">{edit.description}</p>}
                {edit.fields.map((f) => <div key={f.target} className="field"><label>{f.label}{f.required && ' *'}</label>{f.target === 'remark' ? <textarea className="input" disabled style={{ height: 60 }} /> : <input className="input" disabled />}</div>)}
                <button type="button" className="btn" style={{ background: edit.color, borderColor: edit.color, width: '100%' }}>{edit.submitLabel}</button>
              </div>
            </div>
          </div>
          <div className="row end" style={{ marginTop: 12 }}><button type="button" className="btn ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn">Save form</button></div>
        </form>
      )}
      <div className="card">
        {!data?.forms.length && <p className="small muted" style={{ margin: 0 }}>No form yet.{data?.canManage ? ' Create one — it takes a minute.' : ''}</p>}
        {data?.forms.map((f) => (
          <div key={f.id} className="run-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                <b>{f.name}</b> {f.isActive ? <span className="badge ok">Open</span> : <span className="badge grey">Closed</span>} <span className="small muted">· {f.submissions} submission(s) · source “{f.source}”</span>
                <div className="small"><a href={f.hostedUrl} target="_blank" rel="noreferrer">{f.hostedUrl}</a></div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn sm outline" onClick={() => setShare(f)}>Share / embed</button>
                {data.canManage && <button className="btn sm ghost" onClick={() => setEdit({ id: f.id, name: f.name, slug: f.slug, title: f.title, description: f.description, fields: f.fields, submitLabel: f.submitLabel, thankYou: f.thankYou, redirectUrl: f.redirectUrl, source: f.source, duplicateMode: f.duplicateMode, color: f.color, isActive: f.isActive })}>Edit</button>}
                {data.canManage && <button className="btn sm ghost" onClick={() => act(() => api(`/api/v1/forms/${f.id}/archive`, { method: 'POST', body: { archived: true } }), 'Form archived (its leads stay).')}>Archive</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {share && (
        <div className="modal-bg" onClick={() => setShare(null)}>
          <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <h2>Share “{share.name}”</h2>
            <div className="field"><label>Link (WhatsApp, Instagram bio, SMS…)</label><div className="row" style={{ flexWrap: 'nowrap' }}><code className="webhook">{share.hostedUrl}</code><button className="btn sm outline" onClick={() => navigator.clipboard?.writeText(share.hostedUrl)}>Copy</button></div></div>
            <div className="field"><label>Embed on your website</label><textarea className="input" readOnly value={share.embedCode} style={{ height: 80, fontFamily: 'monospace', fontSize: 12, paddingTop: 6 }} onFocus={(e) => e.target.select()} /><button className="btn sm outline" style={{ marginTop: 6 }} onClick={() => navigator.clipboard?.writeText(share.embedCode)}>Copy code</button></div>
            <div className="field"><label>Or post from your own form (developers)</label><code className="webhook">POST {share.postUrl}</code><div className="small muted" style={{ marginTop: 4 }}>JSON or form fields named {share.fields.map((f) => f.target).join(', ')}; optional utm_source / utm_medium / utm_campaign.</div></div>
            <div className="row end"><button className="btn" onClick={() => setShare(null)}>Done</button></div>
          </div>
        </div>
      )}
    </>
  );
}
