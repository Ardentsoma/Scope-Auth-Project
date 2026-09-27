-- Reconcile schema objects that exist in neither the migration history nor the
-- Prisma schema's own expectations.
--
-- `prisma migrate diff` against a database built purely by `migrate deploy`
-- reported two objects missing, and the same two were missing on the live
-- database: neither had ever been created by a migration. They exist in the
-- live schema only because the table was added to `schema.prisma` and pushed
-- without a migration, so a fresh deploy silently produced a database the
-- codebase did not expect.
--
--   1. `AuditLog` — created on the live database with no migration behind it.
--      The application writes to it, so a fresh deploy would lose audit records
--      and fail any code path that inserts one.
--   2. `briefs (userId, title)` — declared by the `Brief` model but never
--      created by a migration, so the index supporting the owner's brief list
--      was absent on any database not patched by hand.
--
-- Every statement is guarded so this applies cleanly to BOTH cases: a database
-- that already has these objects (the live one) and a fresh one built from
-- scratch, which needs them created. `CREATE TABLE IF NOT EXISTS` cannot
-- express the indexes or the foreign key, so those are guarded explicitly.

-- 1. AuditLog and its indexes.
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditLog_userId_idx" ON "AuditLog"("userId");
CREATE INDEX IF NOT EXISTS "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'AuditLog_userId_fkey' AND conrelid = '"AuditLog"'::regclass
  ) THEN
    ALTER TABLE "AuditLog"
      ADD CONSTRAINT "AuditLog_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$do$;

-- 2. The index the `Brief` model declares for the owner's brief list.
CREATE INDEX IF NOT EXISTS "briefs_userId_title_idx" ON "briefs"("userId", "title");
