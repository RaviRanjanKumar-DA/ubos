-- Slice 1.5d: products / price lists / quotes, approvals, process templates and runs, payments and payment rules,
-- lead team, accepting-new-leads switch, temporary cover.
ALTER TABLE "Workspace" ADD COLUMN "quoteMaxDiscountPct" INTEGER NOT NULL DEFAULT 10, ADD COLUMN "quoteTerms" TEXT;
ALTER TABLE "User" ADD COLUMN "acceptingLeads" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Package" ADD COLUMN "code" TEXT, ADD COLUMN "description" TEXT, ADD COLUMN "category" TEXT,
  ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'unit', ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "PriceList" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false, "validFrom" TIMESTAMP(3), "validTo" TIMESTAMP(3), "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id"));
CREATE INDEX "PriceList_tenantId_workspaceId_idx" ON "PriceList"("tenantId", "workspaceId");

CREATE TABLE "PriceListItem" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "priceListId" TEXT NOT NULL, "packageId" TEXT NOT NULL,
  "pricePaise" INTEGER NOT NULL, "minPricePaise" INTEGER, CONSTRAINT "PriceListItem_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "PriceListItem_priceListId_packageId_key" ON "PriceListItem"("priceListId", "packageId");
ALTER TABLE "PriceListItem" ADD CONSTRAINT "PriceListItem_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceListItem" ADD CONSTRAINT "PriceListItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Quote" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "customerId" TEXT NOT NULL,
  "number" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'draft', "priceListId" TEXT, "validUntil" TIMESTAMP(3),
  "subtotalPaise" INTEGER NOT NULL DEFAULT 0, "discountPaise" INTEGER NOT NULL DEFAULT 0, "taxPaise" INTEGER NOT NULL DEFAULT 0, "totalPaise" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT, "terms" TEXT, "needsApproval" BOOLEAN NOT NULL DEFAULT false, "approvalId" TEXT, "createdById" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3), "decidedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Quote_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Quote_tenantId_number_key" ON "Quote"("tenantId", "number");
CREATE INDEX "Quote_tenantId_leadId_idx" ON "Quote"("tenantId", "leadId");

CREATE TABLE "QuoteItem" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "quoteId" TEXT NOT NULL, "packageId" TEXT, "name" TEXT NOT NULL,
  "qty" INTEGER NOT NULL DEFAULT 1, "listPricePaise" INTEGER NOT NULL, "pricePaise" INTEGER NOT NULL, "gstRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "position" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id"));
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ApprovalRequest" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "leadId" TEXT, "kind" TEXT NOT NULL,
  "entityId" TEXT NOT NULL, "title" TEXT NOT NULL, "details" JSONB, "status" TEXT NOT NULL DEFAULT 'pending', "requestedById" TEXT NOT NULL,
  "decidedById" TEXT, "decidedAt" TIMESTAMP(3), "decisionNote" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ApprovalRequest_tenantId_status_idx" ON "ApprovalRequest"("tenantId", "status");
CREATE INDEX "ApprovalRequest_tenantId_entityId_idx" ON "ApprovalRequest"("tenantId", "entityId");

CREATE TABLE "ProcessTemplate" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
  "trigger" TEXT NOT NULL DEFAULT 'won', "packageIds" TEXT[] DEFAULT ARRAY[]::TEXT[], "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessTemplate_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ProcessTemplate_tenantId_workspaceId_idx" ON "ProcessTemplate"("tenantId", "workspaceId");

CREATE TABLE "ProcessStep" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "templateId" TEXT NOT NULL, "position" INTEGER NOT NULL, "name" TEXT NOT NULL,
  "instructions" TEXT, "assignTo" TEXT NOT NULL DEFAULT 'lead_owner', "assigneeUserId" TEXT, "ownerRoleId" TEXT, "dueDays" INTEGER,
  "fields" JSONB NOT NULL DEFAULT '[]', "minPaymentPct" INTEGER, "requiresApproval" BOOLEAN NOT NULL DEFAULT false, "access" JSONB NOT NULL DEFAULT '{}',
  "isArchived" BOOLEAN NOT NULL DEFAULT false, CONSTRAINT "ProcessStep_pkey" PRIMARY KEY ("id"));
