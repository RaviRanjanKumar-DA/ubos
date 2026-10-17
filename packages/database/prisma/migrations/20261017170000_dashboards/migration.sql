-- Slice 1.6: deal value field, stage win probability, saved dashboards.
ALTER TABLE "Workspace" ADD COLUMN "valueFieldKey" TEXT;
ALTER TABLE "LeadStage" ADD COLUMN "winProbability" INTEGER;

CREATE TABLE "Dashboard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "widgets" JSONB NOT NULL,
    "range" TEXT NOT NULL DEFAULT 'this_month',
    "sharedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sharedTeamIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sharedWorkspaceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sharedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultForRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Dashboard_tenantId_ownerId_idx" ON "Dashboard"("tenantId", "ownerId");
SELECT ubos_enable_tenant_rls('Dashboard');
