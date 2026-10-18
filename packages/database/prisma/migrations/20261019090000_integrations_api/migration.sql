-- Slice 1.7: inbound webhook log, API keys, outgoing webhooks, web-to-lead forms.
ALTER TABLE "WebhookInbox" ADD COLUMN "externalId" TEXT, ADD COLUMN "outcome" TEXT, ADD COLUMN "leadId" TEXT, ADD COLUMN "error" TEXT, ADD COLUMN "processedAt" TIMESTAMP(3);
CREATE INDEX "WebhookInbox_tenantId_integrationKey_receivedAt_idx" ON "WebhookInbox"("tenantId", "integrationKey", "receivedAt");
CREATE INDEX "WebhookInbox_tenantId_integrationKey_externalId_idx" ON "WebhookInbox"("tenantId", "integrationKey", "externalId");

CREATE TABLE "ApiKey" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "name" TEXT NOT NULL, "prefix" TEXT NOT NULL, "keyHash" TEXT NOT NULL,
  "scopes" TEXT[], "workspaceId" TEXT, "createdById" TEXT NOT NULL, "lastUsedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

CREATE TABLE "WebhookSubscription" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "name" TEXT NOT NULL, "url" TEXT NOT NULL, "events" TEXT[],
  "workspaceId" TEXT, "secretEncrypted" TEXT NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true, "createdById" TEXT NOT NULL,
  "failureCount" INTEGER NOT NULL DEFAULT 0, "lastDeliveryAt" TIMESTAMP(3), "lastStatus" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id"));
CREATE INDEX "WebhookSubscription_tenantId_idx" ON "WebhookSubscription"("tenantId");

CREATE TABLE "WebhookDelivery" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "subscriptionId" TEXT NOT NULL, "event" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responseStatus" INTEGER, "responseBody" TEXT, "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"));
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX "WebhookDelivery_tenantId_subscriptionId_createdAt_idx" ON "WebhookDelivery"("tenantId", "subscriptionId", "createdAt");

CREATE TABLE "LeadForm" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL, "description" TEXT, "fields" JSONB NOT NULL, "submitLabel" TEXT NOT NULL DEFAULT 'Submit',
  "thankYou" TEXT NOT NULL DEFAULT 'Thank you! We will contact you soon.', "redirectUrl" TEXT, "source" TEXT NOT NULL DEFAULT 'website',
  "duplicateMode" TEXT NOT NULL DEFAULT 'add_remark', "color" TEXT NOT NULL DEFAULT '#5b3cc4', "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isArchived" BOOLEAN NOT NULL DEFAULT false, "submissions" INTEGER NOT NULL DEFAULT 0, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LeadForm_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "LeadForm_tenantId_slug_key" ON "LeadForm"("tenantId", "slug");

SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['ApiKey', 'WebhookSubscription', 'WebhookDelivery', 'LeadForm']) AS t;
