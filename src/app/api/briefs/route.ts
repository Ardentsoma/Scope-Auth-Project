import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { createBriefSchema } from "@/lib/validation/brief";
import { createBrief, listBriefs } from "@/lib/briefs/service";

/**
 * GET /api/briefs
 * Lists the authenticated user's briefs, newest first.
 * Returns 401 before any database access if there is no valid session.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const briefs = await listBriefs(user.id);
    return NextResponse.json({ briefs }, { status: 200 });
  } catch (error) {
    console.error("Failed to list briefs:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/briefs  (upload)
 *
 * Creates a brief. This is a plain insert of the title, with nothing derived
 * from it and no provider contacted, so it is fast and cannot fail because of a
 * third-party outage. Documents are attached separately through
 * POST /api/briefs/assets.
 *
 * `userId` is taken from the session, never from the body.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const json = await request.json();
    const parsed = createBriefSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const brief = await createBrief(user.id, parsed.data);
    return NextResponse.json({ brief }, { status: 201 });
  } catch (error) {
    console.error("Failed to create brief:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
