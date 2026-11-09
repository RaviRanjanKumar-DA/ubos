'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Icon } from '@/components/Icon';
import { fromIstInput, toIstInput } from '@/lib/ist';
import { inr, toPaise } from '@/lib/money';

interface Item { dueAt: string; amountPaise: number }
const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

/** Splits an invoice into dated instalments. The invoice's due date follows the next unpaid one. */
export function Instalments({ invoiceId, totalPaise, paidPaise, canEdit, onChange }: { invoiceId: string; totalPaise: number; paidPaise: number; canEdit: boolean; onChange: () => void }) {
  const [plan, setPlan] = useState<Item[] | null>(null);
  const [edit, setEdit] = useState<{ date: string; amount: string }[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api<Item[]>(`/api/v1/invoices/${invoiceId}/instalments`).then(setPlan).catch(() => setPlan([])), [invoiceId]);
  useEffect(() => { load(); }, [load]);
  if (!plan) return null;
  const open = () => setEdit(plan.length ? plan.map((p) => ({ date: toIstInput(new Date(p.dueAt)).slice(0, 10), amount: String(p.amountPaise / 100) })) : [{ date: toIstInput(new Date(Date.now() + 15 * 86_400_000)).slice(0, 10), amount: String(Math.floor(totalPaise / 200)) }, { date: toIstInput(new Date(Date.now() + 45 * 86_400_000)).slice(0, 10), amount: String((totalPaise - Math.floor(totalPaise / 200) * 100) / 100) }]);
  const sum = (edit ?? []).reduce((s, l) => s + (toPaise(l.amount) ?? 0), 0);
  const save = async (list: { date: string; amount: string }[]) => {
    setErr('');
    try {
      await api(`/api/v1/invoices/${invoiceId}/instalments`, { method: 'PUT', body: { instalments: list.map((l) => ({ dueAt: fromIstInput(`${l.date}T23:59`).toISOString(), amountPaise: toPaise(l.amount) ?? 0 })) } });
      setEdit(null); await load(); onChange();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  };
  let covered = 0;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="org-head"><h2 style={{ margin: 0 }}>Instalments</h2>{canEdit && !edit && <button className="btn sm outline" onClick={open}>{plan.length ? 'Change plan' : 'Add a plan'}</button>}</div>
      {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
      {!edit && !plan.length && <p className="small muted" style={{ marginBottom: 0 }}>The whole amount is due on the invoice due date.</p>}
      {!edit && plan.map((p, i) => { covered += p.amountPaise; const paid = covered <= paidPaise; return (
        <div key={i} className="org-head" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}><span>{day(p.dueAt)}</span><span><b>{inr(p.amountPaise, 2)}</b> <span className={`badge ${paid ? 'ok' : 'grey'}`}>{paid ? 'Paid' : 'Open'}</span></span></div>
      ); })}
      {edit && (
        <div style={{ marginTop: 10 }}>
          {edit.map((l, i) => (
            <div key={i} className="flow-opt">
              <input className="input" type="date" aria-label="Due date" value={l.date} onChange={(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
              <input className="input" inputMode="decimal" aria-label="Amount" value={l.amount} onChange={(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <button type="button" className="btn sm ghost" aria-label="Remove instalment" disabled={edit.length === 1} onClick={() => setEdit(edit.filter((_, j) => j !== i))}><Icon name="close" className="ic" /></button>
            </div>
          ))}
          <button type="button" className="btn sm ghost" onClick={() => setEdit([...edit, { date: edit.at(-1)!.date, amount: String(Math.max(0, totalPaise - sum) / 100) }])}><Icon name="plus" className="ic" />Instalment</button>
          <p className={`small ${sum === totalPaise ? 'muted' : ''}`} style={sum === totalPaise ? undefined : { color: 'var(--bad)' }}>Total {inr(sum, 2)} of {inr(totalPaise, 2)}</p>
          <div className="row"><button className="btn sm" disabled={sum !== totalPaise} onClick={() => save(edit)}>Save plan</button>{plan.length > 0 && <button className="btn sm ghost" onClick={() => save([])}>Remove plan</button>}<button className="btn sm ghost" onClick={() => setEdit(null)}>Go back</button></div>
        </div>
      )}
    </div>
  );
}
