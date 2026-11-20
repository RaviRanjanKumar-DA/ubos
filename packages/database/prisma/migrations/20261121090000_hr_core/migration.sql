-- Slice 3.6: employee records, onboarding and exit checklists, documents, assets, HR reminders.
-- Employee, Asset and AssetAssignment were created empty in the first migration; they gain the fields HR needs.
ALTER TABLE "Employee" ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "name" TEXT NOT NULL DEFAULT '', ADD COLUMN "mobile" TEXT, ADD COLUMN "workEmail" TEXT, ADD COLUMN "designation" TEXT, ADD COLUMN "departmentId" TEXT,
  ADD COLUMN "employmentType" TEXT NOT NULL DEFAULT 'full_time', ADD COLUMN "workLocation" TEXT, ADD COLUMN "dateOfBirth" TIMESTAMP(3), ADD COLUMN "personalEmail" TEXT, ADD COLUMN "address" TEXT,
  ADD COLUMN "emergencyName" TEXT, ADD COLUMN "emergencyPhone" TEXT, ADD COLUMN "panEncrypted" TEXT, ADD COLUMN "panLast4" TEXT, ADD COLUMN "bankEncrypted" TEXT, ADD COLUMN "bankLast4" TEXT,
  ADD COLUMN "ctcPaise" INTEGER, ADD COLUMN "noticeDays" INTEGER NOT NULL DEFAULT 30, ADD COLUMN "exitReason" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "Employee_tenantId_employeeCode_key" ON "Employee"("tenantId", "employeeCode");
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Asset" ADD COLUMN "name" TEXT NOT NULL DEFAULT '', ADD COLUMN "status" TEXT NOT NULL DEFAULT 'available', ADD COLUMN "notes" TEXT, ADD COLUMN "purchasedAt" TIMESTAMP(3),
  ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "Asset_tenantId_tag_key" ON "Asset"("tenantId", "tag");
CREATE TABLE "EmployeeTask" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "employeeId" TEXT NOT NULL, "kind" TEXT NOT NULL, "title" TEXT NOT NULL, "position" INTEGER NOT NULL DEFAULT 0, "doneAt" TIMESTAMP(3), "doneById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "EmployeeTask_pkey" PRIMARY KEY ("id"));
CREATE INDEX "EmployeeTask_tenantId_employeeId_idx" ON "EmployeeTask"("tenantId", "employeeId");
ALTER TABLE "EmployeeTask" ADD CONSTRAINT "EmployeeTask_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "EmployeeDocument" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "employeeId" TEXT NOT NULL, "docType" TEXT NOT NULL, "fileName" TEXT NOT NULL, "fileKey" TEXT NOT NULL, "mimeType" TEXT NOT NULL, "sizeBytes" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3), "isArchived" BOOLEAN NOT NULL DEFAULT false, "uploadedById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id"));
CREATE INDEX "EmployeeDocument_tenantId_employeeId_idx" ON "EmployeeDocument"("tenantId", "employeeId");
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "HrSetting" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "onboardingTasks" JSONB NOT NULL, "exitTasks" JSONB NOT NULL, "docTypes" JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "HrSetting_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "HrSetting_tenantId_key" ON "HrSetting"("tenantId");
CREATE TABLE "ReminderMark" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "key" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ReminderMark_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ReminderMark_tenantId_key_key" ON "ReminderMark"("tenantId", "key");
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['EmployeeTask', 'EmployeeDocument', 'HrSetting', 'ReminderMark']) AS t;
