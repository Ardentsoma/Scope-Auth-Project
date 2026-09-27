/**
 * Startup safety check: refuse to run unless the application is connected as
 * the non-owner database role.
 *
 * The whole access-control story rests on the application connecting as
 * `scope_app`, a role that owns nothing and has neither SUPERUSER nor
 * BYPASSRLS. Postgres exempts a table's **owner** from its own RLS policies, so
 * an application connected as the owner (`scope`) is not protected by the
 * policies at all — even though they look correct in `pg_policies`. That
 * failure is silent: every query succeeds, the app works, and it simply returns
 * other users' rows.
 *
 * A misconfigured connection string is therefore the one mistake that disables
 * security without producing an error. This check turns that silent failure
 * into a loud one, before any request is served.
 *
 * This module deliberately has **no imports** — not even `server-only` or a path
 * alias — so `scripts/test-db-role.mjs` can exercise the same logic the
 * application runs, rather than a reimplementation of it.
 */

/** Environment variable naming the role the application is allowed to use. */
export const APP_ROLE_ENV_VAR = "DATABASE_APP_ROLE";

/** The role the application must connect as, unless overridden in the env. */
export const DEFAULT_APP_ROLE = "scope_app";

/** The table whose ownership would silently disable RLS. */
const GUARDED_TABLE = "briefs";

/**
 * One round trip returns the connected role and everything that would make it
 * exempt from RLS. `current_user` is the role permissions are evaluated as,
 * which is the one that matters; `session_user` is the login role, included so a
 * `SET ROLE` cannot disguise what is really connected.
 */
export const ROLE_PROBE_SQL = `
  SELECT
    current_user::text                       AS "currentUser",
    session_user::text                       AS "sessionUser",
    r.rolsuper                               AS "isSuperuser",
    r.rolbypassrls                           AS "canBypassRls",
    EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_roles o ON o.rolname = c.relowner::regrole::text
      WHERE c.relname = '${GUARDED_TABLE}'
        AND o.rolname = current_user::text
    )                                       AS "ownsGuardedTable"
  FROM pg_roles r
  WHERE r.rolname = current_user::text
`;

/** The shape {@link ROLE_PROBE_SQL} returns. */
export type RoleProbe = {
  currentUser: string | null;
  sessionUser: string | null;
  isSuperuser: boolean;
  canBypassRls: boolean;
  ownsGuardedTable: boolean;
};

/**
 * The role name the application expects, read from the environment so a
 * deployment can rename the role without a code change. Defaults to
 * `scope_app`; an empty or whitespace-only value falls back to the default
 * rather than disabling the check.
 */
export function expectedAppRole(
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env[APP_ROLE_ENV_VAR]?.trim();
  return configured ? configured : DEFAULT_APP_ROLE;
}

export class DatabaseRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRoleError";
  }
}

/**
 * The check itself: pure, synchronous, and total. Returns the confirmed role
 * name, or throws {@link DatabaseRoleError} explaining precisely what is wrong.
 *
 * The name comparison alone would pass for a role that has since been granted
 * ownership or BYPASSRLS, so the privilege flags are checked as well. Those are
 * the conditions that actually determine whether RLS applies, and a role
 * mismatch caused by a renamed or swapped connection string is the situation
 * this exists to catch.
 */
export function assertAppDatabaseRole(
  probe: RoleProbe,
  expected: string = DEFAULT_APP_ROLE
): string {
  const actual = probe.currentUser ?? null;

  if (!actual) {
    throw new DatabaseRoleError(
      "Database role check failed: the probe returned no role. " +
        "The connection may not be authenticated. Refusing to serve requests."
    );
  }

  if (actual !== expected) {
    throw new DatabaseRoleError(
      `Database role check failed: connected as "${actual}", expected "${expected}".\n` +
        "The application must not use the table owner role, because an owner is " +
        "exempt from its own RLS policies and would read every user's data.\n" +
        "  - Point DATABASE_URL at the non-owner role.\n" +
        `  - Set ${APP_ROLE_ENV_VAR} to the correct role name if it was renamed.\n` +
        "  - Prisma Studio and migrations should use ADMIN_DATABASE_URL instead."
    );
  }

  const problems: string[] = [];
  if (probe.isSuperuser) {
    problems.push("it is SUPERUSER");
  }
  if (probe.canBypassRls) {
    problems.push("it has BYPASSRLS");
  }
  if (probe.ownsGuardedTable) {
    problems.push(`it owns the "${GUARDED_TABLE}" table`);
  }
  if (probe.sessionUser && probe.sessionUser !== actual) {
    problems.push(
      `it logged in as "${probe.sessionUser}" and switched role to "${actual}"`
    );
  }

  if (problems.length > 0) {
    throw new DatabaseRoleError(
      `Database role check failed: "${actual}" has the expected name but is ` +
        `exempt from row-level security, because ${problems.join(", ")}.\n` +
        "A role with any of these attributes is not contained by the RLS policy, " +
        "so the application would read every user's data. Refusing to serve " +
        "requests."
    );
  }

  return actual;
}

/** The minimal query surface {@link verifyAppDatabaseRole} needs. */
export type RoleQueryable = {
  $queryRawUnsafe<T = unknown>(sql: string): Promise<T>;
};

/**
 * Probe the connected role and assert it is safe, throwing
 * {@link DatabaseRoleError} if not. This runs before any application query, so
 * a misconfigured connection fails the first request rather than silently
 * serving another user's rows.
 */
export async function verifyAppDatabaseRole(
  db: RoleQueryable,
  expected: string = expectedAppRole()
): Promise<string> {
  const rows = await db.$queryRawUnsafe<RoleProbe[]>(ROLE_PROBE_SQL);
  const probe = rows[0];
  if (!probe) {
    throw new DatabaseRoleError(
      "Database role check failed: the probe query returned no rows. " +
        "Refusing to serve requests."
    );
  }
  return assertAppDatabaseRole(probe, expected);
}
