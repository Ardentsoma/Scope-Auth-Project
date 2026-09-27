import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSignedSession } from "@/lib/auth/session";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie";
import { hashToken, safeEqualHex } from "@/lib/auth/tokens";
import { checkEndpointRateLimit } from "@/lib/rate-limit";
import { fieldErrors, verifyEmailSchema } from "@/lib/validation/auth";
import { isAuthConfigured } from "@/lib/auth/config";

export async function POST(request: NextRequest) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      { error: "Authentication is not configured." },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = verifyEmailSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errors: fieldErrors(parsed.error) }, { status: 400 });
  }

  const { email, code } = parsed.data;

  const limit = checkEndpointRateLimit(request, "verify", email);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many verification attempts. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json(
      { error: "No account found for that email." },
      { status: 401 }
    );
  }

  // Never mint a session for an already-verified account. Minting one without
  // proof of a valid code would let anyone with a known email take over the
  // account (the submitted code was intentionally NOT verified on this path).
  // The client routes these users to /signin where they authenticate normally.
  if (user.emailVerifiedAt) {
    return NextResponse.json({ alreadyVerified: true }, { status: 200 });
  }

  const token = await prisma.emailVerificationToken.findFirst({
    where: { userId: user.id, usedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!token) {
    return NextResponse.json(
      { error: "No active verification code. Request a new one." },
      { status: 400 }
    );
  }

  // Expiry is enforced here, server-side — client countdowns are cosmetic.
  if (token.expiresAt.getTime() < Date.now()) {
    return NextResponse.json(
      { error: "That code has expired. Request a new one." },
      { status: 400 }
    );
  }

  if (!safeEqualHex(hashToken(code), token.codeHash)) {
    return NextResponse.json(
      { error: "That code is incorrect." },
      { status: 400 }
    );
  }

  // Mark the code used and the user verified in one transaction.
  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    }),
  ]);

  const { cookieValue } = await createSignedSession(user.id);
  const response = NextResponse.json(
    { verified: true, user: { fullName: user.fullName, email: user.email } },
    { status: 200 }
  );
  response.cookies.set(SESSION_COOKIE, cookieValue, sessionCookieOptions());
  return response;
}