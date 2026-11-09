-- Slice 2.7: help desk (tickets with SLA, conversation, SLA targets) and knowledge base.
CREATE TABLE "Ticket" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "number" INTEGER NOT NULL, "customerId" TEXT NOT NULL, "leadId" TEXT, "subject" TEXT NOT NULL, "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open', "priority" TEXT NOT NULL DEFAULT 'normal', "category" TEXT, "source" TEXT NOT NULL DEFAULT 'manual', "assigneeId" TEXT, "createdById" TEXT NOT NULL,
  "firstResponseDueAt" TIMESTAMP(3) NOT NULL, "resolutionDueAt" TIMESTAMP(3) NOT NULL, "firstRespondedAt" TIMESTAMP(3), "pausedAt" TIMESTAMP(3), "resolvedAt" TIMESTAMP(3), "closedAt" TIMESTAMP(3), "breachNotifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Ticket_tenantId_number_key" ON "Ticket"("tenantId", "number");
CREATE INDEX "Ticket_tenantId_workspaceId_status_idx" ON "Ticket"("tenantId", "workspaceId", "status");
CREATE INDEX "Ticket_tenantId_customerId_idx" ON "Ticket"("tenantId", "customerId");
CREATE INDEX "Ticket_tenantId_assigneeId_status_idx" ON "Ticket"("tenantId", "assigneeId", "status");
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "TicketMessage" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "ticketId" TEXT NOT NULL, "authorId" TEXT, "kind" TEXT NOT NULL, "body" TEXT NOT NULL, "emailStatus" TEXT NOT NULL DEFAULT 'none',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id"));
CREATE INDEX "TicketMessage_tenantId_ticketId_createdAt_idx" ON "TicketMessage"("tenantId", "ticketId", "createdAt");
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "TicketSla" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "priority" TEXT NOT NULL, "firstResponseMin" INTEGER NOT NULL, "resolutionMin" INTEGER NOT NULL, CONSTRAINT "TicketSla_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "TicketSla_workspaceId_priority_key" ON "TicketSla"("workspaceId", "priority");
CREATE INDEX "TicketSla_tenantId_idx" ON "TicketSla"("tenantId");
CREATE TABLE "KbArticle" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "title" TEXT NOT NULL, "body" TEXT NOT NULL, "category" TEXT, "status" TEXT NOT NULL DEFAULT 'draft', "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT NOT NULL, "updatedById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "KbArticle_pkey" PRIMARY KEY ("id"));
CREATE INDEX "KbArticle_tenantId_workspaceId_status_idx" ON "KbArticle"("tenantId", "workspaceId", "status");
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['Ticket', 'TicketMessage', 'TicketSla', 'KbArticle']) AS t;
