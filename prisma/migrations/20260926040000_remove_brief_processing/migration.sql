-- Remove brief processing. The AI structuring step is not part of this project
-- yet, so the state machine and the columns it wrote are being removed rather
-- than left dormant: every one of them was empty, and an unused
-- `processing_failed` status on a brief that can never fail to process is
-- worse than no status at all.
--
-- What goes:
--   rawBriefText    the placeholder text generated at upload for the AI to read
--   status          unprocessed / processed / processing_failed
--   processedAt     when a successful run finished
--   processingError why the last run failed
--   deadline, deliverables, scopeNotes, budgetNotes
--                   the structured output columns
--
-- `title` is untouched: it is entered by the person, not by processing.
--
-- The RLS policies are untouched, and never referenced any of these columns.
-- `updatedAt` has no database default (Prisma writes it), so dropping columns
-- leaves it NOT NULL with nothing to backfill.

DROP INDEX IF EXISTS "briefs_userId_status_idx";

ALTER TABLE "briefs"
  DROP COLUMN "rawBriefText",
  DROP COLUMN "status",
  DROP COLUMN "processedAt",
  DROP COLUMN "processingError",
  DROP COLUMN "deadline",
  DROP COLUMN "deliverables",
  DROP COLUMN "scopeNotes",
  DROP COLUMN "budgetNotes";

DROP TYPE IF EXISTS "BriefStatus";
