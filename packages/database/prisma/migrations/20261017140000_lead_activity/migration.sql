-- DropIndex
DROP INDEX "Customer_alternateMobiles_idx";

-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "importId" TEXT,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "lastDisposition" TEXT,
ADD COLUMN     "nextFollowUpAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "assignmentCursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "assignmentMode" TEXT NOT NULL DEFAULT 'round_robin',
ADD COLUMN     "assignmentUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stickyOwner" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "WorkspaceOption" ADD COLUMN     "connected" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LeadActivity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "disposition" TEXT,
    "connected" BOOLEAN,
    "durationSec" INTEGER,
    "remark" TEXT,
    "data" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadImport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "created" INTEGER NOT NULL,
    "linked" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadActivity_leadId_createdAt_idx" ON "LeadActivity"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadActivity_tenantId_workspaceId_createdAt_idx" ON "LeadActivity"("tenantId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadImport_tenantId_workspaceId_createdAt_idx" ON "LeadImport"("tenantId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "FollowUp_tenantId_userId_doneAt_dueAt_idx" ON "FollowUp"("tenantId", "userId", "doneAt", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUp_leadId_idx" ON "FollowUp"("leadId");

-- CreateIndex
CREATE INDEX "Lead_tenantId_nextFollowUpAt_idx" ON "Lead"("tenantId", "nextFollowUpAt");

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tenant isolation for the new tables.
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['LeadActivity', 'LeadImport']) AS t;

-- Default lead statuses and call dispositions for existing workspaces.
INSERT INTO "WorkspaceOption" ("id", "tenantId", "workspaceId", "kind", "value", "label", "position", "connected")
SELECT gen_random_uuid()::text, w."tenantId", w.id, v.kind, v.value, v.label, v.position, v.connected
FROM "Workspace" w
CROSS JOIN (VALUES
  ('lead_status', 'fresh', 'Fresh', 0, false), ('lead_status', 'hot', 'Hot', 1, false),
  ('lead_status', 'warm', 'Warm', 2, false), ('lead_status', 'cold', 'Cold', 3, false),
  ('call_disposition', 'interested', 'Connected – Interested', 0, true),
  ('call_disposition', 'not_interested', 'Connected – Not interested', 1, true),
  ('call_disposition', 'call_back', 'Connected – Call back later', 2, true),
  ('call_disposition', 'not_answered', 'Not answered', 3, false),
  ('call_disposition', 'busy', 'Busy', 4, false),
  ('call_disposition', 'switched_off', 'Switched off / Not reachable', 5, false),
  ('call_disposition', 'wrong_number', 'Wrong number', 6, false)
) AS v(kind, value, label, position, connected)
ON CONFLICT DO NOTHING;
