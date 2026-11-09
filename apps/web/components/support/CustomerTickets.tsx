'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { SlaBadge, PRIORITY, STATUS, type TicketRow } from './ticket-ui';

/** Support history on Customer 360. */
export function CustomerTickets({ customerId, customerName }: { customerId: string; customerName: string }) {
  const { can, version } = useShell();
  const [rows, setRows] = useState<TicketRow[] | null>(null);
  const allowed = can('support.ticket.view');
  useEffect(() => {
    if (allowed) api<TicketRow[]>(`/api/v1/tickets?view=all&customerId=${customerId}`).then(setRows).catch(() => setRows([]));
  }, [customerId, allowed, version]);
  if (!allowed) return null;
  return (
    <div className="card ticket-c360">
      <div className="camp-top">
        <h2>Support tickets</h2>
        {can('support.ticket.work') && <Link className="btn sm outline" href={`/app/tickets?customer=${customerId}&name=${encodeURIComponent(customerName)}`}>+ New ticket</Link>}
      </div>
      {!rows ? <div className="muted">Loading…</div> : !rows.length ? <p className="small muted">No tickets from this customer.</p> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Ticket</th><th>Status</th><th>Priority</th><th>Target</th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.id}><td><Link href={`/app/tickets/${t.id}`}><b>#{t.number} {t.subject}</b></Link></td><td className="small">{STATUS[t.status]}</td><td className="small">{PRIORITY[t.priority]}</td><td><SlaBadge sla={t.sla} status={t.status} /></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
