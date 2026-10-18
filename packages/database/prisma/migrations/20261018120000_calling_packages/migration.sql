-- Calling packages: recording retention per plan; organization recording storage choice.
ALTER TABLE "Plan" ADD COLUMN "recordingRetentionDays" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "OrganizationSetting" ADD COLUMN "recordingMode" TEXT NOT NULL DEFAULT 'ubos', ADD COLUMN "recordingRetentionDays" INTEGER;
