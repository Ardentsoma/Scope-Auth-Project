-- Make the `publicId` column default a UUIDv4 instead of a cuid.
--
-- `publicId` is the only identifier that appears in URLs, so its unguessability
-- is part of the access-control story. A cuid embeds a base36 timestamp and a
-- block counter, so an attacker who knows roughly when a row was created can
-- narrow the search space considerably; it is collision-resistant by design but
-- explicitly not a cryptographically secure generator.
--
-- `gen_random_uuid()` produces a v4 UUID: 122 bits from the CSPRNG, with the
-- version and variant bits fixed, which makes guessing a live id infeasible.
-- Existing rows are untouched — only the default for future inserts changes,
-- and every id is still TEXT, so no rewriting or backfill is required.
ALTER TABLE "briefs" ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid()::text;
ALTER TABLE "brief_assets" ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid()::text;
