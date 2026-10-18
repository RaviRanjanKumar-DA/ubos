-- Slice 1.5c: labels, smart views, tasks & meetings, notifications, goals, call scripts, dashboard emails,
-- alternate emails, reminder / digest settings.
ALTER TABLE "User" ADD COLUMN "digestEnabled" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "lastDigestAt" TIMESTAMP(3);
ALTER TABLE "OrganizationSetting" ADD COLUMN "digestHour" INTEGER NOT NULL DEFAULT 9, ADD COLUMN "reminderMinutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "Customer" ADD COLUMN "alternateEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Lead" ADD COLUMN "labelIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "FollowUp" ADD COLUMN "remindedAt" TIMESTAMP(3);

CREATE TABLE "Label" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT, "name" TEXT NOT NULL, "color" TEXT NOT NULL DEFAULT '#5b3cc4',
  "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Label_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Label_tenantId_workspaceId_idx" ON "Label"("tenantId", "workspaceId");

CREATE TABLE "SavedView" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "workspaceId" TEXT, "name" TEXT NOT NULL,
  "query" JSONB NOT NULL, "columns" TEXT[] DEFAULT ARRAY[]::TEXT[], "layout" TEXT NOT NULL DEFAULT 'list', "sharedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id"));
CREATE INDEX "SavedView_tenantId_ownerId_idx" ON "SavedView"("tenantId", "ownerId");

CREATE TABLE "Task" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT, "leadId" TEXT, "type" TEXT NOT NULL DEFAULT 'task',
  "title" TEXT NOT NULL, "notes" TEXT, "dueAt" TIMESTAMP(3) NOT NULL, "durationMin" INTEGER, "location" TEXT, "assigneeId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL, "mentionIds" TEXT[] DEFAULT ARRAY[]::TEXT[], "doneAt" TIMESTAMP(3), "remindedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Task_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Task_tenantId_assigneeId_doneAt_dueAt_idx" ON "Task"("tenantId", "assigneeId", "doneAt", "dueAt");
CREATE INDEX "Task_leadId_idx" ON "Task"("leadId");

CREATE TABLE "Notification" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "userId" TEXT NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL,
  "body" TEXT, "link" TEXT, "readAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Notification_tenantId_userId_readAt_idx" ON "Notification"("tenantId", "userId", "readAt");

CREATE TABLE "Goal" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT, "name" TEXT NOT NULL, "metric" TEXT NOT NULL,
  "period" TEXT NOT NULL DEFAULT 'month', "target" INTEGER NOT NULL, "userId" TEXT, "teamId" TEXT, "createdById" TEXT NOT NULL,
  "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Goal_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Goal_tenantId_userId_idx" ON "Goal"("tenantId", "userId");

CREATE TABLE "CallScript" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "stageId" TEXT, "title" TEXT NOT NULL,
  "body" TEXT NOT NULL, "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "CallScript_pkey" PRIMARY KEY ("id"));
CREATE INDEX "CallScript_tenantId_workspaceId_idx" ON "CallScript"("tenantId", "workspaceId");

CREATE TABLE "DashboardSubscription" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "userId" TEXT NOT NULL, "dashboardId" TEXT NOT NULL,
  "frequency" TEXT NOT NULL DEFAULT 'daily', "hour" INTEGER NOT NULL DEFAULT 9, "lastSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "DashboardSubscription_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "DashboardSubscription_userId_dashboardId_key" ON "DashboardSubscription"("userId", "dashboardId");

SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['Label', 'SavedView', 'Task', 'Notification', 'Goal', 'CallScript', 'DashboardSubscription']) AS t;
