'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { PickWorkspace } from '@/components/PickWorkspace';

interface FlowRow { id: string; name: string; trigger: string; idleDays: number | null; isActive: boolean; runCount: number; lastRunAt: string | null; steps: number; runs: Record<string, number> }
interface Opt { value: string; label: string }
const when = (d: string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

/** Flows of the selected business line: what starts them, how many steps, how many leads are in them now. */
export default function FlowsPage() {
  const { me, version } = useShell();
  const router = useRouter();
  const ws = me.currentWorkspaceId;
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  const [triggers, setTriggers] = useState<Opt[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const [f, o] = await Promise.all([api<FlowRow[]>('/api/v1/automation/flows'), api<{ triggers: Opt[]; canManage: boolean }>('/api/v1/automation/options')]);
      setRows(f); setTriggers(o.triggers); setCanManage(o.canManage);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
  }, [ws]);
  useEffect(() => { load(); }, [load, version]);
  if (!ws) return <><div className="page-head"><h1>Flows</h1></div><PickWorkspace text="Flows belong to a business line." /></>;
  const create = async () => {
    try {
      const f = await api<{ id: string }>('/api/v1/automation/flows', { method: 'POST', body: { name: 'New flow', trigger: 'lead.created', graph: { steps: [{ id: Math.random().toString(36).slice(2, 10), type: 'action', action: { type: 'add_remark', text: 'Entered the flow' } }] } } });
      router.push(`/app/automation/flows/${f.id}`);
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Failed'); }
  };
  const toggle = async (f: FlowRow) => { try { await api(`/api/v1/automation/flows/${f.id}`, { method: 'PATCH', body: { isActive: !f.isActive } }); load(); } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Failed'); } };
  const live = (f: FlowRow) => (f.runs.running ?? 0) + (f.runs.waiting ?? 0);

  return (
    <>
      <div className="page-head">
        <div><div className="small"><Link href="/app/automation">Automation</Link></div><h1>Flows</h1><div className="muted small">Draw what happens step by step: actions, waits and if/else paths.</div></div>
        {canManage && <button className="btn" onClick={create}><Icon name="plus" className="ic" />New flow</button>}
      </div>
      {msg && <div className="error">{msg}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Flow</th><th>Starts when</th><th>Steps</th><th>Leads in it now</th><th>Status</th></tr></thead>
            <tbody>
              {rows?.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => router.push(`/app/automation/flows/${f.id}`)}>
                  <td><Link href={`/app/automation/flows/${f.id}`}><b>{f.name}</b></Link><div className="small muted">{f.runCount} {f.runCount === 1 ? 'lead' : 'leads'} so far{f.lastRunAt ? ` · last ${when(f.lastRunAt)}` : ''}</div></td>
                  <td className="small">{triggers.find((t) => t.value === f.trigger)?.label ?? f.trigger}{f.trigger === 'lead.idle' ? ` (${f.idleDays} days)` : ''}</td>
                  <td>{f.steps}</td>
                  <td>{live(f)}{f.runs.failed ? <span className="badge bad" style={{ marginLeft: 6 }}>{f.runs.failed} failed</span> : null}</td>
                  <td onClick={(e) => e.stopPropagation()}>{canManage ? <button className={`btn sm ${f.isActive ? 'outline' : 'ghost'}`} onClick={() => toggle(f)}>{f.isActive ? 'On' : 'Off'}</button> : <span className={`badge ${f.isActive ? 'ok' : 'grey'}`}>{f.isActive ? 'On' : 'Off'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && !rows.length && <div className="empty">No flows yet. {canManage ? 'Start one, or open a rule as a flow from Automation.' : ''}</div>}
        </div>
      </div>
    </>
  );
}
