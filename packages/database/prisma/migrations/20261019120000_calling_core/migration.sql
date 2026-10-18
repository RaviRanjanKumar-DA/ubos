-- Slice 2.1: one call pipeline (SIM / cloud / manual), paired phones, dial requests, recordings.
ALTER TABLE "OrganizationSetting" ADD COLUMN "unknownCallerWorkspaceId" TEXT, ADD COLUMN "dispositionRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Call" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "externalId" TEXT NOT NULL, "channel" TEXT NOT NULL, "provider" TEXT,
  "direction" TEXT NOT NULL, "phone" TEXT NOT NULL, "userId" TEXT, "deviceId" TEXT, "workspaceId" TEXT, "leadId" TEXT, "customerId" TEXT, "activityId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL, "ringSec" INTEGER NOT NULL DEFAULT 0, "talkSec" INTEGER NOT NULL DEFAULT 0, "answered" BOOLEAN NOT NULL DEFAULT false,
  "disposition" TEXT, "remark" TEXT, "recordingStatus" TEXT NOT NULL DEFAULT 'none', "recordingKey" TEXT, "recordingLinkEnc" TEXT, "recordingBytes" INTEGER,
  "recordingMime" TEXT, "recordingTotal" INTEGER, "clientUpdatedAt" TIMESTAMP(3), "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Call_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Call_tenantId_externalId_key" ON "Call"("tenantId", "externalId");
CREATE INDEX "Call_tenantId_startedAt_idx" ON "Call"("tenantId", "startedAt");
CREATE INDEX "Call_tenantId_leadId_idx" ON "Call"("tenantId", "leadId");
CREATE INDEX "Call_tenantId_userId_startedAt_idx" ON "Call"("tenantId", "userId", "startedAt");

CREATE TABLE "Device" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "platform" TEXT NOT NULL DEFAULT 'android',
  "appVersion" TEXT, "tokenHash" TEXT NOT NULL, "lastSeenAt" TIMESTAMP(3), "lastSyncAt" TIMESTAMP(3), "pendingCalls" INTEGER NOT NULL DEFAULT 0,
  "revokedAt" TIMESTAMP(3), "revokedById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Device_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");
CREATE INDEX "Device_tenantId_userId_idx" ON "Device"("tenantId", "userId");

CREATE TABLE "PairingCode" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "userId" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PairingCode_pkey" PRIMARY KEY ("id"));
CREATE INDEX "PairingCode_tenantId_codeHash_idx" ON "PairingCode"("tenantId", "codeHash");

CREATE TABLE "DialRequest" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "userId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "phone" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "pickedAt" TIMESTAMP(3), CONSTRAINT "DialRequest_pkey" PRIMARY KEY ("id"));
CREATE INDEX "DialRequest_tenantId_userId_status_idx" ON "DialRequest"("tenantId", "userId", "status");

SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['Call', 'Device', 'PairingCode', 'DialRequest']) AS t;
