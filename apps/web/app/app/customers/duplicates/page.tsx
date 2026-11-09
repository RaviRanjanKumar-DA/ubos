'use client';

import { askConfirm } from '@/components/Dialogs';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface Card {
  id: string; code: string; name: string; mobile: string | null; alternateMobiles: string[]; email: string | null; city: string | null;
  pan: string | null; leadCount: number; workspaces: string[]; createdAt: string;
}
interface Pair { a: string; b: string; reasons: string[]; confidence: 'exact' | 'possible'; customerA: Card; customerB: Card }

function CustomerCard({ c, selected, onSelect }: { c: Card; selected: boolean; onSelect: () => void }) {
  return (
    <label className="card" style={{ flex: 1, minWidth: 220, cursor: 'pointer', borderColor: selected ? 'var(--brand)' : undefined, boxShadow: selected ? '0 0 0 2px var(--brand-100)' : undefined }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <span><input type="radio" checked={selected} onChange={onSelect} style={{ marginRight: 6 }} /><b>{c.name}</b></span>
        <span className="badge grey">{c.code}</span>
      </div>
      <div className="small" style={{ marginTop: 6, lineHeight: 1.7 }}>
        <div>📱 {c.mobile ?? '—'}{c.alternateMobiles.length ? ` (+${c.alternateMobiles.length})` : ''}</div>
        <div style={{ overflowWrap: 'anywhere' }}>✉️ {c.email ?? '—'}</div>
        {c.city && <div>📍 {c.city}</div>}
        {c.pan && <div>PAN {c.pan}</div>}
        <div className="muted">{c.leadCount} enquiries · {c.workspaces.join(', ') || 'no leads'}</div>
        <div className="muted">Since {new Date(c.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
      </div>
    </label>
  );
}

export default function DuplicatesPage() {
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);

  const load = () => api<Pair[]>('/api/v1/customers/duplicates', { noWorkspace: true })
    .then((p) => {
      setPairs(p);
      // Suggest keeping the record with more enquiries (or the older one).
      setKeep(Object.fromEntries(p.map((x) => {
        const a = x.customerA, b = x.customerB;
        const pick = a.leadCount !== b.leadCount ? (a.leadCount > b.leadCount ? a : b) : (a.createdAt <= b.createdAt ? a : b);
        return [`${x.a}:${x.b}`, pick.id];
      })));
    })
    .catch((e) => setMsg({ type: 'error', text: e.message }));
  useEffect(() => { load(); }, []);

  async function act(fn: () => Promise<unknown>, text: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ type: 'notice', text });
      load();
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' });
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link href="/app/customers">Customers</Link> /</div>
          <h1>Possible duplicates</h1>
          <div className="muted small">Choose the record to keep. Its details stay; the other record&apos;s enquiries, numbers and missing details move into it. Every merge can be undone.</div>
        </div>
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      {pairs && !pairs.length && <div className="card empty">No duplicates to review. 🎉</div>}
      {!pairs && !msg && <div className="muted">Checking…</div>}
      {pairs?.map((p) => {
        const k = `${p.a}:${p.b}`;
        const keepId = keep[k];
        const other = keepId === p.a ? p.b : p.a;
        const keepName = keepId === p.a ? p.customerA.name : p.customerB.name;
        return (
          <div key={k} className="card" style={{ marginBottom: 14 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className={`badge ${p.confidence === 'exact' ? 'bad' : 'warn'}`}>{p.confidence === 'exact' ? 'Very likely the same' : 'Possibly the same'}</span>
              <span className="small muted">{p.reasons.join(' · ')}</span>
            </div>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <CustomerCard c={p.customerA} selected={keepId === p.a} onSelect={() => setKeep({ ...keep, [k]: p.a })} />
              <CustomerCard c={p.customerB} selected={keepId === p.b} onSelect={() => setKeep({ ...keep, [k]: p.b })} />
            </div>
            <div className="row end" style={{ marginTop: 12 }}>
              <button className="btn ghost" onClick={() => act(() => api('/api/v1/customers/duplicates/dismiss', { method: 'POST', body: { aId: p.a, bId: p.b }, noWorkspace: true }), 'Marked as different people.')}>
                Not the same person
              </button>
              <button className="btn" onClick={async () => {
                if (await askConfirm(`Merge into ${keepName}?`)) act(() => api('/api/v1/customers/merge', { method: 'POST', body: { primaryId: keepId, duplicateId: other }, noWorkspace: true }), `Merged into ${keepName}. You can undo it from the customer page.`);
              }}>
                Merge — keep {keepName}
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
