'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

function useOpenDraft() {
  const router = useRouter();
  const [err, setErr] = useState('');
  const open = async (make: () => Promise<{ id: string }>) => {
    setErr('');
    try { router.push(`/app/invoices/${(await make()).id}`); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  };
  return { err, open };
}
const Err = ({ text }: { text: string }) => (text ? <div className="small" style={{ color: 'var(--bad)', whiteSpace: 'normal' }}>{text}</div> : null);

/** Turns a quote into a draft invoice. */
export function InvoiceFromQuote({ quoteId }: { quoteId: string }) {
  const { err, open } = useOpenDraft();
  return <><button className="btn sm ghost" onClick={() => open(() => api<{ id: string }>(`/api/v1/invoices/from-quote/${quoteId}`, { method: 'POST' }))}>Invoice</button><Err text={err} /></>;
}

/** A draft invoice on a lead that has no quote. */
export function NewInvoice({ leadId, workspace }: { leadId: string; workspace: string }) {
  const { err, open } = useOpenDraft();
  return <><button className="btn sm outline" onClick={() => open(() => api<{ id: string }>('/api/v1/invoices', { method: 'POST', workspace, body: { leadId, items: [{ description: 'Item', qty: 1, unitPaise: 0, gstBp: 1800 }] } }))}>New invoice</button><Err text={err} /></>;
}
