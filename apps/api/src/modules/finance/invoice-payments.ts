import { refreshInvoiceDue } from './collections';
import { financialYear } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { activity } from '../../common/lead-ops';
import { emitEvent } from '../../common/events';

const money = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function nextReceipt(tx: Tx, tenantId: string, at: Date) {
  const fy = financialYear(at);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt:${tenantId}:${fy}`}))`;
  const s = await tx.invoiceSeries.upsert({ where: { tenantId_prefix_fy: { tenantId, prefix: 'RCPT', fy } }, create: { tenantId, prefix: 'RCPT', fy, next: 2 }, update: { next: { increment: 1 } } });
  return `RCPT/${fy}/${String(s.next - 1).padStart(4, '0')}`;
}

/** Every payment on an invoice goes through here, by hand or from a gateway. It counts towards any process running on the lead. */
export async function recordInvoicePayment(
  tx: Tx,
  inv: { id: string; tenantId: string; workspaceId: string; customerId: string; leadId: string; number: string | null; totalPaise: number; paidPaise: number },
  o: { amountPaise: number; mode: string; reference: string | null; receivedAt: Date; userId: string | null; source: 'invoice' | 'gateway' },
) {
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: inv.leadId } });
  const run = await tx.processRun.findFirst({ where: { leadId: lead.id, status: 'active' }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const due = inv.totalPaise - inv.paidPaise;
  const receiptNumber = await nextReceipt(tx, inv.tenantId, o.receivedAt);
  const p = await tx.payment.create({ data: { tenantId: inv.tenantId, workspaceId: inv.workspaceId, customerId: inv.customerId, leadId: lead.id, runId: run?.id ?? null, invoiceId: inv.id, amountPaise: o.amountPaise, kind: o.amountPaise >= due && !inv.paidPaise ? 'full' : o.amountPaise >= due ? 'balance' : 'instalment', mode: o.mode, reference: o.reference, receivedAt: o.receivedAt, createdById: o.userId, source: o.source, receiptNumber } });
  await tx.invoice.update({ where: { id: inv.id }, data: { paidPaise: { increment: o.amountPaise } } });
  await refreshInvoiceDue(tx, inv.id);
  await tx.leadActivity.create({ data: activity(lead, o.userId, { type: 'payment', remark: `${money(p.amountPaise)} received on invoice ${inv.number} (${p.mode})`, data: { paymentId: p.id, invoiceId: inv.id, runId: run?.id ?? null } }) });
  await emitEvent(tx, inv.tenantId, inv.workspaceId, 'payment.received', { paymentId: p.id, leadId: lead.id, customerId: p.customerId, runId: run?.id ?? null, amountPaise: p.amountPaise, kind: p.kind, mode: p.mode, reference: p.reference });
  return p;
}
