import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { updateBriefSchema } from "@/lib/validation/brief";
import { deleteBrief, getBrief, updateBrief } from "@/lib/briefs/service";

/**
 * Every handler here follows the same two rules:
 *
 *  1. Authenticate first, before touching the database. A request with no valid
 *     session is rejected with 401 and never reaches a query.
 *  2. Answer 404 — never 403 — when a brief exists but belongs to somebody
 *     else. A 403 would confirm the id is real, letting an attacker enumerate
 *     the table; 404 for "not yours" and 404 for "does not exist" make the two
 *     indistinguishable. These responses behave identically regardless of the
 *     brief's documents.
 */

export interface BriefRouteProps {
  params: Promise<{ publicId: string }>;
}

/** GET /api/briefs/[publicId] — single brief, scoped to its owner. */
export async function GET(_request: NextRequest, props: BriefRouteProps) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { publicId } = await props.params;
  if (!publicId) {
    return NextResponse.json({ error: "Brief not found" }, { status: 404 });
  }

  try {
    const brief = await getBrief(user.id, publicId);
    if (!brief) {
      return NextResponse.json({ error: "Brief not found" }, { status: 404 });
    }

    return NextResponse.json({ brief }, { status: 200 });
  } catch (error) {
    console.error("Failed to get brief:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/briefs/[publicId] — partial edit.
 *
 * Ownership is not editable through this endpoint, and the title is the only
 * field that can change.
 */
export async function PATCH(request: NextRequest, props: BriefRouteProps) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { publicId } = await props.params;
  if (!publicId) {
    return NextResponse.json({ error: "Brief not found" }, { status: 404 });
  }

  try {
    const json = await request.json();
    const parsed = updateBriefSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const result = await updateBrief(user.id, publicId, parsed.data);
    if ("notFound" in result) {
      return NextResponse.json({ error: "Brief not found" }, { status: 404 });
    }

    return NextResponse.json({ brief: result.brief }, { status: 200 });
  } catch (error) {
    console.error("Failed to update brief:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/briefs/[publicId] — hard delete; the documents go with it.
 *
 * A brief that was never processed can be deleted without ever being sent to
 * the AI provider.
 */
export async function DELETE(_request: NextRequest, props: BriefRouteProps) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { publicId } = await props.params;
  if (!publicId) {
    return NextResponse.json({ error: "Brief not found" }, { status: 404 });
  }

  try {
    const result = await deleteBrief(user.id, publicId);
    if ("notFound" in result) {
      return NextResponse.json({ error: "Brief not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("Failed to delete brief:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
