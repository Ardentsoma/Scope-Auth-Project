import "server-only";

import { cookies } from "next/headers";
import { ensureAppDatabaseRole, prisma } from "@/lib/prisma";
import type { User } from "@prisma/client";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  getAuthSecret,
  signSessionCookie,
  verifySessionCookie,
} from "./session-cookie";

export const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;

/**
 * Creates a server-side session row and returns the signed cookie value that
 * references it. The browser cookie only points at a random DB session id, so
 * sessions can be revoked/expired centrally.
 */
export async function createSignedSession(userId: string): Promise<{
  cookieValue: string;
  expiresAt: Date;
}> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await prisma.session.create({ data: { userId, expiresAt } });
  const cookieValue = await signSessionCookie(
    session.id,
    expiresAt.getTime(),
    getAuthSecret()
  );
  return { cookieValue, expiresAt };
}

/** Reads the current signed-in user from the session cookie + DB (or null). */
export async function getSessionUser(): Promise<User | null> {
  // Every protected request authenticates before it does anything else, so this
  // is where the database role check runs. A privileged connection throws here
  // and the request fails, rather than serving another user's data.
  await ensureAppDatabaseRole();

  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (!value) return null;

  const verified = await verifySessionCookie(value, getAuthSecret());
  if (!verified) return null;

  const session = await prisma.session.findUnique({
    where: { id: verified.sessionId },
    include: { user: true },
  });

  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return session.user;
}

/** Deletes a session row by id (used on sign-out). */
export async function destroySessionById(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}