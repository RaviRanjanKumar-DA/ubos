'use client';

import { useEffect, useState } from 'react';
import { IntegrationEvents } from './IntegrationEvents';
import { api, ApiError } from '@/lib/api';
import { IntegrationIcon } from './IntegrationIcon';

interface Field { key: string; label: string; type: 'text' | 'secret' | 'url' | 'select' | 'number'; required?: boolean; help?: string; options?: string[]; optionLabels?: string[]; placeholder?: string }
interface Target { value: string; label: string; required: boolean }
interface Mapping {
  saved: boolean; businessLineSet: boolean; sourceFields: string[]; map: Record<string, string>; duplicateMode: string; defaultSource: string;
  targets: Target[]; leadIdentifier: 'mobile' | 'email'; duplicateModes: { value: string; label: string }[];
}
interface Setup {
  key: string; name: string; description: string; category: string; phase: string; status: string; activatedAt: string | null; verifyToken?: string | null;
  steps: string[]; where: string | null; fields: Field[]; values: Record<string, string>; configured: boolean; webhookUrl: string | null; needsWebhook: boolean;
  mapping: Mapping | null;
}
interface Preview { lead: Record<string, unknown> & { customFields: Record<string, unknown> }; errors: string[]; existing: { customerCode: string; customerName: string; openLeadId: string | null } | null; outcome: string }
type Msg = { type: 'error' | 'notice'; text: string } | null;

const OUTCOME: Record<string, string> = {
  rejected: 'Would be rejected — fix the problems below',
  new_lead_new_customer: 'Creates a new customer and a new lead',
  new_lead_existing_customer: 'Creates a new lead for an existing customer',
  add_remark: 'Adds the enquiry as a remark on the existing open lead',
  update_blank: 'Fills the empty fields of the existing open lead',
  overwrite: 'Replaces fields on the existing open lead',
  skip: 'Skipped — this person already has an open lead',
};
const SAMPLE: Record<string, string> = { name: 'Rahul Mehta', mobile: '9812345678', email: 'rahul.mehta@example.com', city: 'Jaipur', remark: 'Interested, please call in the evening' };

/** A small ⓘ button that shows help text. */
function Info({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info" onMouseLeave={() => setOpen(false)}>
      <button type="button" className="info-btn" aria-label="More information" onClick={() => setOpen(!open)} onMouseEnter={() => setOpen(true)}>i</button>
      {open && <span className="info-pop" role="tooltip">{text}</span>}
    </span>
  );
}

