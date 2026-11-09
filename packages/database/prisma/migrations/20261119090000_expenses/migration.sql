-- Slice 3.4: expense categories and expenses, for profit and loss.
CREATE TABLE "ExpenseCategory" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "name" TEXT NOT NULL, "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ExpenseCategory_tenantId_name_key" ON "ExpenseCategory"("tenantId", "name");
CREATE TABLE "Expense" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT, "categoryId" TEXT NOT NULL, "spentAt" TIMESTAMP(3) NOT NULL, "amountPaise" INTEGER NOT NULL, "gstPaise" INTEGER NOT NULL DEFAULT 0, "vendor" TEXT, "description" TEXT NOT NULL, "mode" TEXT NOT NULL DEFAULT 'bank', "reference" TEXT, "isVoided" BOOLEAN NOT NULL DEFAULT false, "voidReason" TEXT, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Expense_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Expense_tenantId_spentAt_idx" ON "Expense"("tenantId", "spentAt");
CREATE INDEX "Expense_tenantId_workspaceId_spentAt_idx" ON "Expense"("tenantId", "workspaceId", "spentAt");
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['ExpenseCategory', 'Expense']) AS t;
