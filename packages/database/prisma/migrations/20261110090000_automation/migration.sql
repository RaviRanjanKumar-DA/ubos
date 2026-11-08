-- Slice 2.5: automation rules, background events, run log, sequences.
CREATE TABLE "AutomationRule" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "trigger" TEXT NOT NULL, "idleDays" INTEGER,
  "conditions" JSONB NOT NULL DEFAULT '[]', "actions" JSONB NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true, "isArchived" BOOLEAN NOT NULL DEFAULT false, "runCount" INTEGER NOT NULL DEFAULT 0,
  "lastRunAt" TIMESTAMP(3), "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id"));
CREATE INDEX "AutomationRule_tenantId_workspaceId_trigger_idx" ON "AutomationRule"("tenantId", "workspaceId", "trigger");
CREATE TABLE "AutomationEvent" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT, "event" TEXT NOT NULL, "data" JSONB NOT NULL, "depth" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" TIMESTAMP(3), CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id"));
CREATE INDEX "AutomationEvent_status_createdAt_idx" ON "AutomationEvent"("status", "createdAt");
CREATE TABLE "AutomationRun" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "ruleId" TEXT NOT NULL, "event" TEXT NOT NULL, "leadId" TEXT, "status" TEXT NOT NULL, "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id"));
CREATE INDEX "AutomationRun_tenantId_ruleId_createdAt_idx" ON "AutomationRun"("tenantId", "ruleId", "createdAt");
CREATE INDEX "AutomationRun_ruleId_leadId_createdAt_idx" ON "AutomationRun"("ruleId", "leadId", "createdAt");
CREATE TABLE "Sequence" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "steps" JSONB NOT NULL, "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
  "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Sequence_tenantId_workspaceId_idx" ON "Sequence"("tenantId", "workspaceId");
CREATE TABLE "SequenceEnrollment" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "sequenceId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "stepIndex" INTEGER NOT NULL DEFAULT 0, "nextAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active', "stopReason" TEXT, "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SequenceEnrollment_pkey" PRIMARY KEY ("id"));
CREATE INDEX "SequenceEnrollment_status_nextAt_idx" ON "SequenceEnrollment"("status", "nextAt");
CREATE INDEX "SequenceEnrollment_tenantId_leadId_idx" ON "SequenceEnrollment"("tenantId", "leadId");
ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['AutomationRule', 'AutomationEvent', 'AutomationRun', 'Sequence', 'SequenceEnrollment']) AS t;
