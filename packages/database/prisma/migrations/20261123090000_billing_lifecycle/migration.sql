-- Slice 3.8a: self-serve trial signup, trial and renewal lifecycle (grace, expired), daily usage snapshots.
-- Platform tables: not tenant data, so no row-level security; only the platform connection uses them.
CREATE TABLE "PlatformSetting" ("id" TEXT NOT NULL DEFAULT 'default', "signupEnabled" BOOLEAN NOT NULL DEFAULT true, "trialDays" INTEGER NOT NULL DEFAULT 14, "trialPlanCode" TEXT NOT NULL DEFAULT 'business',
  "trialLicences" INTEGER NOT NULL DEFAULT 5, "graceDays" INTEGER NOT NULL DEFAULT 7, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id"));
CREATE TABLE "SignupCode" ("id" TEXT NOT NULL, "email" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0, "usedAt" TIMESTAMP(3), "ip" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SignupCode_pkey" PRIMARY KEY ("id"));
CREATE INDEX "SignupCode_email_createdAt_idx" ON "SignupCode"("email", "createdAt");
ALTER TABLE "Tenant" ADD COLUMN "signedUpVia" TEXT NOT NULL DEFAULT 'console', ADD COLUMN "statusChangedAt" TIMESTAMP(3);
-- One snapshot per organization, metric and day, so the hourly job can update today's numbers in place.
CREATE UNIQUE INDEX "UsageRecord_tenantId_metric_periodDay_key" ON "UsageRecord"("tenantId", "metric", "periodDay");
REVOKE INSERT, UPDATE, DELETE ON "PlatformSetting" FROM ubos_app;
REVOKE ALL ON "SignupCode" FROM ubos_app;
