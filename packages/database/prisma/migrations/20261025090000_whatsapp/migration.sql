-- Slice 2.3: WhatsApp conversations, messages, templates, broadcasts, opt-out.
ALTER TABLE "Customer" ADD COLUMN "whatsappOptOut" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Conversation" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "channel" TEXT NOT NULL DEFAULT 'whatsapp', "waId" TEXT NOT NULL, "workspaceId" TEXT,
  "customerId" TEXT, "leadId" TEXT, "assigneeId" TEXT, "status" TEXT NOT NULL DEFAULT 'open', "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastInboundAt" TIMESTAMP(3), "unread" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Conversation_tenantId_channel_waId_key" ON "Conversation"("tenantId", "channel", "waId");
CREATE INDEX "Conversation_tenantId_lastMessageAt_idx" ON "Conversation"("tenantId", "lastMessageAt");
CREATE INDEX "Conversation_tenantId_leadId_idx" ON "Conversation"("tenantId", "leadId");

CREATE TABLE "Message" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "direction" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'text',
  "body" TEXT, "templateName" TEXT, "waMessageId" TEXT, "status" TEXT NOT NULL DEFAULT 'received', "error" TEXT, "userId" TEXT, "broadcastId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Message_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Message_tenantId_waMessageId_key" ON "Message"("tenantId", "waMessageId");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

CREATE TABLE "MessageTemplate" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "channel" TEXT NOT NULL DEFAULT 'whatsapp', "name" TEXT NOT NULL,
  "language" TEXT NOT NULL DEFAULT 'en', "category" TEXT NOT NULL DEFAULT 'marketing', "body" TEXT NOT NULL, "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "MessageTemplate_tenantId_channel_name_language_key" ON "MessageTemplate"("tenantId", "channel", "name", "language");

CREATE TABLE "Broadcast" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "templateId" TEXT NOT NULL, "name" TEXT NOT NULL, "total" INTEGER NOT NULL DEFAULT 0,
  "sent" INTEGER NOT NULL DEFAULT 0, "skipped" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id"));

SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['Conversation', 'Message', 'MessageTemplate', 'Broadcast']) AS t;