ALTER TABLE "ProcessStep" ADD CONSTRAINT "ProcessStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProcessTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProcessRun" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "templateId" TEXT NOT NULL, "leadId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL, "quoteId" TEXT, "status" TEXT NOT NULL DEFAULT 'active', "dealValuePaise" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3), "cancelledReason" TEXT, "rating" INTEGER, "ratingNote" TEXT,
  "createdById" TEXT NOT NULL, CONSTRAINT "ProcessRun_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ProcessRun_tenantId_leadId_idx" ON "ProcessRun"("tenantId", "leadId");
CREATE INDEX "ProcessRun_tenantId_workspaceId_status_idx" ON "ProcessRun"("tenantId", "workspaceId", "status");

CREATE TABLE "StepRun" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "runId" TEXT NOT NULL, "stepId" TEXT NOT NULL, "position" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "assigneeId" TEXT, "dueAt" TIMESTAMP(3), "data" JSONB NOT NULL DEFAULT '{}', "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3), "completedById" TEXT, "locked" BOOLEAN NOT NULL DEFAULT false, "approvalId" TEXT, "sentBackCount" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "StepRun_pkey" PRIMARY KEY ("id"));
CREATE INDEX "StepRun_runId_idx" ON "StepRun"("runId");
CREATE INDEX "StepRun_tenantId_assigneeId_status_idx" ON "StepRun"("tenantId", "assigneeId", "status");
ALTER TABLE "StepRun" ADD CONSTRAINT "StepRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ProcessRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Payment" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "leadId" TEXT, "runId" TEXT,
  "packageId" TEXT, "amountPaise" INTEGER NOT NULL, "kind" TEXT NOT NULL DEFAULT 'instalment', "mode" TEXT NOT NULL DEFAULT 'upi', "reference" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "note" TEXT, "source" TEXT NOT NULL DEFAULT 'manual', "isVoided" BOOLEAN NOT NULL DEFAULT false,
  "voidReason" TEXT, "voidedById" TEXT, "createdById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Payment_tenantId_runId_idx" ON "Payment"("tenantId", "runId");
CREATE INDEX "Payment_tenantId_customerId_idx" ON "Payment"("tenantId", "customerId");

CREATE TABLE "PaymentRule" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "position" INTEGER NOT NULL DEFAULT 0,
  "minAmountPaise" INTEGER, "maxAmountPaise" INTEGER, "packageIds" TEXT[] DEFAULT ARRAY[]::TEXT[], "action" TEXT NOT NULL,
  "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PaymentRule_pkey" PRIMARY KEY ("id"));
CREATE INDEX "PaymentRule_tenantId_workspaceId_idx" ON "PaymentRule"("tenantId", "workspaceId");

CREATE TABLE "LeadTeamMember" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "userId" TEXT NOT NULL, "roleLabel" TEXT NOT NULL,
  "addedById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "removedAt" TIMESTAMP(3), CONSTRAINT "LeadTeamMember_pkey" PRIMARY KEY ("id"));
CREATE INDEX "LeadTeamMember_tenantId_userId_idx" ON "LeadTeamMember"("tenantId", "userId");
CREATE INDEX "LeadTeamMember_leadId_idx" ON "LeadTeamMember"("leadId");
ALTER TABLE "LeadTeamMember" ADD CONSTRAINT "LeadTeamMember_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "UserCover" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "userId" TEXT NOT NULL, "coverUserId" TEXT NOT NULL, "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL, "note" TEXT, "createdById" TEXT NOT NULL, "cancelledAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserCover_pkey" PRIMARY KEY ("id"));
CREATE INDEX "UserCover_tenantId_userId_idx" ON "UserCover"("tenantId", "userId");
CREATE INDEX "UserCover_tenantId_coverUserId_idx" ON "UserCover"("tenantId", "coverUserId");

SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['PriceList', 'PriceListItem', 'Quote', 'QuoteItem', 'ApprovalRequest', 'ProcessTemplate', 'ProcessStep',
  'ProcessRun', 'StepRun', 'Payment', 'PaymentRule', 'LeadTeamMember', 'UserCover']) AS t;
