-- Slice 2.8: meeting booking links, Facebook pages for Lead Ads, connected mailboxes and email tracking.
CREATE TABLE "BookingLink" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "hostId" TEXT NOT NULL, "slug" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT,
  "durationMin" INTEGER NOT NULL DEFAULT 30, "bufferMin" INTEGER NOT NULL DEFAULT 0, "noticeHours" INTEGER NOT NULL DEFAULT 4, "horizonDays" INTEGER NOT NULL DEFAULT 30, "hours" JSONB NOT NULL, "location" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true, "isArchived" BOOLEAN NOT NULL DEFAULT false, "bookings" INTEGER NOT NULL DEFAULT 0, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "BookingLink_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "BookingLink_tenantId_slug_key" ON "BookingLink"("tenantId", "slug");
CREATE INDEX "BookingLink_tenantId_workspaceId_idx" ON "BookingLink"("tenantId", "workspaceId");
CREATE TABLE "Booking" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "linkId" TEXT NOT NULL, "hostId" TEXT NOT NULL, "leadId" TEXT, "taskId" TEXT, "name" TEXT NOT NULL, "mobile" TEXT, "email" TEXT, "note" TEXT,
  "startAt" TIMESTAMP(3) NOT NULL, "endAt" TIMESTAMP(3) NOT NULL, "status" TEXT NOT NULL DEFAULT 'booked', "cancelTokenHash" TEXT NOT NULL, "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Booking_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Booking_tenantId_hostId_startAt_idx" ON "Booking"("tenantId", "hostId", "startAt");
CREATE INDEX "Booking_tenantId_linkId_startAt_idx" ON "Booking"("tenantId", "linkId", "startAt");
CREATE INDEX "Booking_tenantId_cancelTokenHash_idx" ON "Booking"("tenantId", "cancelTokenHash");
-- One person cannot be booked twice at the same moment.
CREATE UNIQUE INDEX "Booking_one_per_slot" ON "Booking"("tenantId", "hostId", "startAt") WHERE "status" = 'booked';
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "BookingLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "MetaPage" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "pageId" TEXT NOT NULL, "name" TEXT NOT NULL, "tokenEncrypted" TEXT, "status" TEXT NOT NULL DEFAULT 'pending', "workspaceId" TEXT,
  "formRoutes" JSONB NOT NULL DEFAULT '{}', "leads" INTEGER NOT NULL DEFAULT 0, "lastLeadAt" TIMESTAMP(3), "lastError" TEXT, "connectedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "MetaPage_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "MetaPage_tenantId_pageId_key" ON "MetaPage"("tenantId", "pageId");
-- A Facebook page can feed only one organization at a time.
CREATE UNIQUE INDEX "MetaPage_one_active" ON "MetaPage"("pageId") WHERE "status" = 'active';
CREATE TABLE "MailAccount" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "userId" TEXT NOT NULL, "provider" TEXT NOT NULL, "email" TEXT NOT NULL, "tokensEncrypted" TEXT, "status" TEXT NOT NULL DEFAULT 'active',
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "syncedTo" TIMESTAMP(3), "lastSyncAt" TIMESTAMP(3), "lastError" TEXT, "stored" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "MailAccount_tenantId_userId_provider_key" ON "MailAccount"("tenantId", "userId", "provider");
CREATE INDEX "MailAccount_status_lastSyncAt_idx" ON "MailAccount"("status", "lastSyncAt");
ALTER TABLE "Message" ADD COLUMN "subject" TEXT, ADD COLUMN "trackToken" TEXT, ADD COLUMN "openedAt" TIMESTAMP(3), ADD COLUMN "openCount" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "clickedAt" TIMESTAMP(3), ADD COLUMN "clickCount" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "Message_trackToken_key" ON "Message"("trackToken");
SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY['BookingLink', 'Booking', 'MetaPage', 'MailAccount']) AS t;
