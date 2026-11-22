-- Slice 3.8b: customers pay UBOS orders online (the platform's own Razorpay account) and get GST tax invoices from UBOS.
-- UBOS's seller details and Razorpay keys (secrets encrypted) live in the one PlatformSetting row.
ALTER TABLE "PlatformSetting" ADD COLUMN "sellerName" TEXT, ADD COLUMN "sellerGstin" TEXT, ADD COLUMN "sellerStateCode" TEXT, ADD COLUMN "sellerAddress" TEXT, ADD COLUMN "sellerEmail" TEXT,
  ADD COLUMN "invoicePrefix" TEXT NOT NULL DEFAULT 'UB', ADD COLUMN "razorpayKeyId" TEXT, ADD COLUMN "razorpaySecretEnc" TEXT, ADD COLUMN "razorpayWebhookSecretEnc" TEXT, ADD COLUMN "razorpayApiBase" TEXT;
-- Who the customer's invoice is made out to (Tenant already has gstin).
ALTER TABLE "Tenant" ADD COLUMN "billingName" TEXT, ADD COLUMN "billingAddress" TEXT, ADD COLUMN "billingStateCode" TEXT;
ALTER TABLE "TenantOrder" ADD COLUMN "paymentLinkId" TEXT, ADD COLUMN "paymentLinkUrl" TEXT, ADD COLUMN "paymentLinkExpiresAt" TIMESTAMP(3), ADD COLUMN "paidVia" TEXT, ADD COLUMN "invoiceId" TEXT;
CREATE UNIQUE INDEX "TenantOrder_paymentLinkId_key" ON "TenantOrder"("paymentLinkId");
-- PlatformInvoice was created empty in the first migration; it becomes the invoice for a paid order.
ALTER TABLE "PlatformInvoice" ALTER COLUMN "subscriptionId" DROP NOT NULL,
  ADD COLUMN "tenantId" TEXT NOT NULL, ADD COLUMN "orderId" TEXT NOT NULL, ADD COLUMN "fy" TEXT NOT NULL, ADD COLUMN "seller" JSONB NOT NULL, ADD COLUMN "buyer" JSONB NOT NULL, ADD COLUMN "items" JSONB NOT NULL,
  ADD COLUMN "placeOfSupply" TEXT, ADD COLUMN "taxablePaise" INTEGER NOT NULL, ADD COLUMN "cgstPaise" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "sgstPaise" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "igstPaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalPaise" INTEGER NOT NULL, ADD COLUMN "paymentRef" TEXT;
CREATE UNIQUE INDEX "PlatformInvoice_orderId_key" ON "PlatformInvoice"("orderId");
CREATE INDEX "PlatformInvoice_tenantId_idx" ON "PlatformInvoice"("tenantId");
REVOKE INSERT, UPDATE, DELETE ON "PlatformInvoice" FROM ubos_app;
