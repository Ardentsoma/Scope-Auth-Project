import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withBriefScope } from "@/lib/briefs/scope";
import type { ValidatedUpload } from "@/lib/validation/asset";
import { MAX_FILES_PER_BRIEF, UploadValidationError } from "@/lib/validation/asset";

/**
 * Brief file (asset) access.
 *
 * Same access-control contract as src/lib/briefs/service.ts:
 *  - every function takes the authenticated `userId` first;
 *  - every function runs inside `withBriefScope`, so the RLS policy on
 *    `brief_assets` is active for the whole transaction;
 *  - every query ALSO filters explicitly on `userId`. `userId` is denormalised
 *    onto the asset row specifically so this is possible without joining
 *    through to the brief first;
 *  - writes are structurally scoped `updateMany`/`deleteMany`/`create` with
 *    `userId` in the statement, never gated by a prior check;
 *  - internal `id`, `userId`, `storageKey` and `content` are never returned to
 *    a client. The last two matter most: `content` is the file body and
 *    `storageKey` is the row's stable key, and neither may travel in a list or
 *    create response.
 *
 * The bytes live in Postgres, in the `content` column, and are written in the
 * same INSERT as the row's metadata inside the scoped transaction. There is no
 * second store to keep in step: a row cannot exist without its bytes, and
 * deleting a row deletes them. `storageKey` remains as the row's stable unique
 * key and is still server-generated as `<userId>/<assetPublicId>`, so a hostile
 * filename cannot influence anything.
 */

export interface BriefAssetDto {
  publicId: string;
  /** The parent brief's PUBLIC id. The internal `id` is never returned. */
  briefPublicId: string;
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
  createdAt: string;
}

const assetSelect = {
  publicId: true,
  brief: { select: { publicId: true } },
  fileName: true,
  contentType: true,
  fileSizeBytes: true,
  createdAt: true,
} satisfies Prisma.BriefAssetSelect;

type AssetRow = Prisma.BriefAssetGetPayload<{ select: typeof assetSelect }>;

function toDto(row: AssetRow): BriefAssetDto {
  return {
    publicId: row.publicId,
    briefPublicId: row.brief.publicId,
    fileName: row.fileName,
    contentType: row.contentType,
    fileSizeBytes: row.fileSizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Server-generated object key. Contains no user input by construction. */
function buildStorageKey(userId: string, assetPublicId: string): string {
  return `${userId}/${assetPublicId}`;
}

export class AssetStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetStorageError";
  }
}

/** Thrown when a scoped write matched no row, i.e. the row is not the caller's. */
export class AssetNotFoundError extends Error {
  constructor() {
    super("Asset not found.");
    this.name = "AssetNotFoundError";
  }
}

/**
 * Stores uploads for a brief and records them, all owner-scoped.
 *
 * Metadata and bytes go in together, in one scoped INSERT per file, so a
 * committed row is always a complete row. There is no window in which the
 * database says a file exists but the bytes are not there, which is the failure
 * mode that having bytes outside the database made possible.
 *
 * A brief may hold at most MAX_FILES_PER_BRIEF files.
 */
export async function createAssetsForBrief(
  userId: string,
  briefPublicId: string,
  uploads: ValidatedUpload[]
): Promise<BriefAssetDto[]> {
  if (uploads.length === 0) return [];
  if (uploads.length > MAX_FILES_PER_BRIEF) {
    throw new UploadValidationError(
      `Too many files. A brief can hold at most ${MAX_FILES_PER_BRIEF}.`
    );
  }

  const rows = await withBriefScope(userId, async (tx) => {
    // The brief must exist AND be owned by this user. Scoped query, so another
    // user's public id simply does not match.
    const brief = await tx.brief.findFirst({
      where: { publicId: briefPublicId, userId },
      select: { id: true },
    });
    if (!brief) {
      throw new AssetStorageError("Brief not found.");
    }

    // Counted through the scoped `brief` relation rather than a bare briefId
    // match, so the count itself cannot be skewed by rows the policy hides.
    const existing = await tx.briefAsset.count({
      where: { userId, brief: { publicId: briefPublicId } },
    });
    if (existing + uploads.length > MAX_FILES_PER_BRIEF) {
      throw new UploadValidationError(
        `A brief can hold at most ${MAX_FILES_PER_BRIEF} files.`
      );
    }

    const created: AssetRow[] = [];
    for (const upload of uploads) {
      // The public id is minted here rather than left to the column default so
      // that the storage key is known BEFORE the insert. That keeps this to a
      // single scoped write: no placeholder-then-update, and therefore no write
      // anywhere that is filtered on something other than the owner.
      const publicId = randomUUID();
      const row = await tx.briefAsset.create({
        data: {
          publicId,
          userId,
          briefId: brief.id,
          fileName: upload.fileName,
          contentType: upload.contentType,
          fileSizeBytes: upload.sizeBytes,
          storageKey: buildStorageKey(userId, publicId),
          content: new Uint8Array(upload.body),
        },
        select: assetSelect,
      });

      created.push(row);
    }
    return created;
  });

  return rows.map(toDto);
}

