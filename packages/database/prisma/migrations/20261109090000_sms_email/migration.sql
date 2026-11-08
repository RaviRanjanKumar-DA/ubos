-- Slice 2.4: SMS and email templates, opt-outs.
ALTER TABLE "Customer" ADD COLUMN "smsOptOut" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "emailOptOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MessageTemplate" ADD COLUMN "subject" TEXT, ADD COLUMN "dltTemplateId" TEXT, ADD COLUMN "providerTemplateId" TEXT;
