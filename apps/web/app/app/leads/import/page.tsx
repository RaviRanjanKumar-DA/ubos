'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import readXlsxFile from 'read-excel-file';
import { guessMapping, IMPORT_TARGETS, parseCsv, toCsv } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import type { WorkspaceSettings } from '@/lib/workspace';

type Step = 1 | 2 | 3 | 4 | 5;
interface PreviewRow { row: number; status: 'new' | 'linked' | 'duplicate' | 'error'; message?: string; name?: string; mobile?: string }
interface Summary { total: number; new: number; linked: number; duplicates: number; errors: number; willImport: number }
interface Result { total: number; created: number; linked: number; skipped: number; failed: number; errors: { row: number; message: string }[] }

const STEPS = ['Upload file', 'Match columns', 'Settings', 'Check', 'Done'];
const STATUS_TEXT: Record<PreviewRow['status'], [string, string]> = {
  new: ['New customer', 'ok'], linked: ['Existing customer', ''], duplicate: ['Duplicate', 'warn'], error: ['Error', 'bad'],
};
const MAX_ROWS = 5000;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}
const cellText = (v: unknown) =>
  v instanceof Date ? `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${v.getFullYear()}` : v === null || v === undefined ? '' : String(v).trim();

export default function ImportPage() {
  const { me } = useShell();
  const [step, setStep] = useState<Step>(1);
  const [ws, setWs] = useState<WorkspaceSettings | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [data, setData] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [opts, setOpts] = useState({ pipelineId: '', defaultSource: '', mode: 'rules' as 'me' | 'users' | 'rules', userIds: [] as string[], skipDuplicates: true });
  const [preview, setPreview] = useState<{ summary: Summary; rows: PreviewRow[] } | null>(null);
  const [filter, setFilter] = useState<PreviewRow['status'] | ''>('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me.currentWorkspaceId) return;
    api<WorkspaceSettings>(`/api/v1/workspaces/${me.currentWorkspaceId}/settings`).then((s) => {
      setWs(s);
      setOpts((o) => ({ ...o, pipelineId: s.pipelines[0]?.id ?? '', defaultSource: s.sources.find((x) => x.value === 'manual')?.value ?? s.sources[0]?.value ?? '' }));
    }).catch((e) => setError(e.message));
    api<{ id: string; name: string }[]>(`/api/v1/workspaces/${me.currentWorkspaceId}/assignees`).then(setPeople).catch(() => {});
  }, [me.currentWorkspaceId]);

  const fields = useMemo(() => ws?.fields.filter((f) => !f.isArchived) ?? [], [ws]);
  const targets: [string, string][] = [
    ...Object.entries(IMPORT_TARGETS).map(([k, v]) => [k, v.label] as [string, string]),
    ...fields.map((f) => [`cf:${f.key}`, `${f.label}${f.required ? ' *' : ''}`] as [string, string]),
  ];
  const mapped = new Set(mapping.filter(Boolean));
  const missingRequired = ['name', ws?.leadIdentifier === 'email' ? 'email' : 'mobile', ...fields.filter((f) => f.required).map((f) => `cf:${f.key}`)].filter((k) => !mapped.has(k));

  if (!me.currentWorkspaceId) return <div className="notice">Select a workspace (business line) at the top first — leads are uploaded into one business line at a time.</div>;

  async function readFile(file: File) {
    setError('');
    try {
      let rows: string[][];
      if (/\.xlsx$/i.test(file.name)) rows = (await readXlsxFile(file)).map((r) => r.map(cellText));
      else if (/\.(csv|txt)$/i.test(file.name)) rows = parseCsv(await file.text());
      else throw new Error('Please choose a .csv or .xlsx file (old .xls: open in Excel and save as .xlsx)');
      rows = rows.filter((r) => r.some((c) => c));
      if (rows.length < 2) throw new Error('The file needs a header row and at least one lead');
      if (rows.length - 1 > MAX_ROWS) throw new Error(`Up to ${MAX_ROWS} leads per upload — this file has ${rows.length - 1}. Split it into smaller files.`);
      setFileName(file.name);
      setHeaders(rows[0]);
      setData(rows.slice(1));
      setMapping(guessMapping(rows[0], fields));
      setPreview(null);
      setResult(null);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file');
    }
  }

  const body = () => ({
    fileName, pipelineId: opts.pipelineId, defaultSource: opts.defaultSource, skipDuplicates: opts.skipDuplicates,
    assign: { mode: opts.mode, userIds: opts.userIds },
    rows: data.map((r) => Object.fromEntries(mapping.map((t, i) => [t, r[i] ?? '']).filter(([t]) => t))),
  });

  async function runPreview() {
    setBusy(true); setError('');
    try { setPreview(await api('/api/v1/leads/import/preview', { method: 'POST', body: body() })); setFilter(''); setStep(4); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Check failed'); }
    finally { setBusy(false); }
  }
  async function runImport() {
    setBusy(true); setError('');
    try { setResult(await api('/api/v1/leads/import/commit', { method: 'POST', body: body() })); setStep(5); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Import failed'); }
    finally { setBusy(false); }
  }
  const sample = () => download(`${ws?.name ?? 'leads'}-sample.csv`, toCsv([
    ['Name', 'Mobile', 'Email', 'City', 'Source', 'Status', 'Remark', 'Follow up', ...fields.map((f) => f.label)],
    ['Rahul Mehta', '98765 43210', 'rahul@example.com', 'Delhi', 'Website', 'Hot', 'Asked for price list', '05/11/2026', ...fields.map((f) => f.options[0] ?? '')],
  ]));
  const errorReport = (list: { row: number; message: string }[]) =>
    download(`${fileName.replace(/\.\w+$/, '')}-errors.csv`, toCsv([['Row in file', 'Problem', ...headers], ...list.map((e) => [e.row, e.message, ...(data[e.row - 2] ?? [])])]));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link href="/app/leads">Leads</Link> /</div>
          <h1>Bulk upload · {ws?.name}</h1>
          <div className="muted small">Upload up to {MAX_ROWS.toLocaleString('en-IN')} leads from Excel or CSV. Nothing is saved until the last step.</div>
        </div>
      </div>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s} className={`step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}`}>
            <span className="num">{step > i + 1 ? '✓' : i + 1}</span>{s}
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}

      {step === 1 && (
        <div className="card" style={{ textAlign: 'center', padding: 36 }}>
          <label style={{ display: 'block', border: '2px dashed var(--brand-100)', borderRadius: 12, padding: '36px 16px', cursor: 'pointer', background: 'var(--brand-50)' }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readFile(f); }}>
            <div style={{ fontSize: 34 }}>⬆</div>
            <b>Drop your Excel (.xlsx) or CSV file here</b>
            <div className="small muted" style={{ margin: '6px 0 12px' }}>or</div>
            <span className="btn">Choose file</span>
            <input type="file" accept=".csv,.xlsx,.txt" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; }} />
          </label>
          <p className="small muted" style={{ marginTop: 14 }}>
            The first row must contain column names. Name and Mobile are required{fields.some((f) => f.required) ? `, plus ${fields.filter((f) => f.required).map((f) => f.label).join(', ')}` : ''}.{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); sample(); }}>Download a sample file</a>
          </p>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>Match your columns · {fileName} · {data.length} rows</h2>
          <p className="small muted" style={{ marginTop: -4 }}>We matched what we could. Check each column and choose where it should go, or ignore it.</p>
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 620 }}>
              <thead><tr><th>Column in your file</th><th>Sample values</th><th>Goes to</th></tr></thead>
              <tbody>
                {headers.map((h, i) => (
                  <tr key={i}>
                    <td><b>{h || `(column ${i + 1})`}</b></td>
                    <td className="small muted">{data.slice(0, 3).map((r) => r[i]).filter(Boolean).join(' · ') || '—'}</td>
                    <td>
                      <select className="input" style={{ width: 230 }} value={mapping[i] ?? ''} onChange={(e) => setMapping(mapping.map((m, j) => (j === i ? e.target.value : m === e.target.value && e.target.value ? '' : m)))}>
                        <option value="">— Ignore this column —</option>
                        {targets.map(([k, l]) => <option key={k} value={k}>{l}{mapped.has(k) && mapping[i] !== k ? ' (used)' : ''}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missingRequired.length > 0 && <div className="error" style={{ marginTop: 12 }}>Still needed: {missingRequired.map((k) => targets.find(([t]) => t === k)?.[1].replace(' *', '') ?? k).join(', ')}</div>}
          <div className="row end" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn" disabled={missingRequired.length > 0} onClick={() => setStep(3)}>Continue</button>
          </div>
        </div>
      )}

      {step === 3 && ws && (
        <div className="card" style={{ maxWidth: 640 }}>
          <h2>Settings</h2>
          <div className="grid cols-2">
            <div className="field">
              <label>Pipeline</label>
              <select className="input" value={opts.pipelineId} onChange={(e) => setOpts({ ...opts, pipelineId: e.target.value })}>
                {ws.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Source (when the file has none)</label>
              <select className="input" value={opts.defaultSource} onChange={(e) => setOpts({ ...opts, defaultSource: e.target.value })}>
                {ws.sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Who gets these leads?</label>
            {([
              ['rules', 'Use this business line\'s assignment rules', 'Returning customers go back to their RM; others follow the round-robin set in Workspace settings.'],
              ['users', 'Share equally between people I choose', 'Round-robin between the selected people.'],
              ['me', 'Assign all to me', ''],
            ] as ['me' | 'users' | 'rules', string, string][]).map(([k, l, h]) => (
              <label key={k} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', marginBottom: 6 }}>
                <input type="radio" name="mode" checked={opts.mode === k} onChange={() => setOpts({ ...opts, mode: k })} style={{ marginTop: 3 }} />
                <span>{l}{h && <span className="small muted" style={{ display: 'block' }}>{h}</span>}</span>
              </label>
            ))}
            {opts.mode === 'users' && (
              <div className="chips" style={{ marginTop: 6 }}>
                {people.map((p) => (
                  <button type="button" key={p.id} className={`chip ${opts.userIds.includes(p.id) ? 'on' : ''}`}
                    onClick={() => setOpts({ ...opts, userIds: opts.userIds.includes(p.id) ? opts.userIds.filter((x) => x !== p.id) : [...opts.userIds, p.id] })}>{p.name}</button>
                ))}
              </div>
            )}
            <span className="small muted">An "Owner" column in the file always wins.</span>
          </div>
          <label className="row small" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={opts.skipDuplicates} onChange={(e) => setOpts({ ...opts, skipDuplicates: e.target.checked })} />
            Skip customers who already have an open lead in {ws.name} (recommended)
          </label>
          <div className="row end">
            <button className="btn ghost" onClick={() => setStep(2)}>Back</button>
            <button className="btn" disabled={busy || (opts.mode === 'users' && !opts.userIds.length)} onClick={runPreview}>{busy ? 'Checking…' : 'Check file'}</button>
          </div>
        </div>
      )}

      {step === 4 && preview && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div className="card kpi"><div className="label">Will be imported</div><div className="value" style={{ color: 'var(--ok)' }}>{preview.summary.willImport}</div></div>
            <div className="card kpi"><div className="label">Existing customers (linked)</div><div className="value">{preview.summary.linked}</div></div>
            <div className="card kpi"><div className="label">Duplicates</div><div className="value" style={{ color: 'var(--warn)' }}>{preview.summary.duplicates}</div></div>
            <div className="card kpi"><div className="label">Rows with errors</div><div className="value" style={{ color: preview.summary.errors ? 'var(--bad)' : undefined }}>{preview.summary.errors}</div></div>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between', padding: 12 }}>
              <div className="chips">
                {(['', 'new', 'linked', 'duplicate', 'error'] as const).map((s) => (
                  <button key={s} className={`chip ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)}>
                    {s ? STATUS_TEXT[s][0] : 'All rows'} <span className="count">{s ? preview.rows.filter((r) => r.status === s).length : preview.rows.length}</span>
                  </button>
                ))}
              </div>
              {preview.summary.errors > 0 && <button className="btn sm outline" onClick={() => errorReport(preview.rows.filter((r) => r.status === 'error').map((r) => ({ row: r.row, message: r.message ?? '' })))}>Download errors</button>}
            </div>
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <table className="table">
                <thead><tr><th>Row</th><th>Name</th><th>Mobile</th><th>Result</th><th>Details</th></tr></thead>
                <tbody>
                  {preview.rows.filter((r) => !filter || r.status === filter).slice(0, 500).map((r) => (
                    <tr key={r.row}>
                      <td className="muted">{r.row}</td><td>{r.name}</td><td>{r.mobile}</td>
                      <td><span className={`badge ${STATUS_TEXT[r.status][1]}`}>{STATUS_TEXT[r.status][0]}</span></td>
                      <td className="small">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="row end" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setStep(2)}>Fix column matching</button>
            <button className="btn" disabled={busy || !preview.summary.willImport} onClick={runImport}>{busy ? 'Importing…' : `Import ${preview.summary.willImport} lead(s)`}</button>
          </div>
        </>
      )}

      {step === 5 && result && (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <h2 style={{ fontSize: 20 }}>{result.created} lead(s) added to {ws?.name}</h2>
          <p className="muted">
            {result.linked} linked to existing customers · {result.skipped} duplicates skipped · {result.failed} rows with errors
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            {result.failed > 0 && <button className="btn outline" onClick={() => errorReport(result.errors)}>Download rows with errors</button>}
            <button className="btn outline" onClick={() => { setStep(1); setResult(null); setPreview(null); }}>Upload another file</button>
            <Link className="btn" href="/app/leads">View leads</Link>
          </div>
        </div>
      )}
    </>
  );
}
