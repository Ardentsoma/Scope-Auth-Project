import { PrismaClient } from "@prisma/client";
import { expectedAppRole, verifyAppDatabaseRole } from "@/lib/db-role";

// Reuse a single PrismaClient across hot reloads in dev to avoid exhausting
// DB connections. In production a fresh client is created per process.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Query logging is opt-in via DEBUG_PRISMA=1. Off by default: it writes every
// statement to stdout, which buries the actual request logs (including the
// HTTP method/path/timing lines) and leaks parameter values into the terminal.
const prismaLog =
  process.env.DEBUG_PRISMA === "1"
    ? (["query", "warn", "error"] as const)
    : (["warn", "error"] as const);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [...prismaLog],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Memoised result of the role check, so the probe costs exactly one query per
 * process however many requests are served.
 *
 * The check is deliberately lazy rather than top-level. A module-scope query
 * would run during `next build`, which would make every build require a live
 * database and a correctly configured role. Instead it fires on the first
 * database access, before that access is allowed to happen — see
 * `ensureAppDatabaseRole` below, which is called from the two entry points
 * through which all application data access flows.
 */
let roleCheck: Promise<string> | null = null;

/**
 * Confirm the application is connected as the non-owner role, once per process.
 *
 * Throws {@link DatabaseRoleError} if the connection is privileged, and the
 * rejection propagates to the caller, so the request fails instead of quietly
 * reading another user's rows. See src/lib/db-role.ts for why this matters.
 */
export function ensureAppDatabaseRole(): Promise<string> {
  roleCheck ??= verifyAppDatabaseRole(prisma, expectedAppRole()).catch(
    (error: unknown) => {
      // Do not memoise a failure: a transient database error at boot must not
      // permanently poison the process, and a corrected connection string
      // should recover without a restart.
      roleCheck = null;
      throw error;
    }
  );
  return roleCheck;
}

/** Test seam: forget the memoised result so the next call re-probes. */
export function resetAppDatabaseRoleCheckForTests(): void {
  roleCheck = null;
}