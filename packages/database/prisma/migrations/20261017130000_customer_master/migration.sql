-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "alternateMobiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "city" TEXT,
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "panHash" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "CustomerMerge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "primaryId" TEXT NOT NULL,
    "duplicateId" TEXT NOT NULL,
    "movedLeadIds" TEXT[],
    "movedPackageIds" TEXT[],
    "filledFields" JSONB NOT NULL,
    "reason" TEXT,
    "mergedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "CustomerMerge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerDuplicateDismissal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerAId" TEXT NOT NULL,
    "customerBId" TEXT NOT NULL,
    "dismissedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerDuplicateDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerMerge_tenantId_primaryId_idx" ON "CustomerMerge"("tenantId", "primaryId");

-- CreateIndex
CREATE INDEX "CustomerMerge_tenantId_duplicateId_idx" ON "CustomerMerge"("tenantId", "duplicateId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDuplicateDismissal_tenantId_customerAId_customerBId_key" ON "CustomerDuplicateDismissal"("tenantId", "customerAId", "customerBId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_panHash_idx" ON "Customer"("tenantId", "panHash");


-- Tenant isolation for the new tables.
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['CustomerMerge', 'CustomerDuplicateDismissal']) AS t;

-- One active customer per mobile number in an organization (merged records are excluded).
CREATE UNIQUE INDEX "Customer_active_mobile_key" ON "Customer" ("tenantId", "mobile")
  WHERE "mobile" IS NOT NULL AND "mergedIntoId" IS NULL;

-- Fast lookups for duplicate detection: alternate mobiles, case-insensitive email, similar names.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Customer_alternateMobiles_idx" ON "Customer" USING GIN ("alternateMobiles");
CREATE INDEX "Customer_email_lower_idx" ON "Customer" ("tenantId", lower("email"));
CREATE INDEX "Customer_name_trgm_idx" ON "Customer" USING GIN (lower("name") gin_trgm_ops);
