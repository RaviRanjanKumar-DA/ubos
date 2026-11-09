-- Slice 2.6: calling campaigns (power dialer queue) and coaching comments on calls.
ALTER TABLE "Call" ADD COLUMN "campaignId" TEXT;
CREATE INDEX "Call_tenantId_campaignId_idx" ON "Call"("tenantId", "campaignId");
CREATE TABLE "CallCampaign" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active', "agentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "maxAttempts" INTEGER NOT NULL DEFAULT 3, "retryAfterMin" INTEGER NOT NULL DEFAULT 60, "filter" JSONB NOT NULL, "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "CallCampaign_pkey" PRIMARY KEY ("id"));
CREATE INDEX "CallCampaign_tenantId_workspaceId_idx" ON "CallCampaign"("tenantId", "workspaceId");
CREATE TABLE "CallCampaignItem" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "campaignId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "position" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "agentId" TEXT,
  "claimedAt" TIMESTAMP(3), "lockedUntil" TIMESTAMP(3), "dialedAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0, "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "callId" TEXT, "lastDisposition" TEXT, "connected" BOOLEAN,
  "lastAt" TIMESTAMP(3), CONSTRAINT "CallCampaignItem_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "CallCampaignItem_campaignId_leadId_key" ON "CallCampaignItem"("campaignId", "leadId");
CREATE INDEX "CallCampaignItem_tenantId_campaignId_status_nextAt_idx" ON "CallCampaignItem"("tenantId", "campaignId", "status", "nextAt");
-- One open call per person at a time, even if two claims race.
CREATE UNIQUE INDEX "CallCampaignItem_one_open_per_agent" ON "CallCampaignItem"("tenantId", "agentId") WHERE "status" = 'active';
ALTER TABLE "CallCampaignItem" ADD CONSTRAINT "CallCampaignItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CallCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CallCampaignItem" ADD CONSTRAINT "CallCampaignItem_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "CallComment" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "callId" TEXT NOT NULL, "authorId" TEXT NOT NULL, "atSec" INTEGER, "body" TEXT NOT NULL, "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "CallComment_pkey" PRIMARY KEY ("id"));
CREATE INDEX "CallComment_tenantId_callId_idx" ON "CallComment"("tenantId", "callId");
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['CallCampaign', 'CallCampaignItem', 'CallComment']) AS t;
