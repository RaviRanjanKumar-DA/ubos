'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import readXlsxFile from 'read-excel-file';
import { parseCsv, toCsv } from '@ubos/shared';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { askConfirm } from '@/components/Dialogs';
import { istDay } from '@/lib/ist';

interface Task { id: string; title: string; type: string; dueAt: string; assigneeId: string; assignee: string | null; leadId: string | null; leadName: string | null }
interface Result { row: number; status: 'ok' | 'error'; message?: string; title?: string }
const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const cellText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v === null || v === undefined ? '' : String(v).trim());
const COLS: Record<string, string[]> = { lead: ['lead', 'mobile', 'leadmobile', 'email'], assignee: ['assignee', 'assignedto', 'user', 'owner'], title: ['title', 'task'], type: ['type'], due: ['due', 'duedate', 'date', 'when'], durationMin: ['duration', 'durationmin', 'minutes'], notes: ['notes', 'note', 'details'] };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** Bulk cancel open tasks, and bulk upload tasks from a sheet. */
export default function BulkTasks() {
  const { can, version } = useShell();
  const [tab, setTab] = useState<'cancel' | 'upload'>(can('crm.lead.import') ? 'upload' : 'cancel');
  const [f, setF] = useState({ from: istDay(new Date(Date.now() - 30 * 86_400_000)), to: istDay(new Date(Date.now() + 60 * 86_400_000)) });
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [report, setReport] = useState<{ dryRun: boolean; ok: number; failed: number; results: Result[] } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(() => api<Task[]>(`/api/v1/tasks?status=open&from=${f.from}T00:00:00%2B05:30&to=${f.to}T23:59:59%2B05:30`).then((t) => { setTasks(t); setPicked(new Set()); }).catch((e) => setMsg({ type: 'error', text: e.message })), [f]);
  useEffect(() => { if (tab === 'cancel') load(); }, [load, tab, version]);
  const cancel = async () => {
    if (!(await askConfirm(`Cancel ${picked.size} task(s)? They are marked cancelled and leave every to-do list.`, 'Cancel tasks'))) return;
    try { const r = await api<{ cancelled: number; skipped: number }>('/api/v1/tasks/cancel', { method: 'POST', body: { taskIds: [...picked] } }); setMsg({ type: 'notice', text: `${r.cancelled} task(s) cancelled.${r.skipped ? ` ${r.skipped} could not be cancelled by you.` : ''}` }); load(); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  };
  const read = async (file: File) => {
    setMsg(null); setReport(null); setRows(null);
    try {
      let data: string[][];
      if (/\.xlsx$/i.test(file.name)) data = (await readXlsxFile(file)).map((r) => r.map(cellText));
      else if (/\.(csv|txt)$/i.test(file.name)) data = parseCsv(await file.text());
      else throw new Error('Choose a .csv or .xlsx file');
      data = data.filter((r) => r.some((c) => c));
      if (data.length < 2) throw new Error('The file needs a header row and at least one task');
      if (data.length - 1 > 2000) throw new Error('Up to 2,000 tasks per file');
      const head = data[0].map(norm);
      const idx = Object.fromEntries(Object.entries(COLS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
      if (idx.assignee < 0 || idx.title < 0 || idx.due < 0) throw new Error('The file needs Assignee, Title and Due columns (download the template)');
      setRows(data.slice(1).map((r) => Object.fromEntries(Object.entries(idx).filter(([, i]) => i >= 0 && r[i]).map(([k, i]) => [k, r[i]]))));
    } catch (e) { setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Could not read the file' }); }
  };
  const run = async (dryRun: boolean) => {
    if (!rows) return;
    try { const r = await api<typeof report & object>('/api/v1/tasks/import', { method: 'POST', body: { dryRun, rows } }); setReport(r); if (!dryRun) { setMsg({ type: 'notice', text: `${r.ok} task(s) created.` }); setRows(null); } } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  };
  const template = () => {
    const csv = toCsv([['Assignee', 'Title', 'Due', 'Type', 'Lead', 'Duration', 'Notes'], ['arjun', 'Call back about the quote', '2026-12-01 11:00', 'call', '9876511111', '', 'Ask about budget'], ['manager@mycompany.local', 'Site visit', '02/12/2026 16:30', 'meeting', '', '60', 'Sector 21']]);
    const u = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); Object.assign(document.createElement('a'), { href: u, download: 'tasks-template.csv' }).click(); URL.revokeObjectURL(u);
  };

  return (
    <>
      <div className="page-head"><div><div className="small"><Link href="/app/bulk">Bulk tools</Link></div><h1>Tasks in bulk</h1></div></div>
      <div className="dash-tabs" role="tablist">
        {can('crm.lead.import') && <button role="tab" aria-selected={tab === 'upload'} className={`dash-tab${tab === 'upload' ? ' on' : ''}`} onClick={() => setTab('upload')}>Upload tasks</button>}
        <button role="tab" aria-selected={tab === 'cancel'} className={`dash-tab${tab === 'cancel' ? ' on' : ''}`} onClick={() => setTab('cancel')}>Cancel tasks</button>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      {tab === 'upload' && (
        <div className="card">
          <p className="small muted" style={{ marginTop: 0 }}>Columns: <b>Assignee</b> (email, username or name), <b>Title</b>, <b>Due</b> (India time, e.g. 2026-12-01 11:00 or 01/12/2026 11:00), and optionally Type (task, meeting, call), Lead (mobile or email), Duration (minutes), Notes. Everything is checked before anything is saved.</p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input type="file" accept=".csv,.xlsx,.txt" aria-label="Choose a file" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
            <button className="btn ghost sm" onClick={template}>Download template</button>
          </div>
          {rows && <div className="row" style={{ marginTop: 12, gap: 8 }}><span className="small">{rows.length} task(s) read.</span><button className="btn outline sm" onClick={() => run(true)}>Check</button><button className="btn sm" disabled={!report?.dryRun || report.failed > 0} onClick={() => run(false)} title={report?.failed ? 'Fix the rows with problems first' : undefined}>Create tasks</button></div>}
          {report && (
            <div className="table-wrap" style={{ marginTop: 12, maxHeight: 360, overflowY: 'auto' }}>
              <div className="small" style={{ marginBottom: 6 }}><b>{report.ok}</b> ready{report.failed ? <>, <b className="kpi-bad">{report.failed}</b> with problems</> : ''}{report.dryRun ? ' (nothing saved yet)' : ''}</div>
              <table className="table compact"><thead><tr><th>Row</th><th>Task</th><th>Result</th></tr></thead>
                <tbody>{report.results.map((x) => <tr key={x.row}><td>{x.row}</td><td>{x.title}</td><td className={x.status === 'error' ? 'kpi-bad small' : 'small'}>{x.status === 'ok' ? 'OK' : x.message}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'cancel' && (
        <>
          <div className="card report-filters">
            <label className="small">Due from</label><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
            <label className="small">to</label><input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
            {picked.size > 0 && <button className="btn danger sm" onClick={cancel}>Cancel {picked.size} task(s)</button>}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th style={{ width: 34 }}><input type="checkbox" aria-label="Select all" checked={!!tasks?.length && picked.size === tasks.length} onChange={() => setPicked(picked.size === tasks?.length ? new Set() : new Set(tasks?.map((t) => t.id)))} /></th><th>Task</th><th>Due</th><th>Assigned to</th><th>Lead</th></tr></thead>
                <tbody>
                  {tasks?.map((t) => (
                    <tr key={t.id}>
                      <td><input type="checkbox" aria-label={`Select ${t.title}`} checked={picked.has(t.id)} onChange={() => { const s = new Set(picked); if (s.has(t.id)) s.delete(t.id); else s.add(t.id); setPicked(s); }} /></td>
                      <td><b>{t.title}</b><div className="small muted">{t.type}</div></td>
                      <td className="small">{when(t.dueAt)}</td>
                      <td className="small">{t.assignee ?? '—'}</td>
                      <td className="small">{t.leadId ? <Link href={`/app/leads/${t.leadId}`}>{t.leadName ?? 'Lead'}</Link> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {tasks && !tasks.length && <div className="empty">No open tasks in these dates.</div>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
