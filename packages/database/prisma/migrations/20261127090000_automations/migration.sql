-- Slice 4.3: scheduled report emails and API templates (outgoing calls used by the "Call an API" action).
CREATE TABLE "ReportSchedule" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "name" TEXT NOT NULL, "reportKey" TEXT NOT NULL, "range" TEXT NOT NULL DEFAULT 'yesterday',
  "workspaceId" TEXT, "ownerFilterId" TEXT, "source" TEXT, "frequency" TEXT NOT NULL, "weekday" INTEGER, "monthDay" INTEGER, "time" TEXT NOT NULL, "recipientIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdById" TEXT NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true, "isArchived" BOOLEAN NOT NULL DEFAULT false, "nextRunAt" TIMESTAMP(3) NOT NULL, "lastRunAt" TIMESTAMP(3), "lastStatus" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ReportSchedule_tenantId_nextRunAt_idx" ON "ReportSchedule"("tenantId", "nextRunAt");
CREATE TABLE "ApiTemplate" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT, "name" TEXT NOT NULL, "method" TEXT NOT NULL DEFAULT 'POST', "url" TEXT NOT NULL,
  "headersEnc" TEXT, "body" TEXT, "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdById" TEXT NOT NULL, "lastStatus" INTEGER, "lastCalledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ApiTemplate_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ApiTemplate_tenantId_workspaceId_idx" ON "ApiTemplate"("tenantId", "workspaceId");
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['ReportSchedule', 'ApiTemplate']) AS t;
