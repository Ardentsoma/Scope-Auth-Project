import "server-only";

import { randomUUID } from "node:crypto";
import { type Prisma } from "@prisma/client";
import { withBriefScope } from "@/lib/briefs/scope";
import type { CreateBriefInput, UpdateBriefInput } from "@/lib/validation/brief";

/**
 * Brief data access.
 *
 * ── The access-control contract for this file ────────────────────────────────
 * 1. Every exported function takes the authenticated `userId` as its first
 *    argument. There is no "trusted internal" overload that skips it.
 * 2. Every function runs inside `withBriefScope`, so the database's RLS policy
 *    is active for the whole transaction and would refuse cross-user rows even
 *    if a filter here were wrong.
 * 3. Every single query ALSO carries an explicit `userId` in its WHERE clause.
 *    Layers 2 and 3 are independent: either one alone would contain the bug,
 *    so a mistake in the other is not a data leak.
 * 4. Writes are structurally scoped with `updateMany`/`deleteMany` filtered on
 *    BOTH `publicId` and `userId` — never an `update`/`delete` by id that was
 *    merely preceded by an ownership check.
 * 5. The internal `id` and `userId` columns are never returned; callers only
 *    ever see `publicId`.
 *
 * There is no soft delete: deletes are hard deletes, so a deleted brief is gone
 * rather than lingering behind a timestamp.
 *
 * A brief is a title and a set of documents. There is no processing state:
 * the AI structuring step is not part of this project yet, so nothing here
 * derives, caches or invalidates an outline, and there is no status to gate on.
 */

export interface BriefDto {
  publicId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

const briefSelect = {
  publicId: true,
  title: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BriefSelect;

type BriefRow = Prisma.BriefGetPayload<{ select: typeof briefSelect }>;

function toDto(row: BriefRow): BriefDto {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Upload. Inserts a brief owned by the caller and immediately returns it.
 *
 * This is a plain write: nothing is derived from the uploaded documents, and
 * nothing is contacted. `userId` comes from the session, never the request body.
 * RLS's WITH CHECK clause independently rejects the insert if the id were ever
 * wrong.
 */
export async function createBrief(
  userId: string,
  input: CreateBriefInput
): Promise<BriefDto> {
  return withBriefScope(userId, async (tx) => {
    const brief = await tx.brief.create({
      data: {
        // A UUIDv4 from the CSPRNG, not a cuid. See the schema's `publicId`
        // note: this id is the only thing standing between a stranger and
        // somebody else's brief, so it must not be derivable from anything
        // guessable such as the creation time.
        publicId: randomUUID(),
        userId,
        title: input.title?.trim() ?? null,
      },
      select: briefSelect,
    });

    return toDto(brief);
  });
}

/**
 * Lists every brief owned by the caller, newest first.
 */
export async function listBriefs(userId: string): Promise<BriefDto[]> {
  return withBriefScope(userId, async (tx) => {
    const briefs = await tx.brief.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: briefSelect,
    });

    return briefs.map(toDto);
  });
}

/**
 * Fetches one brief by its public id, scoped to the owner in the query itself.
 *
 * Returns null both when the brief does not exist and when it belongs to
 * somebody else. Callers must map both cases to the same 404 so that a caller
 * cannot use the response to discover whether an id exists.
 */
export async function getBrief(
  userId: string,
  publicId: string
): Promise<BriefDto | null> {
  return withBriefScope(userId, async (tx) => {
    const brief = await tx.brief.findFirst({
      where: { publicId, userId },
      select: briefSelect,
    });

    return brief ? toDto(brief) : null;
  });
}

/**
 * Applies a partial edit to a brief. The title is the only editable field.
 *
 * The write is scoped by publicId AND userId, and no field is ever taken as
 * authoritative from the caller beyond the title itself.
 */
export async function updateBrief(
  userId: string,
  publicId: string,
  input: UpdateBriefInput
): Promise<{ brief: BriefDto } | { notFound: true }> {
  return withBriefScope(userId, async (tx) => {
    const data: Prisma.BriefUpdateManyMutationInput = {};

    if (input.title !== undefined) {
      data.title = input.title ? input.title.trim() : null;
    }

    // Nothing to change. Still report the brief so the caller gets a 200 with
    // current state rather than a validation error, but do not issue a write
    // with an empty SET clause.
    if (Object.keys(data).length === 0) {
      const unchanged = await tx.brief.findFirst({
        where: { publicId, userId },
        select: briefSelect,
      });

      return unchanged ? { brief: toDto(unchanged) } : { notFound: true };
    }

    // The write itself is scoped by publicId AND userId. `count === 0` means the
    // row stopped matching (deleted concurrently, or never was ours).
    const result = await tx.brief.updateMany({
      where: { publicId, userId },
      data,
    });

    if (result.count === 0) {
      return { notFound: true };
    }

    const updated = await tx.brief.findFirst({
      where: { publicId, userId },
      select: briefSelect,
    });

    if (!updated) {
      return { notFound: true };
    }

    return { brief: toDto(updated) };
  });
}

/**
 * Hard-deletes a brief owned by the caller.
 *
 * A single scoped statement: there is no preliminary "does it exist / do I own
 * it" read that a write could be separated from. `count === 0` covers both
 * "not yours" and "does not exist", which the route reports as one 404.
 */
export async function deleteBrief(
  userId: string,
  publicId: string
): Promise<{ success: true } | { notFound: true }> {
  // The brief's files are rows, and their bytes are columns on those rows, so
  // ON DELETE CASCADE takes the documents with it in the same statement. There
  // is nothing to collect beforehand and nothing to clean up afterwards: no
  // window in which the database is correct but files are orphaned somewhere
  // else, and no best-effort cleanup that can silently fail.
  return withBriefScope(userId, async (tx) => {
    const result = await tx.brief.deleteMany({
      where: { publicId, userId },
    });

    if (result.count === 0) {
      return { notFound: true as const };
    }

    return { success: true as const };
  });
}
