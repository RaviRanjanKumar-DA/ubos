-- Slice 3.5: product gallery, course and software access with validity, renewal leads.
ALTER TABLE "Package" ADD COLUMN "accessKind" TEXT NOT NULL DEFAULT 'none', ADD COLUMN "validityDays" INTEGER, ADD COLUMN "renewBeforeDays" INTEGER NOT NULL DEFAULT 30, ADD COLUMN "remindCustomer" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "showInGallery" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "offerPaise" INTEGER, ADD COLUMN "photoKey" TEXT, ADD COLUMN "photoType" TEXT, ADD COLUMN "brochureUrl" TEXT;
ALTER TABLE "CustomerMerge" ADD COLUMN "movedAccessIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE TABLE "WorkspaceGallery" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "slug" TEXT NOT NULL, "title" TEXT NOT NULL, "intro" TEXT, "whatsappNumber" TEXT, "isActive" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "WorkspaceGallery_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "WorkspaceGallery_workspaceId_key" ON "WorkspaceGallery"("workspaceId");
CREATE UNIQUE INDEX "WorkspaceGallery_tenantId_slug_key" ON "WorkspaceGallery"("tenantId", "slug");
CREATE TABLE "CustomerAccess" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "packageId" TEXT NOT NULL, "leadId" TEXT, "startsAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3), "status" TEXT NOT NULL DEFAULT 'active', "revokeReason" TEXT,
  "licenceEncrypted" TEXT, "licenceLast4" TEXT, "notes" TEXT, "reminderStage" INTEGER NOT NULL DEFAULT 0, "renewalLeadId" TEXT, "renewedAt" TIMESTAMP(3), "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "CustomerAccess_pkey" PRIMARY KEY ("id"));
CREATE INDEX "CustomerAccess_tenantId_workspaceId_expiresAt_idx" ON "CustomerAccess"("tenantId", "workspaceId", "expiresAt");
CREATE INDEX "CustomerAccess_tenantId_customerId_idx" ON "CustomerAccess"("tenantId", "customerId");
ALTER TABLE "CustomerAccess" ADD CONSTRAINT "CustomerAccess_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerAccess" ADD CONSTRAINT "CustomerAccess_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['WorkspaceGallery', 'CustomerAccess']) AS t;
