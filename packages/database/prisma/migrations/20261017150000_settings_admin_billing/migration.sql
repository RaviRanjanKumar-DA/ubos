-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "score" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LeadField" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LeadStage" ADD COLUMN     "color" TEXT,
ADD COLUMN     "followUpDays" INTEGER,
ADD COLUMN     "requiredFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "setStatus" TEXT,
ADD COLUMN     "slaDays" INTEGER;

-- AlterTable
ALTER TABLE "OrganizationSetting" ADD COLUMN     "leadIdentifier" TEXT NOT NULL DEFAULT 'mobile';

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "displayH1" TEXT NOT NULL DEFAULT 'name',
ADD COLUMN     "displayH2" TEXT NOT NULL DEFAULT 'mobile';

-- AlterTable
ALTER TABLE "WorkspaceOption" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CustomAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "code" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "fields" JSONB NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadActionResponse" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActionResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformProduct" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "planCode" TEXT,
    "priceMonthlyPaise" INTEGER,
    "priceOncePaise" INTEGER,
    "annualDiscountPct" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlatformProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "cycle" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "subtotalPaise" INTEGER NOT NULL,
    "gstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "note" TEXT,

    CONSTRAINT "TenantOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomAction_tenantId_code_key" ON "CustomAction"("tenantId", "code");

-- CreateIndex
CREATE INDEX "LeadActionResponse_leadId_idx" ON "LeadActionResponse"("leadId");

-- CreateIndex
CREATE INDEX "LeadActionResponse_actionId_idx" ON "LeadActionResponse"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformProduct_code_key" ON "PlatformProduct"("code");

-- CreateIndex
CREATE UNIQUE INDEX "TenantOrder_number_key" ON "TenantOrder"("number");

-- CreateIndex
CREATE INDEX "TenantOrder_tenantId_createdAt_idx" ON "TenantOrder"("tenantId", "createdAt");


-- Tenant isolation for the new tenant tables; the product catalogue is platform-managed (read-only for tenants).
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['CustomAction', 'LeadActionResponse', 'TenantOrder']) AS t;
REVOKE INSERT, UPDATE, DELETE ON "PlatformProduct" FROM ubos_app;

-- Existing data: stage timers start at lead creation; defaults for call feedback and lead status.
UPDATE "Lead" SET "stageChangedAt" = "createdAt";
INSERT INTO "WorkspaceOption" ("id", "tenantId", "workspaceId", "kind", "value", "label", "position", "connected", "isDefault")
SELECT gen_random_uuid()::text, w."tenantId", w.id, 'call_disposition', 'connected', 'Connected', -1, true, true FROM "Workspace" w
ON CONFLICT DO NOTHING;
UPDATE "WorkspaceOption" SET "isDefault" = true WHERE "kind" = 'lead_status' AND "value" = 'fresh';
