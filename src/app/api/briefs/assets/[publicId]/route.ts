import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { deleteAsset, readOwnedAssetBytes, AssetNotFoundError } from "@/lib/briefs/assets";

/**
 * GET /api/briefs/assets/[publicId]  (download)
 *
 * Owner-scoped download. Authorisation is decided by the scoped database lookup
 * below, never by the object key — a caller who guesses another user's
 * `publicId` gets 404, because that row is not in their scope.
 *
 * The bytes are held in Postgres and streamed back through this route. There is
 * no presigned-URL shortcut and no second store: authorisation is this single
 * scoped lookup, so a caller who guesses another user's `publicId` gets 404 and
 * no URL is ever minted that outlives the session that issued it.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> }
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { publicId } = await params;

  try {
    // One scoped lookup does both jobs: the bytes and the authorisation come
    // from the same row, so this cannot read a file it did not just prove it
    // owns. Null covers "does not exist", "belongs to someone else" and "has no
    // bytes", all of which are answered identically on purpose.
    const file = await readOwnedAssetBytes(user.id, publicId);
    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(file.body), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.body.byteLength),
        // `inline` so a PDF or image renders in the browser instead of forcing
        // a download dialog. The filename is quoted and stripped of quotes so
        // a hostile name cannot inject a header parameter.
        "Content-Disposition":
          `inline; filename="${file.fileName.replace(/["\\\r\n]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Failed to download brief asset:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/briefs/assets/[publicId]
 *
 * Hard-deletes one file. The bytes are a column on the row, so this is a single
 * scoped delete. Permitted regardless of the parent brief's processing status,
 * matching the brief deletion rules.
 *
 * Returns 404 for both an unknown id and another user's id, so this cannot be
 * used to probe which file ids exist.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> }
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { publicId } = await params;

  try {
    const result = await deleteAsset(user.id, publicId);
    if ("notFound" in result) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    if (error instanceof AssetNotFoundError) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    console.error("Failed to delete brief asset:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
