-- AlterTable
ALTER TABLE "PlatformUser" ADD COLUMN     "failedLogins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLogins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "username" TEXT;

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "platformUserId" TEXT,
    "refreshHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSetting" (
    "tenantId" TEXT NOT NULL,
    "sessionIdleMinutes" INTEGER NOT NULL DEFAULT 480,
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "require2faRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "loginMethods" TEXT[] DEFAULT ARRAY['password', 'google', 'microsoft', 'email_code']::TEXT[],
    "allowedEmailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxFailedLogins" INTEGER NOT NULL DEFAULT 5,
    "lockMinutes" INTEGER NOT NULL DEFAULT 15,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSetting_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "LoginCode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshHash_key" ON "Session"("refreshHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_platformUserId_idx" ON "Session"("platformUserId");

-- CreateIndex
CREATE INDEX "LoginCode_tenantId_userId_idx" ON "LoginCode"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_username_key" ON "User"("tenantId", "username");


-- Tenant isolation for the new tables (see 20261017090000_tenant_isolation).
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['Session', 'LoginCode', 'OrganizationSetting']) AS t;

-- Security settings row for every existing organization.
INSERT INTO "OrganizationSetting" ("tenantId", "updatedAt") SELECT id, now() FROM "Tenant" ON CONFLICT DO NOTHING;
