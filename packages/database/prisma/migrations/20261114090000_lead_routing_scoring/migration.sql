-- Slice 2.9: territory and field-based routing rules, and lead scoring by rules.
CREATE TABLE "RoutingRule" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "position" INTEGER NOT NULL DEFAULT 0, "conditions" JSONB NOT NULL, "userIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "cursor" INTEGER NOT NULL DEFAULT 0, "hits" INTEGER NOT NULL DEFAULT 0, "isActive" BOOLEAN NOT NULL DEFAULT true, "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id"));
CREATE INDEX "RoutingRule_tenantId_workspaceId_position_idx" ON "RoutingRule"("tenantId", "workspaceId", "position");
CREATE TABLE "ScoreRule" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "conditions" JSONB NOT NULL, "points" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true, "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ScoreRule_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ScoreRule_tenantId_workspaceId_idx" ON "ScoreRule"("tenantId", "workspaceId");
-- Which rules currently count towards a lead's score, so a rule adds its points once and takes them back when it stops matching.
CREATE TABLE "LeadScoreHit" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "leadId" TEXT NOT NULL, "ruleId" TEXT NOT NULL, "points" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LeadScoreHit_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "LeadScoreHit_leadId_ruleId_key" ON "LeadScoreHit"("leadId", "ruleId");
CREATE INDEX "LeadScoreHit_tenantId_ruleId_idx" ON "LeadScoreHit"("tenantId", "ruleId");
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['RoutingRule', 'ScoreRule', 'LeadScoreHit']) AS t;
