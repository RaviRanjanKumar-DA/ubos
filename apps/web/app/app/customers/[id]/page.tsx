'use client';

import { CustomerTickets } from '@/components/support/CustomerTickets';
import { useShell } from '@/components/AppShell';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

interface Lead {
  id: string; workspace: string; workspaceId: string; pipeline: string; stage: string; isWon: boolean; isLost: boolean; lostReason: string | null;
  source: string; owner: string | null; createdAt: string;
}
interface Event { id: string; at: string; action: string; actor: string; context: string | null; oldValue: unknown; newValue: unknown }
interface Customer360 {
  id: string; code: string; name: string; mobile: string | null; alternateMobiles: string[]; email: string | null; alternateEmails: string[]; city: string | null;
  pan: string | null; hasPan: boolean; createdAt: string; primaryRm: { id: string; name: string } | null;
  firstSource: string | null; lastSource: string | null; sources: string[]; canEdit: boolean; canMerge: boolean;
  leads: Lead[]; timeline: Event[];
  merges: { id: string; at: string; undoneAt: string | null; reason: string | null; duplicate: { id: string; code: string; name: string }; leadsMoved: number }[];
}

const ACTION_TEXT: Record<string, string> = {
  'lead.created': 'New enquiry', 'lead.stage_changed': 'Stage changed', 'lead.fields_changed': 'Details updated',
  'customer.updated': 'Customer details edited', 'customer.merged': 'Duplicate merged in', 'customer.merge_undone': 'Merge undone',
  'customer.not_duplicate': 'Marked as not a duplicate',
};

function describe(e: Event) {
  const n = e.newValue as Record<string, unknown> | null;
  const o = e.oldValue as Record<string, unknown> | null;
  if (e.action === 'lead.stage_changed' && n) return `${o?.stage ?? '?'} → ${n.stage}${n.lostReason ? ` (${n.lostReason})` : ''}`;
  if (e.action === 'lead.created' && n) return `Source: ${n.source}`;
  if (n && typeof n === 'object') return Object.keys(n).filter((k) => k !== 'reason').join(', ');
  return '';
}

