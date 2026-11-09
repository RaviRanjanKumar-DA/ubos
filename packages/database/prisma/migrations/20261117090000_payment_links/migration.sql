-- Slice 3.2: payment links on invoices, and receipt numbers. Adds one optional column to Payment; existing rows are unchanged.
CREATE TABLE "PaymentLink" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL, "provider" TEXT NOT NULL DEFAULT 'razorpay', "providerId" TEXT NOT NULL, "url" TEXT NOT NULL, "amountPaise" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'created', "expiresAt" TIMESTAMP(3), "paidAt" TIMESTAMP(3), "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "PaymentLink_tenantId_provider_providerId_key" ON "PaymentLink"("tenantId", "provider", "providerId");
CREATE INDEX "PaymentLink_tenantId_invoiceId_idx" ON "PaymentLink"("tenantId", "invoiceId");
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Only one link can be open on an invoice at a time.
CREATE UNIQUE INDEX "PaymentLink_one_open" ON "PaymentLink"("invoiceId") WHERE "status" = 'created';
ALTER TABLE "Payment" ADD COLUMN "receiptNumber" TEXT;
CREATE UNIQUE INDEX "Payment_tenantId_receiptNumber_key" ON "Payment"("tenantId", "receiptNumber");
-- The gateway's own payment id is stored once, so a repeated webhook can never record the money twice.
CREATE UNIQUE INDEX "Payment_one_gateway_ref" ON "Payment"("tenantId", "reference") WHERE "source" = 'gateway';
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['PaymentLink']) AS t;
