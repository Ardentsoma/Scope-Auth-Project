import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  verifySessionCookie,
} from "@/lib/auth/session-cookie";

export async function proxy(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const response = NextResponse.next({ request });

  // Auth not configured yet (missing AUTH_SECRET): let pages load so the sign
  // in/create screens stay reachable instead of breaking on a missing secret.
  if (!secret) {
    return response;
  }

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const session = cookie ? await verifySessionCookie(cookie, secret) : null;
  const loggedIn = Boolean(session);
  const { pathname } = request.nextUrl;

  if (!loggedIn && pathname.startsWith("/dashboard")) {
    const url = request.nextUrl.clone();
    url.pathname = "/signin";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};