-- Slice 3.3: instalment plans and payment reminders. New columns are optional or have a default; existing rows are unchanged.
CREATE TABLE "InvoiceInstalment" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL, "position" INTEGER NOT NULL, "dueAt" TIMESTAMP(3) NOT NULL, "amountPaise" INTEGER NOT NULL, CONSTRAINT "InvoiceInstalment_pkey" PRIMARY KEY ("id"));
CREATE INDEX "InvoiceInstalment_tenantId_invoiceId_idx" ON "InvoiceInstalment"("tenantId", "invoiceId");
ALTER TABLE "InvoiceInstalment" ADD CONSTRAINT "InvoiceInstalment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD COLUMN "reminderStage" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "lastReminderAt" TIMESTAMP(3);
ALTER TABLE "BillingProfile" ADD COLUMN "autoRemind" BOOLEAN NOT NULL DEFAULT false;
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['InvoiceInstalment']) AS t;
