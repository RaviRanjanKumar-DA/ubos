-- Previous refresh-token hash, used to detect refresh-token reuse (theft).
ALTER TABLE "Session" ADD COLUMN "prevRefreshHash" TEXT;
CREATE INDEX "Session_prevRefreshHash_idx" ON "Session"("prevRefreshHash");
