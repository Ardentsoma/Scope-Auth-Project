/**
 * Tests for the startup database-role safety check.
 *
 * The check exists because the failure it guards against is silent: an
 * application connected as the table owner is exempt from its own RLS
 * policies, so every query succeeds and the app simply returns other users'
 * rows. These tests assert both directions against the real database — that the
 * app's own connection passes, and that a privileged one is rejected.
 *
 * This imports the same module the application runs
 * (src/lib/db-role.ts) rather than reimplementing the comparison, so a change
 * to the check is covered by these tests.
 *
 *   node --env-file=.env scripts/test-db-role.mjs
 */
import { PrismaClient } from "@prisma/client";
import {
  APP_ROLE_ENV_VAR,
  DatabaseRoleError,
  DEFAULT_APP_ROLE,
  assertAppDatabaseRole,
  expectedAppRole,
  verifyAppDatabaseRole,
} from "../src/lib/db-role.ts";

const BASE_URL = process.env.BRIEFS_BASE_URL || "http://localhost:3005";

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function throwsDatabaseRoleError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof DatabaseRoleError ? error : new Error(`wrong error type: ${error}`);
  }
}

async function main() {
  console.log("SCOPE database role check");
  console.log(`Target: ${BASE_URL}\n`);

  const appDb = new PrismaClient();
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error("ADMIN_DATABASE_URL is required to prove the check rejects a privileged role.");
    process.exit(1);
  }
  // Deliberately the owner role: this is the connection the check must refuse.
  const ownerDb = new PrismaClient({ datasources: { db: { url: adminUrl } } });

  // ── 1. The pure comparison ────────────────────────────────────────────
  section("1. assertAppDatabaseRole rejects anything that is not the app role");

  const safe = {
    currentUser: "scope_app",
    sessionUser: "scope_app",
    isSuperuser: false,
    canBypassRls: false,
    ownsGuardedTable: false,
  };
  check("the expected non-owner role passes", assertAppDatabaseRole(safe, "scope_app") === "scope_app");

  const wrongName = throwsDatabaseRoleError(() =>
    assertAppDatabaseRole({ ...safe, currentUser: "scope" }, "scope_app")
  );
  check("a different role name is rejected", wrongName !== null);
  check("  ...and the message names both roles",
    wrongName?.message.includes('"scope"') && wrongName.message.includes('"scope_app"'),
    wrongName?.message);
  check("  ...and explains that an owner bypasses RLS",
    /owner is\s+exempt from its own RLS/i.test(wrongName?.message ?? ""),
    wrongName?.message);

  const superuser = throwsDatabaseRoleError(() =>
    assertAppDatabaseRole({ ...safe, isSuperuser: true }, "scope_app")
  );
  check("a SUPERUSER with the right name is rejected", superuser !== null);
  check("  ...and the message says why",
    /SUPERUSER/.test(superuser?.message ?? ""), superuser?.message);

  const bypass = throwsDatabaseRoleError(() =>
    assertAppDatabaseRole({ ...safe, canBypassRls: true }, "scope_app")
  );
  check("a role with BYPASSRLS is rejected", bypass !== null);

  const owner = throwsDatabaseRoleError(() =>
    assertAppDatabaseRole({ ...safe, ownsGuardedTable: true }, "scope_app")
  );
  check("a role that owns `briefs` is rejected even with the right name", owner !== null);

  const switched = throwsDatabaseRoleError(() =>
    assertAppDatabaseRole({ ...safe, sessionUser: "scope" }, "scope_app")
  );
  check("a role switch (session_user differs) is rejected", switched !== null);

  const noRole = throwsDatabaseRoleError(() =>
    assertAppDatabaseRole({ ...safe, currentUser: null }, "scope_app")
  );
  check("a null role is rejected rather than defaulting to allow", noRole !== null);

  // ── 2. The expected role is configurable ──────────────────────────────
  section("2. The expected role comes from the environment");

  check("it defaults to scope_app", expectedAppRole({}) === DEFAULT_APP_ROLE);
  check(`it reads ${APP_ROLE_ENV_VAR}`, expectedAppRole({ [APP_ROLE_ENV_VAR]: "app_rw" }) === "app_rw");
  check("a blank override falls back to the default rather than disabling the check",
    expectedAppRole({ [APP_ROLE_ENV_VAR]: "   " }) === DEFAULT_APP_ROLE);

  // ── 3. Against the real database ──────────────────────────────────────
  section("3. Against the live database");

  const appRole = await verifyAppDatabaseRole(appDb, expectedAppRole());
  check(`the app connection (${appRole}) passes the check`, appRole === DEFAULT_APP_ROLE);

  const ownerRole = await verifyAppDatabaseRole(ownerDb, expectedAppRole()).then(
    () => null,
    (error) => error
  );
  check("the owner connection is REFUSED", ownerRole instanceof DatabaseRoleError,
    ownerRole ? "it was accepted" : "");
  // The name check fires first, which is the primary signal; the ownership
  // branch is covered by the simulated cases in section 1.
  check("  ...identified by the real probe as the wrong role",
    /connected as "scope"/.test(ownerRole?.message ?? ""), ownerRole?.message);

  // ── 4. The running app refuses to serve under a wrong role ────────────
  section("4. The running server refuses to serve when the role is wrong");

  // Start a second server on another port pointed at the owner role. Every
  // request that touches the database must fail rather than return data.
  const { spawn } = await import("node:child_process");
  const port = 3011;
  const child = spawn("./node_modules/.bin/next", ["start", "-p", String(port)], {
    env: { ...process.env, DATABASE_URL: adminUrl, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d.toString(); });
  child.stderr.on("data", (d) => { output += d.toString(); });

  // Wait for it to come up (or give up after 20s).
  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE_URL.replace(":3005", `:${port}`)}/signin`, {
        signal: AbortSignal.timeout(2000),
      });
      up = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  check("the misconfigured server started", up, "it never became reachable");

  if (up) {
    // A protected route: it must resolve a session, which is where the check runs.
    const res = await fetch(`http://localhost:${port}/api/briefs`, {
      signal: AbortSignal.timeout(10000),
    }).catch((e) => ({ status: 0, err: e }));
    const body = await res.text?.().catch(() => "");
    check("a request under the owner role does NOT succeed", res.status !== 200,
      `got ${res.status}`);
    check("  ...and the failure names the role check",
      /role check failed/i.test(body) || /role check failed/i.test(output),
      `body=${String(body).slice(0, 200)}`);
  }
  child.kill("SIGKILL");

  await appDb.$disconnect();
  await ownerDb.$disconnect();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PASS: ${passed}   FAIL: ${failures.length}`);
  if (failures.length > 0) {
    console.log("\nFailed assertions:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log("=".repeat(60));
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
