'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { StageBoard } from '@/components/StageBoard';
import { FieldsSettings } from '@/components/FieldsSettings';
import { OptionList } from '@/components/OptionList';
import { CustomActions } from '@/components/CustomActions';
import { AssignmentEditor } from '@/components/AssignmentEditor';
import { CallScripts, LabelsSettings } from '@/components/LabelsScripts';
import type { WorkspaceSettings } from '@/lib/workspace';

type Tab = 'stages' | 'fields' | 'feedback' | 'lists' | 'labels' | 'actions' | 'scripts' | 'assignment' | 'general';
type Msg = { type: 'error' | 'notice'; text: string } | null;
const TABS: [Tab, string][] = [
  ['stages', 'Lead stages'], ['fields', 'Fields'], ['feedback', 'Status & call feedback'], ['lists', 'Sources & lost reasons'],
  ['labels', 'Labels'], ['actions', 'Custom actions'], ['scripts', 'Call scripts'], ['assignment', 'Lead assignment'], ['general', 'General'],
];

export default function WorkspaceSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useShell();
  const [data, setData] = useState<WorkspaceSettings | null>(null);
  const [tab, setTab] = useState<Tab>('stages');
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(() => api<WorkspaceSettings>(`/api/v1/workspaces/${id}/settings`, { workspace: id }).then(setData).catch((e) => setMsg({ type: 'error', text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);
  // Deep links such as ?tab=fields (used by the Setup Guide).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && TABS.some(([k]) => k === t)) setTab(t as Tab);
  }, []);

  /** Runs a save, shows the result, reloads. */
  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try {
      await fn();
      await load();
      setMsg({ type: 'notice', text });
      return true;
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
      return false;
    }
  };
  const call = (path: string, method: string, body?: unknown) => api(path, { method, body, workspace: id });

  if (!data) return msg ? <div className="error">{msg.text}</div> : <div className="muted">Loading…</div>;
  const ro = !data.canManage;
  const isOrgAdmin = me.permissions['org.workspace.manage'] === 'ORGANIZATION';

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link href="/app/workspaces">Workspaces</Link> /</div>
          <h1>{data.name} — Settings</h1>
          {ro && <div className="small muted">View only — ask your administrator to change these settings.</div>}
        </div>
      </div>
      <div className="row" style={{ gap: 2, marginBottom: 14, borderBottom: '1px solid var(--line)', flexWrap: 'nowrap', overflowX: 'auto' }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setMsg(null); }} className="btn ghost"
            style={{ borderRadius: 0, whiteSpace: 'nowrap', borderBottom: tab === k ? '2px solid var(--brand)' : '2px solid transparent', color: tab === k ? 'var(--brand)' : undefined }}>
            {label}
          </button>
        ))}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}

      {tab === 'stages' && (
        <>
          {data.pipelines.map((p) => (
            <StageBoard key={p.id} pipeline={p} fields={data.fields} statuses={data.statuses} lostReasons={data.lostReasons} readOnly={ro} act={act}
              canDelete={data.pipelines.length > 1} onEditLostReasons={() => setTab('lists')} />
          ))}
          {!ro && (
            <button className="btn outline" onClick={() => {
              const name = prompt('Name of the new pipeline / process, e.g. Renewals');
              if (name) act(() => call(`/api/v1/workspaces/${id}/pipelines`, 'POST', { name }), 'Pipeline added.');
            }}>+ Add pipeline</button>
          )}
        </>
      )}
      {tab === 'fields' && <FieldsSettings ws={data} readOnly={ro} isOrgAdmin={isOrgAdmin} act={act} />}
      {tab === 'feedback' && (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <OptionList title="Call feedback" hint="The outcome a caller picks after every call. Tick “Reached” when the customer was actually spoken to."
            withDefault defaultHint="The default is used automatically when a call connects." items={data.dispositions} readOnly={ro} withConnected
            onSave={(options) => act(() => call(`/api/v1/workspaces/${id}/options/call_disposition`, 'PUT', { options }), 'Call feedback saved.')} />
          <OptionList title="Lead status" hint="How warm a lead is (Hot / Warm / Cold …), separate from the stage."
            withDefault defaultHint="New leads get the default status." items={data.statuses} readOnly={ro}
            onSave={(options) => act(() => call(`/api/v1/workspaces/${id}/options/lead_status`, 'PUT', { options }), 'Lead statuses saved.')} />
        </div>
      )}
      {tab === 'lists' && (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <OptionList title="Lead sources" hint="Where leads come from. Used in forms, uploads and source reports." items={data.sources} readOnly={ro}
            onSave={(options) => act(() => call(`/api/v1/workspaces/${id}/options/lead_source`, 'PUT', { options }), 'Lead sources saved.')} />
          <OptionList title="Reasons for lost leads" hint="Asked when a lead is moved to a Lost stage." items={data.lostReasons} readOnly={ro}
            onSave={(options) => act(() => call(`/api/v1/workspaces/${id}/options/lost_reason`, 'PUT', { options }), 'Lost reasons saved.')} />
        </div>
      )}
      {tab === 'actions' && <CustomActions workspaceId={id} readOnly={ro} />}
      {tab === 'labels' && <LabelsSettings ws={data} readOnly={ro} isOrgAdmin={isOrgAdmin} />}
      {tab === 'scripts' && <CallScripts ws={data} readOnly={ro} />}
      {tab === 'assignment' && <AssignmentEditor ws={data} readOnly={ro} act={act} />}
      {tab === 'general' && (
        <div className="card" style={{ maxWidth: 520 }}>
          <h2>General</h2>
          <p className="small muted">Industry template: {data.template ?? '—'}</p>
          {isOrgAdmin ? (
            <div className="row">
              <button className="btn outline" onClick={() => {
                const name = prompt('Workspace name', data.name);
                if (name) act(() => api(`/api/v1/workspaces/${id}`, { method: 'PATCH', body: { name }, noWorkspace: true }), 'Renamed.');
              }}>Rename</button>
              <button className={`btn ${data.isArchived ? 'outline' : 'danger'}`} onClick={() => {
                if (data.isArchived || confirm(`Archive ${data.name}? It disappears from the workspace switcher; its data is kept.`)) {
                  act(() => api(`/api/v1/workspaces/${id}`, { method: 'PATCH', body: { isArchived: !data.isArchived }, noWorkspace: true }), data.isArchived ? 'Workspace restored.' : 'Workspace archived.');
                }
              }}>{data.isArchived ? 'Restore workspace' : 'Archive workspace'}</button>
            </div>
          ) : <p className="small muted">Only organization admins can rename or archive a workspace.</p>}
        </div>
      )}
    </>
  );
}
