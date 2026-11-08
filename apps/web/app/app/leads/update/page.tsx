'use client';

import { useState } from 'react';
import Link from 'next/link';
import readXlsxFile from 'read-excel-file';
import { parseCsv, toCsv } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';

type Mode = 'update' | 'activities' | 'export';
type Match = 'mobile' | 'email' | 'customer_code';
interface Result { row: number; status: 'ok' | 'error'; message?: string; name?: string; changes?: string[] }
interface Report { dryRun: boolean; ok: number; errors: number; updated?: number; created?: number; results: Result[] }

const cellText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v === null || v === undefined ? '' : String(v).trim());
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const KEY_HEADERS: Record<Match, string[]> = { mobile: ['mobile', 'phone', 'mobileno', 'mobilenumber', 'leadid'], email: ['email', 'emailid', 'leadid'], customer_code: ['customerid', 'customercode', 'code'] };
const UPDATE_COLS: Record<string, string[]> = { stage: ['stage'], status: ['status', 'leadstatus'], owner: ['owner', 'rm', 'assignedto'], source: ['source'], labels: ['labels', 'label', 'tags'], followUp: ['followup', 'followupdate', 'nextfollowup'], remark: ['remark', 'remarks', 'note'] };
const ACT_COLS: Record<string, string[]> = { type: ['type', 'activity', 'activitytype'], date: ['date', 'datetime', 'when', 'calldate'], disposition: ['disposition', 'outcome', 'calloutcome', 'callstatus'], remark: ['remark', 'remarks', 'note', 'notes'], durationMin: ['duration', 'durationmin', 'minutes', 'talktime'], user: ['user', 'by', 'agent', 'rm'] };

