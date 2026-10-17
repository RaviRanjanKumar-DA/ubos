-- Setup Guide: steps an organization chose to skip.
ALTER TABLE "OrganizationSetting" ADD COLUMN "setupSkipped" TEXT[] DEFAULT ARRAY[]::TEXT[];
