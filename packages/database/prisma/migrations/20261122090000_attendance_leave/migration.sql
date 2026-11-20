-- Slice 3.7: attendance, holidays, leave types, balances and approvals.
-- LeaveRequest was created empty in the first migration; it gains the fields leave needs.
ALTER TABLE "HrSetting" ADD COLUMN "attendance" JSONB;
CREATE TABLE "LeaveType" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "code" TEXT NOT NULL, "name" TEXT NOT NULL, "isPaid" BOOLEAN NOT NULL DEFAULT true, "yearlyDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "accrual" TEXT NOT NULL DEFAULT 'yearly', "carryForwardMax" DOUBLE PRECISION NOT NULL DEFAULT 0, "allowHalfDay" BOOLEAN NOT NULL DEFAULT true, "allowNegative" BOOLEAN NOT NULL DEFAULT false,
  "position" INTEGER NOT NULL DEFAULT 0, "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "LeaveType_tenantId_code_key" ON "LeaveType"("tenantId", "code");
ALTER TABLE "LeaveRequest" ALTER COLUMN "leaveType" SET DEFAULT '',
  ADD COLUMN "leaveTypeId" TEXT, ADD COLUMN "halfDay" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "days" DOUBLE PRECISION NOT NULL DEFAULT 0, ADD COLUMN "reason" TEXT,
  ADD COLUMN "createdById" TEXT, ADD COLUMN "decidedById" TEXT, ADD COLUMN "decidedAt" TIMESTAMP(3), ADD COLUMN "decisionNote" TEXT, ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "LeaveRequest_tenantId_employeeId_idx" ON "LeaveRequest"("tenantId", "employeeId");
CREATE INDEX "LeaveRequest_tenantId_status_idx" ON "LeaveRequest"("tenantId", "status");
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "LeaveAdjustment" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "employeeId" TEXT NOT NULL, "leaveTypeId" TEXT NOT NULL, "year" INTEGER NOT NULL, "days" DOUBLE PRECISION NOT NULL, "reason" TEXT NOT NULL,
  "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LeaveAdjustment_pkey" PRIMARY KEY ("id"));
CREATE INDEX "LeaveAdjustment_tenantId_employeeId_idx" ON "LeaveAdjustment"("tenantId", "employeeId");
ALTER TABLE "LeaveAdjustment" ADD CONSTRAINT "LeaveAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeaveAdjustment" ADD CONSTRAINT "LeaveAdjustment_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "Holiday" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "day" TEXT NOT NULL, "name" TEXT NOT NULL, "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Holiday_tenantId_day_idx" ON "Holiday"("tenantId", "day");
CREATE TABLE "Attendance" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "employeeId" TEXT NOT NULL, "day" TEXT NOT NULL, "checkInAt" TIMESTAMP(3), "checkOutAt" TIMESTAMP(3),
  "inLat" DOUBLE PRECISION, "inLng" DOUBLE PRECISION, "outLat" DOUBLE PRECISION, "outLng" DOUBLE PRECISION, "source" TEXT NOT NULL DEFAULT 'web', "override" TEXT, "note" TEXT, "correctedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Attendance_tenantId_employeeId_day_key" ON "Attendance"("tenantId", "employeeId", "day");
CREATE INDEX "Attendance_tenantId_day_idx" ON "Attendance"("tenantId", "day");
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "AttendanceRequest" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "employeeId" TEXT NOT NULL, "day" TEXT NOT NULL, "checkInAt" TIMESTAMP(3) NOT NULL, "checkOutAt" TIMESTAMP(3) NOT NULL, "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "decidedById" TEXT, "decidedAt" TIMESTAMP(3), "decisionNote" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AttendanceRequest_pkey" PRIMARY KEY ("id"));
CREATE INDEX "AttendanceRequest_tenantId_status_idx" ON "AttendanceRequest"("tenantId", "status");
ALTER TABLE "AttendanceRequest" ADD CONSTRAINT "AttendanceRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['LeaveType', 'LeaveAdjustment', 'Holiday', 'Attendance', 'AttendanceRequest']) AS t;