/** Update existing leads from Excel / CSV, bring past calls & remarks from another CRM, and export activity. */
export default function DataToolsPage() {
  const { me, can } = useShell();
  const [mode, setMode] = useState<Mode>(me.currentWorkspaceId || !can('crm.lead.export') ? 'update' : 'export');
  const [match, setMatch] = useState<Match>('mobile');
  const [file, setFile] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const [to, setTo] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const [types, setTypes] = useState<string[]>(['call', 'remark', 'action']);

  if (!me.currentWorkspaceId && mode !== 'export') {
    return <div className="notice">Select a workspace (business line) at the top first — updates apply to one business line at a time.{can('crm.lead.export') && <> Or <button className="link-btn" onClick={() => setMode('export')}>export calls & remarks</button>.</>}</div>;
  }

  async function read(f: File) {
    setError(''); setReport(null); setRows(null);
    try {
      let data: string[][];
      if (/\.xlsx$/i.test(f.name)) data = (await readXlsxFile(f)).map((r) => r.map(cellText));
      else if (/\.(csv|txt)$/i.test(f.name)) data = parseCsv(await f.text());
      else throw new Error('Please choose a .csv or .xlsx file');
      data = data.filter((r) => r.some((c) => c));
      if (data.length < 2) throw new Error('The file needs a header row and at least one row');
      if (data.length - 1 > 5000) throw new Error('Up to 5,000 rows per file');
      const head = data[0].map(norm);
      const keyIdx = head.findIndex((h) => KEY_HEADERS[match].includes(h));
      if (keyIdx < 0) throw new Error(`No ${match === 'customer_code' ? 'Customer ID' : match} column found (download the template)`);
      const cols = mode === 'update' ? UPDATE_COLS : ACT_COLS;
      const idx = Object.fromEntries(Object.entries(cols).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
      // Any other column is a custom field (header = field key or label in "cf:key" form).
      const used = new Set([keyIdx, ...Object.values(idx)]);
      const extra = head.map((h, i) => [h, i] as const).filter(([, i]) => !used.has(i) && data[0][i]);
      setRows(data.slice(1).map((r) => {
        const o: Record<string, unknown> = { key: r[keyIdx] ?? '' };
        for (const [k, i] of Object.entries(idx)) if (i >= 0 && r[i]) o[k] = r[i];
        if (mode === 'update' && extra.length) {
          const fields = Object.fromEntries(extra.map(([, i]) => [data[0][i].replace(/^cf:/i, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'), r[i] ?? '']).filter(([, v]) => v));
          if (Object.keys(fields).length) o.fields = fields;
        }
        return o;
      }));
      setFile(f.name);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the file'); }
  }

  async function run(dryRun: boolean) {
    if (!rows) return;
    setBusy(true); setError('');
    try {
      const r = await api<Report>(mode === 'update' ? '/api/v1/leads/bulk-update' : '/api/v1/leads/activities-import', { method: 'POST', body: { dryRun, match, rows } });
      setReport(r);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Failed'); }
    setBusy(false);
  }

  function template() {
    const key = match === 'customer_code' ? 'Customer ID' : match === 'email' ? 'Email' : 'Mobile';
    const csv = mode === 'update'
      ? toCsv([[key, 'Stage', 'Status', 'Owner', 'Source', 'Labels', 'Follow-up', 'Remark', 'city'], [match === 'mobile' ? '9876500020' : match === 'email' ? 'name@example.com' : 'C00005', 'Interested', 'Hot', 'rm@mycompany.local', '', 'VIP', '25/10/2026', 'Called, wants a visit', 'Pune']])
      : toCsv([[key, 'Type', 'Date', 'Outcome', 'Minutes', 'Remark', 'User'], [match === 'mobile' ? '9876500020' : 'C00005', 'call', '2026-09-01 11:30', 'Connected', '4', 'Discussed fees', 'rm@mycompany.local'], [match === 'mobile' ? '9876500020' : 'C00005', 'remark', '02/09/2026', '', '', 'Sent brochure on WhatsApp', '']]);
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: mode === 'update' ? 'update-leads-template.csv' : 'past-activity-template.csv' }).click();
    URL.revokeObjectURL(url);
  }

  async function exportActivity() {
    setError('');
    try {
      const blob = await api<Blob>(`/api/v1/activities/export?from=${from}&to=${to}${types.length ? `&types=${types.join(',')}` : ''}`);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: `activities-${from}-to-${to}.csv` }).click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed'); }
  }

  const reset = (m: Mode) => { setMode(m); setRows(null); setReport(null); setFile(''); setError(''); };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link href="/app/leads">Leads</Link> /</div>
          <h1>Bulk update & data tools</h1>
          <div className="small muted">Change many existing leads from a sheet, bring history from another CRM, or export calls and remarks.</div>
        </div>
      </div>
      <div className="dash-tabs" style={{ marginBottom: 14 }}>
        {can('crm.lead.import') && <button className={`dash-tab ${mode === 'update' ? 'on' : ''}`} onClick={() => reset('update')}>Update existing leads</button>}
        {can('crm.lead.import') && <button className={`dash-tab ${mode === 'activities' ? 'on' : ''}`} onClick={() => reset('activities')}>Import past calls & remarks</button>}
        {can('crm.lead.export') && <button className={`dash-tab ${mode === 'export' ? 'on' : ''}`} onClick={() => reset('export')}>Export calls & remarks</button>}
      </div>
      {error && <div className="error">{error}</div>}

      {mode !== 'export' && (
        <div className="card">
          <div className="steps" style={{ marginBottom: 12 }}>
            {['Upload file', 'Check', 'Apply'].map((s, i) => { const at = !rows ? 0 : !report || report.dryRun ? (report ? 2 : 1) : 3; return <div key={s} className={`step ${at === i ? 'active' : at > i ? 'done' : ''}`}><span className="num">{at > i ? '✓' : i + 1}</span>{s}</div>; })}
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            {mode === 'update'
              ? 'One row per lead. Leave a cell empty to keep the current value. Columns: Stage, Status, Owner (email), Source, Labels (separated by ;), Follow-up date, Remark, and any custom field by its name. Stage rules and your field access still apply.'
              : 'One row per call or remark: Type (call / remark), Date, Outcome (for calls), Minutes, Remark, User (email). Original dates and authors are kept on the lead journey.'}
          </p>
          <div className="row" style={{ marginBottom: 10 }}>
            <label className="small">Find leads by
              <select className="input" style={{ width: 'auto', marginLeft: 6 }} value={match} onChange={(e) => { setMatch(e.target.value as Match); setRows(null); setReport(null); }}>
                <option value="mobile">Mobile</option><option value="email">Email</option><option value="customer_code">Customer ID</option>
              </select>
            </label>
            <label className="btn outline">Choose CSV / Excel file<input type="file" accept=".csv,.xlsx,.txt" hidden onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} /></label>
            <button className="btn ghost sm" onClick={template}>Download template</button>
            {file && <span className="small">{file} · {rows?.length} row(s)</span>}
          </div>
          {report && (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="badge ok">{report.ok} ready</span>
                {report.errors > 0 && <span className="badge bad">{report.errors} with problems</span>}
                {!report.dryRun && <span className="badge">{report.updated ?? report.created} applied</span>}
              </div>
              <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
                <table className="table compact">
                  <thead><tr><th>Row</th><th>Lead</th><th>Result</th></tr></thead>
                  <tbody>
                    {report.results.map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td><td>{r.name ?? '—'}</td>
                        <td>{r.status === 'ok' ? <span className="small">{(r.changes ?? []).join(' · ')}</span> : <span className="small" style={{ color: 'var(--bad)' }}>{r.message}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="row end" style={{ marginTop: 12 }}>
            {(!report || !report.dryRun) && <button className="btn" disabled={!rows || busy} onClick={() => run(true)}>{busy ? 'Checking…' : 'Check rows'}</button>}
            {report?.dryRun && <button className="btn outline" onClick={() => setReport(null)}>Back</button>}
            {report?.dryRun && <button className="btn" disabled={!report.ok || busy} onClick={() => run(false)}>{busy ? 'Applying…' : `Apply ${report.ok} row(s)`}</button>}
          </div>
        </div>
      )}

      {mode === 'export' && (
        <div className="card" style={{ maxWidth: 620 }}>
          <h2>Export calls, remarks and actions</h2>
          <p className="small muted">Only leads you are allowed to export; mobiles follow your field access. Every export is on the audit log.</p>
          <div className="row" style={{ marginBottom: 10 }}>
            <label className="small">From <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="small">To <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <div className="chips" style={{ marginBottom: 12 }}>
            {[['call', 'Calls'], ['remark', 'Remarks'], ['action', 'Custom actions'], ['stage', 'Stage moves'], ['status', 'Status changes'], ['assignment', 'Assignments'], ['task', 'Tasks & meetings']].map(([k, l]) => (
              <button key={k} className={`chip ${types.includes(k) ? 'on' : ''}`} onClick={() => setTypes(types.includes(k) ? types.filter((x) => x !== k) : [...types, k])}>{l}</button>
            ))}
          </div>
          <button className="btn" onClick={exportActivity}>⬇ Download CSV</button>
        </div>
      )}
    </>
  );
}
