-- Customer merge also moves invoices, quotes, payments, tickets, calls, conversations and process runs (and undo moves them back).
ALTER TABLE "CustomerMerge" ADD COLUMN "movedOther" JSONB NOT NULL DEFAULT '{}';
