-- Slice 3.9: visual automation flows (trigger, actions, waits, if/else paths) and each lead's run through a flow.
CREATE TABLE "AutomationFlow" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "trigger" TEXT NOT NULL, "idleDays" INTEGER,
  "graph" JSONB NOT NULL, "stopWhenClosed" BOOLEAN NOT NULL DEFAULT true, "isActive" BOOLEAN NOT NULL DEFAULT false, "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "runCount" INTEGER NOT NULL DEFAULT 0, "lastRunAt" TIMESTAMP(3), "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationFlow_pkey" PRIMARY KEY ("id"));
CREATE INDEX "AutomationFlow_tenantId_workspaceId_trigger_idx" ON "AutomationFlow"("tenantId", "workspaceId", "trigger");
CREATE TABLE "AutomationFlowRun" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "flowId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "event" TEXT NOT NULL, "nodeId" TEXT, "status" TEXT NOT NULL DEFAULT 'running',
  "nextAt" TIMESTAMP(3), "log" JSONB NOT NULL DEFAULT '[]', "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationFlowRun_pkey" PRIMARY KEY ("id"));
CREATE INDEX "AutomationFlowRun_tenantId_flowId_leadId_idx" ON "AutomationFlowRun"("tenantId", "flowId", "leadId");
CREATE INDEX "AutomationFlowRun_status_nextAt_idx" ON "AutomationFlowRun"("status", "nextAt");
ALTER TABLE "AutomationFlowRun" ADD CONSTRAINT "AutomationFlowRun_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "AutomationFlow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['AutomationFlow', 'AutomationFlowRun']) AS t;
