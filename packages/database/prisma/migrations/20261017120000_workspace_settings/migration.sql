-- AlterTable
ALTER TABLE "Pipeline" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LeadField" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceOption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WorkspaceOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadField_workspaceId_key_key" ON "LeadField"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceOption_workspaceId_kind_value_key" ON "WorkspaceOption"("workspaceId", "kind", "value");

-- AddForeignKey
ALTER TABLE "LeadField" ADD CONSTRAINT "LeadField_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceOption" ADD CONSTRAINT "WorkspaceOption_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tenant isolation for the new tables.
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['LeadField', 'WorkspaceOption']) AS t;
