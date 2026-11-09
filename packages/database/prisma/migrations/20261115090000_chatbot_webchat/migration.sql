-- Slice 2.10: chatbot flows, scheduled messages and website chat.
CREATE TABLE "ChatFlow" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "channel" TEXT NOT NULL DEFAULT 'whatsapp', "trigger" TEXT NOT NULL DEFAULT 'first_message', "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "steps" JSONB NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true, "isArchived" BOOLEAN NOT NULL DEFAULT false, "runs" INTEGER NOT NULL DEFAULT 0, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ChatFlow_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ChatFlow_tenantId_workspaceId_channel_idx" ON "ChatFlow"("tenantId", "workspaceId", "channel");
CREATE TABLE "ChatSession" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "flowId" TEXT NOT NULL, "stepId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'active', "retries" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ChatSession_tenantId_conversationId_idx" ON "ChatSession"("tenantId", "conversationId");
-- One running flow per chat.
CREATE UNIQUE INDEX "ChatSession_one_active" ON "ChatSession"("conversationId") WHERE "status" = 'active';
CREATE TABLE "ScheduledMessage" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "templateId" TEXT NOT NULL, "sendAt" TIMESTAMP(3) NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "error" TEXT, "createdById" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ScheduledMessage_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ScheduledMessage_status_sendAt_idx" ON "ScheduledMessage"("status", "sendAt");
CREATE INDEX "ScheduledMessage_tenantId_leadId_idx" ON "ScheduledMessage"("tenantId", "leadId");
CREATE TABLE "ChatWidget" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "publicKey" TEXT NOT NULL, "greeting" TEXT NOT NULL, "color" TEXT NOT NULL DEFAULT '#4a2bc2', "isActive" BOOLEAN NOT NULL DEFAULT true, "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ChatWidget_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ChatWidget_tenantId_publicKey_key" ON "ChatWidget"("tenantId", "publicKey");
ALTER TABLE "Message" ADD COLUMN "options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['ChatFlow', 'ChatSession', 'ScheduledMessage', 'ChatWidget']) AS t;
