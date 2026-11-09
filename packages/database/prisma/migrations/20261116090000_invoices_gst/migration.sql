-- Slice 3.1: billing profiles, GST invoices and invoice numbering. Adds optional columns to Customer and Payment; existing rows are unchanged.
ALTER TABLE "Customer" ADD COLUMN "gstin" TEXT, ADD COLUMN "billingAddress" TEXT, ADD COLUMN "stateCode" TEXT;
CREATE TABLE "BillingProfile" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "legalName" TEXT NOT NULL, "gstin" TEXT, "stateCode" TEXT NOT NULL, "address" TEXT NOT NULL, "email" TEXT, "phone" TEXT, "invoicePrefix" TEXT NOT NULL DEFAULT 'INV', "terms" TEXT, "bankDetails" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "BillingProfile_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "BillingProfile_workspaceId_key" ON "BillingProfile"("workspaceId");
CREATE INDEX "BillingProfile_tenantId_idx" ON "BillingProfile"("tenantId");
CREATE TABLE "InvoiceSeries" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "prefix" TEXT NOT NULL, "fy" TEXT NOT NULL, "next" INTEGER NOT NULL DEFAULT 1, CONSTRAINT "InvoiceSeries_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "InvoiceSeries_tenantId_prefix_fy_key" ON "InvoiceSeries"("tenantId", "prefix", "fy");
CREATE TABLE "Invoice" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "quoteId" TEXT, "number" TEXT, "fy" TEXT, "status" TEXT NOT NULL DEFAULT 'draft',
  "issuedAt" TIMESTAMP(3), "dueAt" TIMESTAMP(3), "placeOfSupply" TEXT NOT NULL, "seller" JSONB, "customerName" TEXT NOT NULL, "customerGstin" TEXT, "customerAddress" TEXT,
  "subtotalPaise" INTEGER NOT NULL DEFAULT 0, "discountPaise" INTEGER NOT NULL DEFAULT 0, "taxablePaise" INTEGER NOT NULL DEFAULT 0, "cgstPaise" INTEGER NOT NULL DEFAULT 0, "sgstPaise" INTEGER NOT NULL DEFAULT 0, "igstPaise" INTEGER NOT NULL DEFAULT 0, "roundOffPaise" INTEGER NOT NULL DEFAULT 0, "totalPaise" INTEGER NOT NULL DEFAULT 0, "paidPaise" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT, "terms" TEXT, "cancelReason" TEXT, "cancelledAt" TIMESTAMP(3), "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Invoice_tenantId_number_key" ON "Invoice"("tenantId", "number");
CREATE INDEX "Invoice_tenantId_workspaceId_status_idx" ON "Invoice"("tenantId", "workspaceId", "status");
CREATE INDEX "Invoice_tenantId_leadId_idx" ON "Invoice"("tenantId", "leadId");
CREATE INDEX "Invoice_tenantId_quoteId_idx" ON "Invoice"("tenantId", "quoteId");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "InvoiceItem" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL, "position" INTEGER NOT NULL DEFAULT 0, "description" TEXT NOT NULL, "hsnSac" TEXT, "qty" INTEGER NOT NULL, "unitPaise" INTEGER NOT NULL, "discountPaise" INTEGER NOT NULL DEFAULT 0, "gstBp" INTEGER NOT NULL DEFAULT 0,
  "taxablePaise" INTEGER NOT NULL DEFAULT 0, "cgstPaise" INTEGER NOT NULL DEFAULT 0, "sgstPaise" INTEGER NOT NULL DEFAULT 0, "igstPaise" INTEGER NOT NULL DEFAULT 0, "totalPaise" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id"));
CREATE INDEX "InvoiceItem_tenantId_invoiceId_idx" ON "InvoiceItem"("tenantId", "invoiceId");
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD COLUMN "invoiceId" TEXT;
CREATE INDEX "Payment_tenantId_invoiceId_idx" ON "Payment"("tenantId", "invoiceId");
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['BillingProfile', 'InvoiceSeries', 'Invoice', 'InvoiceItem']) AS t;
