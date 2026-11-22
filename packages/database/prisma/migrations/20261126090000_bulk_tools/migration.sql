-- Slice 4.2: deleting leads (kept and restorable) and cancelling tasks.
ALTER TABLE "Lead" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedById" TEXT, ADD COLUMN "deleteReason" TEXT;
CREATE INDEX "Lead_tenantId_deletedAt_idx" ON "Lead"("tenantId", "deletedAt");
-- A cancelled task is also marked done, so every "open tasks" list leaves it out.
ALTER TABLE "Task" ADD COLUMN "cancelledAt" TIMESTAMP(3), ADD COLUMN "cancelledById" TEXT;
