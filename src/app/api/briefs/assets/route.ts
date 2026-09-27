import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import {
  assertRequestWithinSizeLimit,
  BRIEF_TITLE_FIELD,
  readUploads,
  UploadTooLargeError,
} from "@/lib/briefs/upload";
import { createBriefSchema } from "@/lib/validation/brief";
import {
  AssetStorageError,
  createAssetsForBrief,
  listAllAssets,
  listAssetsForBrief,
} from "@/lib/briefs/assets";
import { createBrief, deleteBrief, type BriefDto } from "@/lib/briefs/service";
import {
  UploadValidationError,
} from "@/lib/validation/asset";
import { checkEndpointRateLimit, clientIp } from "@/lib/rate-limit";

/**
 * GET /api/briefs/assets?briefId=<briefId>
 *
 * Lists the caller's files, either for one brief or across all of them when
 * `briefId` is omitted. Returns 401 before any database access when there is no
 * valid session. Scoped to the session user, so another user's files are simply
 * never in the response.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const briefId = request.nextUrl.searchParams.get("briefId");

  try {
    const assets = briefId
      ? await listAssetsForBrief(user.id, briefId)
      : await listAllAssets(user.id);
    return NextResponse.json({ assets }, { status: 200 });
  } catch (error) {
    console.error("Failed to list brief assets:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/briefs/assets  (multipart/form-data)
 *
 * Attaches files to a brief. This is a plain insert: no AI provider is called,
 * so uploading is fast and cannot fail because of a third-party outage.
 * Processing remains a separate action.
 *
 * `userId` comes from the session and is never read from the body.
 *
 * `briefId` is OPTIONAL, and omitting it is the normal first-run path: someone
 * landing on the dashboard with nothing set up yet writes their brief and picks
 * files in one go, and the server creates the brief to own them. Files are
 * always parented by a brief (the column is NOT NULL, ON DELETE CASCADE), so
 * "just upload a file" is expressed as "create a brief from these files" rather
 * than by making the parent nullable and leaving files to be orphans needing
 * their own management surface.
 *
 * `briefTitle` is the user-facing label for the new brief, and is only used
 * when `briefId` is absent. There is no brief *text* field: a brief is a title
 * plus its documents, so nothing is stored that only an AI step would read.
 *
 * When `briefId` IS supplied it must exist and be owned by the caller; the
 * service resolves it with a scoped query, so an unknown or foreign id is 404.
 * Any `briefTitle` alongside a `briefId` is ignored, so attaching files to a
 * brief can never overwrite it.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = checkEndpointRateLimit(request, "upload", user.email);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many uploads. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  try {
    // Reject an oversized body before formData() buffers it into memory.
    assertRequestWithinSizeLimit(request);

    const formData = await request.formData();
    const uploads = await readUploads(formData);

    const requested = formData.get("briefId");
    const requestedBriefId =
      typeof requested === "string" && requested.trim() !== ""
        ? requested.trim()
        : null;

    // The title rides along in the same request when the caller is creating the
    // brief and its files together. Optional, and validated with the same rules
    // as the JSON endpoint so bad input is a clean 400 rather than a 500 from
    // deep inside the insert.
    const rawTitle = formData.get(BRIEF_TITLE_FIELD);
    let requestedTitle: string | undefined;
    if (typeof rawTitle === "string" && rawTitle.trim() !== "") {
      const parsed = createBriefSchema.safeParse({ title: rawTitle });
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }
      requestedTitle = parsed.data.title;
    }

    // No brief chosen: create one to hold these files.
    let createdBrief: BriefDto | null = null;
    let targetBriefId = requestedBriefId;

    if (targetBriefId === null) {
      createdBrief = await createBrief(user.id, { title: requestedTitle });
      targetBriefId = createdBrief.publicId;
    }
    // When `briefId` WAS supplied the brief already exists, so any title in the
    // body is deliberately ignored: attaching files must never silently
    // rewrite an existing brief.

    try {
      const assets = await createAssetsForBrief(
        user.id,
        targetBriefId,
        uploads
      );

      console.log(
        `[uploads] user=${user.id} ip=${clientIp(request)} brief=${targetBriefId} files=${assets.length}`
      );
      return NextResponse.json({ assets, brief: createdBrief }, { status: 201 });
    } catch (error) {
      // This brief existed only to hold the files. If attaching them failed,
      // leaving behind a brief the caller never asked for is worse than
      // unwinding it. Best-effort: if the cleanup also fails, the original error
      // is still what gets reported.
      if (createdBrief) {
        await deleteBrief(user.id, createdBrief.publicId).catch(
          (cleanupError) =>
            console.error(
              `[uploads] failed to unwind brief ${createdBrief?.publicId}:`,
              cleanupError
            )
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof UploadValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof AssetStorageError) {
      // "Brief not found" is also the answer for a brief owned by someone else:
      // 404 without revealing which it was.
      return NextResponse.json({ error: "Brief not found" }, { status: 404 });
    }
    console.error("Failed to attach brief assets:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