export default function Customer360Page() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<Customer360 | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);

  const { me } = useShell();
  // People with an organization-wide role see every business line; the others read through their selected one.
  const orgWide = me.roles.some((r) => r.workspaceId === null);
  const load = useCallback(() => {
    api<Customer360>(`/api/v1/customers/${id}`, { noWorkspace: orgWide })
      .then(setC)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'CUSTOMER_MERGED') setError('This customer was merged into another record.');
        else setError(e.message);
      });
  }, [id, orgWide]);
  useEffect(() => { load(); }, [load]);

  if (!c) return error ? <div className="error">{error} <Link href="/app/customers">Back to customers</Link></div> : <div className="muted">Loading…</div>;

  const won = c.leads.filter((l) => l.isWon).length;
  const open = c.leads.filter((l) => !l.isWon && !l.isLost).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link href="/app/customers">Customers</Link> /</div>
          <h1>{c.name} <span className="badge grey" style={{ verticalAlign: 'middle' }}>{c.code}</span></h1>
          <div className="small muted">Customer since {new Date(c.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}{c.primaryRm ? ` · Primary RM: ${c.primaryRm.name}` : ''}</div>
        </div>
        <div className="row">
          {c.canEdit && <button className="btn outline" onClick={() => setEditing(true)}>Edit details</button>}
        </div>
      </div>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="card kpi"><div className="label">Enquiries</div><div className="value">{c.leads.length}</div></div>
        <div className="card kpi"><div className="label">Open</div><div className="value">{open}</div></div>
        <div className="card kpi"><div className="label">Won</div><div className="value">{won}</div></div>
        <div className="card kpi"><div className="label">Business lines</div><div className="value">{new Set(c.leads.map((l) => l.workspace)).size}</div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: 14, alignItems: 'start' }} className="c360">
        <div className="card">
          <h2>Contact & identity</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', margin: 0 }}>
            <dt className="muted small">Mobile</dt><dd style={{ margin: 0 }}>{c.mobile ?? '—'}</dd>
            <dt className="muted small">Other numbers</dt><dd style={{ margin: 0 }}>{c.alternateMobiles.join(', ') || '—'}</dd>
            <dt className="muted small">Email</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{c.email ?? '—'}</dd>
            <dt className="muted small">Other emails</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{c.alternateEmails?.join(', ') || '—'}</dd>
            <dt className="muted small">City</dt><dd style={{ margin: 0 }}>{c.city ?? '—'}</dd>
            <dt className="muted small">PAN</dt><dd style={{ margin: 0 }}>{c.pan ?? '—'}</dd>
            <dt className="muted small">First source</dt><dd style={{ margin: 0 }}>{c.firstSource ?? '—'}</dd>
            <dt className="muted small">All sources</dt><dd style={{ margin: 0 }}>{c.sources.join(', ') || '—'}</dd>
          </dl>
          {c.merges.length > 0 && (
            <>
              <h2 style={{ marginTop: 16 }}>Merged records</h2>
              {c.merges.map((m) => (
                <div key={m.id} className="row small" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                  <span>
                    {m.duplicate.name} ({m.duplicate.code}) · {m.leadsMoved} lead(s) · {new Date(m.at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                    {m.undoneAt && <span className="badge grey" style={{ marginLeft: 6 }}>Undone</span>}
                  </span>
                  {c.canMerge && !m.undoneAt && (
                    <button className="btn sm ghost" onClick={async () => {
                      if (!confirm(`Undo merge of ${m.duplicate.name}? The separate record comes back with its leads.`)) return;
                      try {
                        await api(`/api/v1/customers/merges/${m.id}/undo`, { method: 'POST', noWorkspace: true });
                        setNotice('Merge undone.');
                        load();
                      } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
                    }}>Undo</button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 4px' }}><h2>Enquiries across business lines</h2></div>
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 520 }}>
              <thead><tr><th>Business line</th><th>Stage</th><th>Source</th><th>Owner</th><th>Date</th></tr></thead>
              <tbody>
                {c.leads.map((l) => (
                  <tr key={l.id}>
                    <td><Link href={`/app/leads/${l.id}?ws=${l.workspaceId}`}><span className="badge">{l.workspace}</span></Link><div className="small muted">{l.pipeline}</div></td>
                    <td>
                      <span className={`badge ${l.isWon ? 'ok' : l.isLost ? 'bad' : 'grey'}`}>{l.stage}</span>
                      {l.lostReason && <div className="small muted">{l.lostReason}</div>}
                    </td>
                    <td className="small">{l.source}</td>
                    <td className="small">{l.owner ?? '—'}</td>
                    <td className="small muted">{new Date(l.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!c.leads.length && <div className="empty">No enquiries you can see.</div>}
          </div>
        </div>
      </div>

      <CustomerTickets customerId={c.id} customerName={c.name} />

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Timeline</h2>
        {c.timeline.map((e) => (
          <div key={e.id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <span className="dot" style={{ color: 'var(--brand)', marginTop: 7 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{ACTION_TEXT[e.action] ?? e.action}</b>{e.context && <span className="muted"> · {e.context}</span>}
              <div className="small muted">{describe(e)}</div>
            </div>
            <div className="small muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{e.actor}<br />{new Date(e.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
          </div>
        ))}
        {!c.timeline.length && <div className="empty">No activity yet.</div>}
        <p className="small muted" style={{ marginBottom: 0 }}>Calls, WhatsApp chats, payments and documents join this timeline in later phases.</p>
      </div>

      {editing && <EditCustomer c={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setNotice('Customer details saved.'); load(); }} />}
      <style>{`@media (max-width: 860px) { .c360 { grid-template-columns: 1fr !important; } }`}</style>
    </>
  );
}

function EditCustomer({ c, onClose, onSaved }: { c: Customer360; onClose: () => void; onSaved: () => void }) {
  const orgWide = useShell().me.roles.some((r) => r.workspaceId === null);
  const [f, setF] = useState({ name: c.name, mobile: c.mobile ?? '', alternateMobiles: c.alternateMobiles.join(', '), email: c.email ?? '', alternateEmails: (c.alternateEmails ?? []).join(', '), city: c.city ?? '', pan: '' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/v1/customers/${c.id}`, {
        method: 'PATCH', noWorkspace: orgWide,
        body: {
          name: f.name, city: f.city,
          // Masked or unchanged contact details are not sent back.
          ...(f.mobile !== (c.mobile ?? '') ? { mobile: f.mobile } : {}),
          ...(f.email !== (c.email ?? '') ? { email: f.email } : {}),
          ...(f.alternateMobiles !== c.alternateMobiles.join(', ') ? { alternateMobiles: f.alternateMobiles.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
          ...(f.alternateEmails !== (c.alternateEmails ?? []).join(', ') ? { alternateEmails: f.alternateEmails.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
          ...(f.pan ? { pan: f.pan } : {}),
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Edit {c.name}</h2>
        {error && <div className="error">{error}</div>}
        <div className="grid cols-2">
          <div className="field"><label>Name</label><input className="input" value={f.name} onChange={set('name')} required /></div>
          <div className="field"><label>Mobile</label><input className="input" value={f.mobile} onChange={set('mobile')} required /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Other numbers (comma separated)</label><input className="input" value={f.alternateMobiles} onChange={set('alternateMobiles')} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Other emails (comma separated)</label><input className="input" value={f.alternateEmails} onChange={set('alternateEmails')} placeholder="work@company.com, personal@gmail.com" /></div>
          <div className="field"><label>Email</label><input className="input" type="email" value={f.email} onChange={set('email')} /></div>
          <div className="field"><label>City</label><input className="input" value={f.city} onChange={set('city')} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>PAN {c.hasPan && <span className="muted">(saved: {c.pan} — enter a new one only to change it)</span>}</label>
            <input className="input" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} placeholder="ABCDE1234F" maxLength={10} autoComplete="off" />
            <span className="small muted">Stored encrypted; only the last 4 characters are ever shown.</span>
          </div>
        </div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">Save</button>
        </div>
      </form>
    </div>
  );
}