/** Lists a brief's files, owner-scoped. Takes the brief's PUBLIC id. */
export async function listAssetsForBrief(
  userId: string,
  briefPublicId: string
): Promise<BriefAssetDto[]> {
  return withBriefScope(userId, async (tx) => {
    const assets = await tx.briefAsset.findMany({
      where: { userId, brief: { publicId: briefPublicId } },
      orderBy: { createdAt: "asc" },
      select: assetSelect,
    });
    return assets.map(toDto);
  });
}

/** Lists every file the user owns, newest first, across all briefs. */
export async function listAllAssets(userId: string): Promise<BriefAssetDto[]> {
  return withBriefScope(userId, async (tx) => {
    const assets = await tx.briefAsset.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: assetSelect,
    });
    return assets.map(toDto);
  });
}

export interface OwnedAsset {
  publicId: string;
  briefPublicId: string;
  fileName: string;
  contentType: string;
  content: Uint8Array<ArrayBuffer>;
}

/**
 * Resolves an asset for download, ownership-scoped.
 *
 * Returns null for both "does not exist" and "belongs to someone else" so the
 * route can answer 404 in either case without leaking which it was.
 */
export async function getOwnedAsset(
  userId: string,
  assetPublicId: string
): Promise<OwnedAsset | null> {
  return withBriefScope(userId, async (tx) => {
    const asset = await tx.briefAsset.findFirst({
      where: { publicId: assetPublicId, userId },
      select: {
        publicId: true,
        brief: { select: { publicId: true } },
        fileName: true,
        contentType: true,
        content: true,
      },
    });
    // A row whose bytes are missing is not a servable file, and is
    // indistinguishable from one that never existed as far as callers go.
    if (!asset) return null;
    const { content } = asset;
    if (!content) return null;

    // `content` is re-set after the spread so the narrowed (non-null) type
    // survives; a spread alone would widen it back to `| null`.
    return { ...asset, content, briefPublicId: asset.brief.publicId };
  });
}

/**
 * Reads an asset's bytes for streaming. Separate from {@link getOwnedAsset} so
 * the caller cannot accidentally stream a file it never authorised.
 */
export async function readOwnedAssetBytes(
  userId: string,
  assetPublicId: string
): Promise<{ fileName: string; contentType: string; body: Buffer } | null> {
  const asset = await getOwnedAsset(userId, assetPublicId);
  if (!asset) return null;

  return {
    fileName: asset.fileName,
    contentType: asset.contentType,
    body: Buffer.from(asset.content),
  };
}

/**
 * Hard-deletes one file. The bytes live on the row, so the single scoped delete
 * is the whole operation — there is no second store to clean up and therefore
 * no way for the two to disagree.
 *
 * A brief can be deleted whenever the caller owns it, and
 * so can its files.
 */
export async function deleteAsset(
  userId: string,
  assetPublicId: string
): Promise<{ success: true } | { notFound: true }> {
  // Ownership is proved by the same scoped delete that removes the row, so this
  // needs no separate read. Two consequences worth stating:
  //   - the file body is never selected, so deleting a 20MB document does not
  //     pull 20MB through the process;
  //   - a row whose bytes are missing (legacy row predating the `content`
  //     column) can still be deleted. Such a row is not servable, but that
  //     must not make it undeletable, or it becomes permanent litter.
  await withBriefScope(userId, async (tx) => {
    const result = await tx.briefAsset.deleteMany({
      where: { publicId: assetPublicId, userId },
    });
    if (result.count === 0) {
      throw new AssetNotFoundError();
    }
  });

  return { success: true };
}
