'use client';

import Link from 'next/link';
import { useShell } from '@/components/AppShell';

/** On Customer 360: a way into this customer's invoices and payments. */
export function LedgerLink({ customerId }: { customerId: string }) {
  const { can } = useShell();
  if (!can('finance.invoice.view')) return null;
  return <div className="row end" style={{ margin: '12px 0' }}><Link className="btn sm outline" href={`/app/customers/${customerId}/ledger`}>Open ledger</Link></div>;
}