/** Side panel to set up one integration: 1) connect (keys, webhook) 2) map incoming fields to lead fields. */
export function IntegrationSetup({ id, canManage, onClose, onChanged }: { id: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const [s, setS] = useState<Setup | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'connect' | 'map' | 'activity'>('connect');
  const [guide, setGuide] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = () => api<Setup>(`/api/v1/integrations/${id}/setup`, { noWorkspace: true }).then((r) => { setS(r); setValues(r.values); setGuide((g) => g || !r.configured); }).catch((e) => setMsg({ type: 'error', text: e.message }));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(activate: boolean) {
    setBusy(true); setMsg(null);
    try {
      await api(`/api/v1/integrations/${id}/setup`, { method: 'PUT', noWorkspace: true, body: { values, activate } });
      await load();
      onChanged();
      setMsg({ type: 'notice', text: activate ? 'Saved and activated.' : 'Settings saved.' });
      if (s?.mapping) setTab('map');
    } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
    setBusy(false);
  }
  async function deactivate() {
    setBusy(true); setMsg(null);
    try { await api(`/api/v1/integrations/${id}/deactivate`, { method: 'POST', noWorkspace: true }); await load(); onChanged(); setMsg({ type: 'notice', text: 'Deactivated. Settings are kept.' }); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
    setBusy(false);
  }
  const live = s ? /^Live$|Phase 1\b/.test(s.phase) : false;

  return (
    <div className="drawer-bg" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Integration setup">
        {!s && !msg && <div className="muted">Loading…</div>}
        {s && (
          <>
            <div className="row" style={{ flexWrap: 'nowrap', gap: 12, alignItems: 'flex-start' }}>
              <IntegrationIcon id={s.key} name={s.name} size={48} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {s.name}
                  <button type="button" className={`info-btn big ${guide ? 'on' : ''}`} aria-label="Setup guide" title="Setup guide" onClick={() => setGuide(!guide)}>i</button>
                </h2>
                <div className="small muted">{s.category} · {s.description}</div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  {s.status === 'active' ? <span className="badge ok"><span className="dot" />Active</span> : <span className="badge grey">Inactive</span>}
                  <span className="badge">{live ? 'Live connection' : `Live connection: ${s.phase}`}</span>
                  {s.configured && <span className="badge ok">Keys saved</span>}
                  {s.mapping?.saved && <span className="badge ok">Fields mapped</span>}
                </div>
              </div>
              <button className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button>
            </div>

            {guide && (
              <div className="guide-box">
                <b>Setup guide</b>
                <ol className="setup-steps">{s.steps.map((x, i) => <li key={i}>{x}</li>)}{s.mapping && <li>Open “2. Map fields” and match the incoming fields to your lead fields, then test with a sample.</li>}</ol>
                {s.where && <div className="small muted" style={{ marginTop: 6 }}>Where to find the keys: {s.where}</div>}
              </div>
            )}
            {!live && (
              <div className="notice small" style={{ marginTop: 12 }}>
                You can enter keys and map fields now. UBOS starts exchanging data with {s.name} when its live connection ships ({s.phase}); nothing is sent before that.
              </div>
            )}
            {msg && <div className={msg.type}>{msg.text}</div>}

            {s.mapping && (
              <div className="dash-tabs" style={{ margin: '14px 0 4px' }}>
                <button className={`dash-tab ${tab === 'connect' ? 'on' : ''}`} onClick={() => setTab('connect')}>1. Connect</button>
                <button className={`dash-tab ${tab === 'map' ? 'on' : ''}`} onClick={() => setTab('map')}>2. Map fields</button>
                {live && <button className={`dash-tab ${tab === 'activity' ? 'on' : ''}`} onClick={() => setTab('activity')}>3. Activity</button>}
              </div>
            )}

            {tab === 'connect' && (
              <>
                {s.needsWebhook && (
                  <>
                    <h3 className="drawer-h">Your webhook URL <Info text="Paste this address into the other service so it can send new leads / events to UBOS. Keep it private — anyone with it can send data into your account." /></h3>
                    {s.webhookUrl ? (
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <code className="webhook">{s.webhookUrl}</code>
                        <button className="btn sm outline" onClick={() => navigator.clipboard?.writeText(s.webhookUrl!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? 'Copied' : 'Copy'}</button>
                      </div>
                    ) : <p className="small muted">Save the settings once to get your private webhook URL.</p>}
                    {s.verifyToken && <><h3 className="drawer-h">Verify token</h3><code className="webhook">{s.verifyToken}</code></>}
                  </>
                )}
                {s.fields.length > 0 && (
                  <form onSubmit={(e) => { e.preventDefault(); save(s.status !== 'active'); }}>
                    <h3 className="drawer-h">Keys & settings</h3>
                    {s.fields.map((f) => (
                      <div key={f.key} className="field">
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {f.label}{f.required && ' *'}
                          <Info text={f.help ?? (f.type === 'secret' ? `Copy this from your ${s.name} account (${s.where ?? 'settings → API'}). It is stored encrypted and never shown again in full.` : f.key === 'businessLine' ? 'New leads from this service go into this business line; its assignment rules decide the owner.' : `Enter the ${f.label.toLowerCase()} as shown in your ${s.name} account.`)} />
                        </label>
                        {f.type === 'select' ? (
                          <select className="input" value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} disabled={!canManage} required={f.required}>
                            <option value="">{f.required ? 'Choose…' : 'Not set'}</option>
                            {(f.options ?? []).map((o, i) => <option key={o} value={o}>{f.optionLabels?.[i] ?? o}</option>)}
                          </select>
                        ) : (
                          <input className="input" type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'} autoComplete="off"
                            value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.type === 'secret' && values[f.key]?.startsWith('••••') ? 'Saved — type to replace' : f.placeholder} disabled={!canManage}
                            onFocus={(e) => { if (f.type === 'secret' && e.target.value.startsWith('••••')) setValues({ ...values, [f.key]: '' }); }} />
                        )}
                      </div>
                    ))}
                    {canManage ? (
                      <div className="row end" style={{ marginTop: 6 }}>
                        {s.status === 'active' && <button type="button" className="btn ghost" style={{ color: 'var(--bad)' }} onClick={deactivate} disabled={busy}>Deactivate</button>}
                        <button type="button" className="btn outline" onClick={() => save(false)} disabled={busy}>Save</button>
                        {s.status !== 'active' && <button className="btn" disabled={busy}>Save & activate</button>}
                      </div>
                    ) : <p className="small muted">Only organization admins can change integration settings.</p>}
                  </form>
                )}
                <p className="small muted" style={{ marginTop: 14 }}>Keys and passwords are stored encrypted, never shown again in full, and never written to the audit log.</p>
              </>
            )}

            {tab === 'activity' && <IntegrationEvents integrationKey={id} canManage={canManage} />}
            {tab === 'map' && s.mapping && <MapFields id={id} name={s.name} mapping={s.mapping} canManage={canManage} onSaved={() => { load(); setMsg({ type: 'notice', text: 'Field mapping saved.' }); }} />}
          </>
        )}
      </aside>
    </div>
  );
}

function MapFields({ id, name, mapping, canManage, onSaved }: { id: string; name: string; mapping: Mapping; canManage: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<string[]>(mapping.sourceFields);
  const [map, setMap] = useState<Record<string, string>>(mapping.map);
  const [mode, setMode] = useState(mapping.duplicateMode);
  const [source, setSource] = useState(mapping.defaultSource);
  const [newField, setNewField] = useState('');
  const [error, setError] = useState('');
  const [sample, setSample] = useState(() => JSON.stringify(Object.fromEntries(mapping.sourceFields.map((f) => [f, SAMPLE[mapping.map[f]] ?? ''])), null, 2));
  const [preview, setPreview] = useState<Preview | null>(null);
  const targetLabel = (v: string) => mapping.targets.find((t) => t.value === v)?.label ?? v;
  const requiredCf = mapping.targets.filter((t) => t.required).map((t) => t.value);
  const mapped = Object.values(map);

  if (!mapping.businessLineSet) return <div className="notice small" style={{ marginTop: 12 }}>First choose “Put new leads in business line” in step 1 and save — the lead fields to map to depend on it.</div>;

  async function save() {
    setError('');
    try {
      await api(`/api/v1/integrations/${id}/mapping`, { method: 'PUT', noWorkspace: true, body: { sourceFields: rows, map, duplicateMode: mode, defaultSource: source } });
      onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
  }
  async function test() {
    setError(''); setPreview(null);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(sample); } catch { setError('The sample is not valid JSON'); return; }
    try { setPreview(await api<Preview>(`/api/v1/integrations/${id}/mapping/preview`, { method: 'POST', noWorkspace: true, body: { sample: parsed } })); } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
  }

  return (
    <div>
      <h3 className="drawer-h">Incoming field → lead field <Info text={`Each piece of data ${name} sends is copied into the lead field you choose. Your Lead ID (${mapping.leadIdentifier}) and Name must be mapped. Several fields can go to “First remark”; nested fields use dots, e.g. customer.phone.`} /></h3>
      {error && <div className="error">{error}</div>}
      <div className="map-table">
        {rows.map((f) => (
          <div key={f} className="map-row">
            <code className="map-src" title={f}>{f}</code>
            <span aria-hidden="true">→</span>
            <select className="input" value={map[f] ?? 'ignore'} onChange={(e) => setMap({ ...map, [f]: e.target.value })} disabled={!canManage} aria-label={`Lead field for ${f}`}>
              {mapping.targets.map((t) => (
                <option key={t.value} value={t.value} disabled={t.value !== 'ignore' && t.value !== 'remark' && t.value !== map[f] && mapped.includes(t.value)}>
                  {t.label}{t.required ? ' *' : ''}
                </option>
              ))}
            </select>
            {canManage && <button className="btn sm ghost" aria-label={`Remove ${f}`} onClick={() => { setRows(rows.filter((x) => x !== f)); const m = { ...map }; delete m[f]; setMap(m); }}>✕</button>}
          </div>
        ))}
      </div>
      {canManage && (
        <form className="row" style={{ marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); const v = newField.trim(); if (v && !rows.includes(v)) { setRows([...rows, v]); setMap({ ...map, [v]: 'ignore' }); } setNewField(''); }}>
          <input className="input" style={{ flex: 1 }} placeholder="Add an incoming field name, e.g. budget or form question" value={newField} onChange={(e) => setNewField(e.target.value)} />
          <button className="btn sm outline">+ Add</button>
        </form>
      )}
      {requiredCf.some((r) => !mapped.includes(r)) && (
        <p className="small" style={{ color: 'var(--warn)' }}>Required lead fields not mapped: {requiredCf.filter((r) => !mapped.includes(r)).map(targetLabel).join(', ')} — leads without them will be rejected.</p>
      )}

      <h3 className="drawer-h">When the person already has an open lead <Info text="UBOS recognises returning people by your Lead ID (mobile or email, including their other numbers and emails) across every business line." /></h3>
      <div className="dup-modes">
        {mapping.duplicateModes.map((d) => (
          <label key={d.value} className={`dup-mode ${mode === d.value ? 'on' : ''}`}>
            <input type="radio" name="dup" checked={mode === d.value} onChange={() => setMode(d.value)} disabled={!canManage} /> {d.label}
          </label>
        ))}
      </div>
      <div className="field" style={{ marginTop: 10, maxWidth: 260 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>Lead source value <Info text="Stored as the lead’s source so reports can tell where leads came from." /></label>
        <input className="input" value={source} onChange={(e) => setSource(e.target.value)} disabled={!canManage} />
      </div>
      {canManage && <div className="row end"><button className="btn" onClick={save}>Save mapping</button></div>}

      <h3 className="drawer-h">Test with a sample <Info text="Paste an example of what the service sends (JSON). Nothing is saved — you see exactly which lead would be created or updated." /></h3>
      <textarea className="input" style={{ height: 150, paddingTop: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} value={sample} onChange={(e) => setSample(e.target.value)} spellCheck={false} />
      <div className="row end" style={{ marginTop: 6 }}><button className="btn outline" onClick={test} disabled={!mapping.saved} title={mapping.saved ? '' : 'Save the mapping first'}>Run test</button></div>
      {preview && (
        <div className={`card preview-box ${preview.errors.length ? 'bad' : 'ok'}`}>
          <b>{OUTCOME[preview.outcome] ?? preview.outcome}</b>
          {preview.existing && <div className="small muted">Existing customer {preview.existing.customerCode} · {preview.existing.customerName}</div>}
          <dl className="preview-dl">
            {['name', 'mobile', 'email', 'city', 'source', 'remark'].filter((k) => preview.lead[k]).map((k) => [<dt key={`${k}-l`}>{targetLabel(k)}</dt>, <dd key={`${k}-v`}>{String(preview.lead[k])}</dd>])}
            {Object.entries(preview.lead.customFields ?? {}).map(([k, v]) => [<dt key={`${k}-l`}>{targetLabel(`cf:${k}`)}</dt>, <dd key={`${k}-v`}>{Array.isArray(v) ? v.join(', ') : String(v)}</dd>])}
          </dl>
          {preview.errors.map((e) => <div key={e} className="small" style={{ color: 'var(--bad)' }}>• {e}</div>)}
        </div>
      )}
    </div>
  );
}
