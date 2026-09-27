-- Briefs table + row-level security.
--
-- Applied by hand (not `prisma migrate dev`) because the local migrations
-- directory is behind the database, and `migrate dev` offers to reset the
-- whole schema to reconcile it, which would destroy unrelated data.

-- CreateEnum
CREATE TYPE "BriefStatus" AS ENUM ('unprocessed', 'processed', 'processing_failed');

-- CreateTable
CREATE TABLE "briefs" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawBriefText" TEXT NOT NULL,
    "status" "BriefStatus" NOT NULL DEFAULT 'unprocessed',
    "title" TEXT,
    "deadline" TEXT,
    "deliverables" TEXT,
    "scopeNotes" TEXT,
    "budgetNotes" TEXT,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "briefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "briefs_publicId_key" ON "briefs"("publicId");

-- CreateIndex
CREATE INDEX "briefs_userId_createdAt_idx" ON "briefs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: the authoritative access-control boundary for briefs.
--
-- ENABLE alone is not enough. The application connects as `scope`, which owns
-- this table, and Postgres exempts a table's owner from its own RLS policies.
-- FORCE is therefore mandatory: without it every policy below would be
-- silently ignored by the one role that matters.
ALTER TABLE "briefs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "briefs" FORCE ROW LEVEL SECURITY;

-- One policy governs every operation (SELECT/INSERT/UPDATE/DELETE).
--   USING      -> which existing rows may be read, updated or deleted
--   WITH CHECK -> what userId a newly written row is allowed to carry, so a
--                 bug that tries to write another user's id is rejected too.
--
-- `current_setting(..., true)` yields NULL when the app never set the variable
-- for this transaction. Comparing a NOT NULL column to NULL is never true, so
-- an unscoped connection sees zero briefs: the policy fails closed.
--
-- The application sets the variable per request in
-- src/lib/briefs/scope.ts via set_config(..., is_local => true), which scopes
-- it to a single transaction and resets it on commit or rollback.
CREATE POLICY "briefs_owner_isolation" ON "briefs"
  FOR ALL
  TO PUBLIC
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
