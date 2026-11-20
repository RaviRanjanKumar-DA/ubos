'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError, apiUpload } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm, askText } from '@/components/Dialogs';
import { EmployeeForm } from '@/components/hr/EmployeeForm';
import { hrDate, istYmd, STATUS, TYPES, type Draft, type Emp, type Meta } from '@/components/hr/hr';
import { inr, toPaise } from '@/lib/money';

interface Task { id: string; kind: string; title: string; doneAt: string | null }
interface Doc { id: string; docType: string; fileName: string; sizeBytes: number; expiresAt: string | null; isArchived: boolean; createdAt: string }
interface Detail extends Emp { personalEmail?: string | null; address?: string | null; emergencyName?: string | null; emergencyPhone?: string | null; panLast4?: string | null; bankLast4?: string | null; ctcPaise?: number | null; tasks: Task[]; assets: { id: string; issuedAt: string; returnedAt: string | null; returnCondition: string | null; asset: { tag: string; name: string } }[]; can: { manage: boolean; sensitive: boolean } }

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  const { version } = useShell();
  const [e, setE] = useState<Detail | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState<{ pan: string; account: string; ifsc: string; ctc: string } | null>(null);
  const [upload, setUpload] = useState<{ docType: string; expiresOn: string; file: File | null } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(async () => {
    const d = await api<Detail>(`/api/v1/hr/employees/${id}`);
    setE(d);
    if (d.can.sensitive) setDocs(await api<Doc[]>(`/api/v1/hr/employees/${id}/documents`).catch(() => []));
  }, [id]);
  useEffect(() => { load().catch((x) => setMsg({ type: 'error', text: x.message })); api<Meta>('/api/v1/hr/meta').then(setMeta).catch(() => setMeta(null)); }, [load, version]);
  const run = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { const r = await fn(); setMsg({ type: 'notice', text: typeof r === 'string' ? r : text }); await load(); return true; } catch (x) { setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }); return false; } };
  if (!e) return <>{msg ? <div className={msg.type}>{msg.text}</div> : <div className="muted">Loading…</div>}</>;

  const draft: Draft = { name: e.name, mobile: e.mobile ?? '', workEmail: e.workEmail ?? '', designation: e.designation ?? '', departmentId: e.departmentId ?? '', employmentType: e.employmentType, workLocation: e.workLocation ?? '', joiningOn: istYmd(e.joiningDate), probationEndOn: istYmd(e.probationEnd), dateOfBirthOn: istYmd(e.dateOfBirth), personalEmail: e.personalEmail ?? '', address: e.address ?? '', emergencyName: e.emergencyName ?? '', emergencyPhone: e.emergencyPhone ?? '', noticeDays: String(e.noticeDays), userId: e.userId ?? '' };
  const move = async (status: string) => {
    let body: Record<string, unknown> = { status };
    if (status === 'exited') { const last = await askText('Last working day (YYYY-MM-DD)', e.exitDate ? istYmd(e.exitDate) : istYmd(new Date().toISOString())); if (!last) return; body = { ...body, exitOn: last }; }
    if (status === 'notice') { const reason = await askText('Reason for leaving (optional)'); if (reason === null) return; const last = await askText('Last working day (YYYY-MM-DD, optional)'); body = { ...body, exitReason: reason || null, ...(last ? { exitOn: last } : {}) }; }
    run(async () => { const r = await api<{ loginStillActive: boolean }>(`/api/v1/hr/employees/${id}/status`, { method: 'POST', body }); return r.loginStillActive ? 'Marked as left. Their UBOS login is still on: switch it off in Users.' : 'Status changed.'; }, 'Status changed.');
  };
  const reveal = async () => { try { const r = await api<{ pan: string | null; bank: { account: string; ifsc: string } | null }>(`/api/v1/hr/employees/${id}/reveal`, { method: 'POST' }); setSecret({ pan: r.pan ?? '', account: r.bank?.account ?? '', ifsc: r.bank?.ifsc ?? '', ctc: e.ctcPaise == null ? '' : String(e.ctcPaise / 100) }); } catch (x) { setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }); } };
  const saveSecret = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!secret) return;
    const ctc = secret.ctc.trim() ? toPaise(secret.ctc.replace(/,/g, '')) : null;
    if (secret.ctc.trim() && ctc === null) return setMsg({ type: 'error', text: 'Enter the yearly salary as a number' });
    const bank = secret.account.trim() || secret.ifsc.trim() ? { account: secret.account.trim(), ifsc: secret.ifsc.trim() } : null;
    run(() => api(`/api/v1/hr/employees/${id}`, { method: 'PUT', body: { pan: secret.pan.trim() || null, bank, ctcPaise: ctc } }), 'Saved.').then((ok) => ok && setSecret(null));
  };
  const open = async (d: Doc) => { try { const b = await api<Blob>(`/api/v1/hr/documents/${d.id}/file`); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = d.fileName; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); } catch (x) { setMsg({ type: 'error', text: x instanceof ApiError ? x.message : 'Failed' }); } };
  const sendDoc = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!upload?.file) return;
    if (upload.file.size > 5 * 1024 * 1024) return setMsg({ type: 'error', text: 'Choose a file under 5 MB' });
    const qs = new URLSearchParams({ docType: upload.docType, fileName: upload.file.name, ...(upload.expiresOn ? { expiresOn: upload.expiresOn } : {}) });
    run(() => apiUpload(`/api/v1/hr/employees/${id}/documents?${qs}`, upload.file!), 'Document added.').then((ok) => ok && setUpload(null));
  };
  const groups = (['onboarding', 'exit'] as const).map((k) => [k, e.tasks.filter((t) => t.kind === k)] as const).filter(([, t]) => t.length);
  const row = (label: string, value: React.ReactNode) => <div className="hr-row"><span className="muted">{label}</span><span>{value || '—'}</span></div>;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small"><Link href="/app/hr">Employees</Link></div>
          <h1>{e.name} <span className={`badge ${STATUS[e.status]?.[0]}`}>{STATUS[e.status]?.[1]}</span></h1>
          <div className="muted small">{e.employeeCode}{e.designation ? ` · ${e.designation}` : ''}{e.department ? ` · ${e.department.name}` : ''}</div>
        </div>
        {e.can.manage && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn outline" onClick={() => setEditing(true)}>Edit</button>
            {e.status === 'onboarding' && <button className="btn" onClick={() => move('active')}>Mark as working</button>}
            {(e.status === 'onboarding' || e.status === 'active') && <button className="btn ghost" onClick={() => move('notice')}>Resigned</button>}
            {e.status === 'notice' && <button className="btn" onClick={() => move('exited')}>Mark as left</button>}
            {e.status === 'notice' && <button className="btn ghost" onClick={async () => { if (await askConfirm('Take back the resignation and mark as working again?')) move('active'); }}>Stays on</button>}
            {e.status === 'exited' && <button className="btn ghost" onClick={async () => { if (await askConfirm('Rejoin this person as working?')) move('active'); }}>Rejoined</button>}
          </div>
        )}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="hr-grid">
        <div className="card">
          <h2>Work</h2>
          {row('Mobile', e.mobile)}{row('Work email', e.workEmail)}{row('Employment', TYPES.find(([v]) => v === e.employmentType)?.[1])}{row('Location', e.workLocation)}
          {row('Joined', hrDate(e.joiningDate))}{e.probationEnd && row('Probation ends', hrDate(e.probationEnd))}{row('Notice period', `${e.noticeDays} days`)}
          {e.exitDate && row(e.status === 'exited' ? 'Last day' : 'Leaving on', hrDate(e.exitDate))}{e.exitReason && row('Reason', e.exitReason)}
          {row('UBOS login', e.user ? `${e.user.name}${e.user.isActive ? '' : ' (switched off)'}` : 'None')}
        </div>
        {e.personalEmail !== undefined && (
          <div className="card">
            <h2>Personal</h2>
            {row('Date of birth', e.dateOfBirth ? hrDate(e.dateOfBirth) : null)}{row('Personal email', e.personalEmail)}{row('Address', e.address)}{row('Emergency contact', e.emergencyName ? `${e.emergencyName}${e.emergencyPhone ? `, ${e.emergencyPhone}` : ''}` : null)}
            {e.can.sensitive && (
              <>
                {row('PAN', e.panLast4 ? `•••••${e.panLast4}` : null)}{row('Bank account', e.bankLast4 ? `••••${e.bankLast4}` : null)}{row('Yearly salary (CTC)', e.ctcPaise != null ? inr(e.ctcPaise) : null)}
                <div className="row end" style={{ marginTop: 10 }}><button className="btn sm outline" onClick={reveal}>Show and change PAN, bank, salary</button></div>
              </>
            )}
          </div>
        )}
        {groups.map(([k, tasks]) => (
          <div key={k} className="card">
            <div className="org-head"><h2 style={{ margin: 0 }}>{k === 'onboarding' ? 'Joining checklist' : 'Leaving checklist'}</h2><span className="small muted">{tasks.filter((t) => t.doneAt).length} of {tasks.length} done</span></div>
            {tasks.map((t) => <label key={t.id} className="hr-task"><input type="checkbox" disabled={!e.can.manage} checked={!!t.doneAt} onChange={(x) => run(() => api(`/api/v1/hr/tasks/${t.id}`, { method: 'PATCH', body: { done: x.target.checked } }), x.target.checked ? 'Ticked off.' : 'Unticked.')} /> <span className={t.doneAt ? 'muted' : ''}>{t.title}</span></label>)}
            {e.can.manage && <button className="btn sm ghost" onClick={async () => { const title = await askText('Add a checklist item'); if (title) run(() => api(`/api/v1/hr/employees/${id}/tasks`, { method: 'POST', body: { title, kind: k } }), 'Item added.'); }}>Add item</button>}
          </div>
        ))}
        {e.can.sensitive && (
          <div className="card">
            <div className="org-head"><h2 style={{ margin: 0 }}>Documents</h2>{meta && <button className="btn sm" onClick={() => setUpload({ docType: meta.docTypes[0], expiresOn: '', file: null })}>Add document</button>}</div>
            {!docs.length && <p className="small muted">No documents yet. Files are stored encrypted.</p>}
            {docs.map((d) => (
              <div key={d.id} className="acc-row" style={d.isArchived ? { opacity: 0.55 } : undefined}>
                <div><b>{d.docType}</b><div className="small muted">{d.fileName} · {Math.max(1, Math.round(d.sizeBytes / 1024))} KB{d.expiresAt ? ` · valid till ${hrDate(d.expiresAt)}` : ''}{d.isArchived ? ' · archived' : ''}</div></div>
                <div className="row" style={{ gap: 4 }}><button className="btn sm ghost" onClick={() => open(d)}>Download</button><button className="btn sm ghost" onClick={() => run(() => api(`/api/v1/hr/documents/${d.id}`, { method: 'PATCH', body: { isArchived: !d.isArchived } }), d.isArchived ? 'Restored.' : 'Archived.')}>{d.isArchived ? 'Restore' : 'Archive'}</button></div>
              </div>
            ))}
          </div>
        )}
        <div className="card">
          <div className="org-head"><h2 style={{ margin: 0 }}>Assets</h2>{meta?.can.assets && <Link className="small" href="/app/hr/assets">Issue from Assets</Link>}</div>
          {!e.assets.length && <p className="small muted">Nothing issued.</p>}
          {e.assets.map((a) => <div key={a.id} className="acc-row"><div><b>{a.asset.name}</b><div className="small muted">{a.asset.tag} · since {hrDate(a.issuedAt)}{a.returnedAt ? ` · returned ${hrDate(a.returnedAt)} (${a.returnCondition})` : ''}</div></div><span className={`badge ${a.returnedAt ? 'grey' : 'ok'}`}>{a.returnedAt ? 'Returned' : 'With them'}</span></div>)}
        </div>
      </div>
      {editing && meta && <EmployeeForm title="Edit employee" meta={meta} initial={draft} linkable={[...(e.userId && e.user ? [{ id: e.userId, name: e.user.name, email: '' }] : []), ...meta.unlinkedUsers]} personal onClose={() => setEditing(false)} onSave={async (d) => { try { const { draftBody } = await import('@/components/hr/hr'); await api(`/api/v1/hr/employees/${id}`, { method: 'PUT', body: draftBody(d, true) }); setEditing(false); await load(); setMsg({ type: 'notice', text: 'Saved.' }); return null; } catch (x) { return x instanceof ApiError ? x.message : 'Failed'; } }} />}
      {secret && (
        <div className="modal-bg">
          <form className="modal" onSubmit={saveSecret}>
            <h2>PAN, bank and salary</h2>
            <p className="small muted" style={{ marginTop: -6 }}>Stored encrypted. Opening this was recorded in the audit log.</p>
            <div className="field"><label htmlFor="s-pan">PAN</label><input id="s-pan" className="input" autoComplete="off" value={secret.pan} onChange={(x) => setSecret({ ...secret, pan: x.target.value.toUpperCase() })} /></div>
            <div className="grid cols-2">
              <div className="field"><label htmlFor="s-acc">Bank account number</label><input id="s-acc" className="input" autoComplete="off" inputMode="numeric" value={secret.account} onChange={(x) => setSecret({ ...secret, account: x.target.value })} /></div>
              <div className="field"><label htmlFor="s-ifsc">IFSC</label><input id="s-ifsc" className="input" autoComplete="off" value={secret.ifsc} onChange={(x) => setSecret({ ...secret, ifsc: x.target.value.toUpperCase() })} /></div>
            </div>
            <div className="field"><label htmlFor="s-ctc">Yearly salary (CTC) ₹</label><input id="s-ctc" className="input" inputMode="decimal" value={secret.ctc} onChange={(x) => setSecret({ ...secret, ctc: x.target.value })} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setSecret(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
      {upload && meta && (
        <div className="modal-bg">
          <form className="modal" onSubmit={sendDoc}>
            <h2>Add document</h2>
            <div className="field"><label htmlFor="d-t">Type</label><select id="d-t" className="input" value={upload.docType} onChange={(x) => setUpload({ ...upload, docType: x.target.value })}>{meta.docTypes.map((t) => <option key={t}>{t}</option>)}</select></div>
            <div className="field"><label htmlFor="d-f">File (PDF, JPG or PNG, up to 5 MB)</label><input id="d-f" className="input" type="file" required accept="application/pdf,image/jpeg,image/png" onChange={(x) => setUpload({ ...upload, file: x.target.files?.[0] ?? null })} /></div>
            <div className="field"><label htmlFor="d-e">Valid till (optional)</label><input id="d-e" className="input" type="date" value={upload.expiresOn} onChange={(x) => setUpload({ ...upload, expiresOn: x.target.value })} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setUpload(null)}>Go back</button><button className="btn">Upload</button></div>
          </form>
        </div>
      )}
    </>
  );
}
