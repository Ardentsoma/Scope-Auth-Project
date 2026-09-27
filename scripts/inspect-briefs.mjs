/**
 * Read-only inspector for the brief tables.
 *
 * A brief is only ever shown to the person who owns it, and the database
 * enforces that on its own. So anything that connects without saying who is
 * asking — which is what this script does for the demonstration line below —
 * sees zero briefs. That's on purpose: if the app ever forgot to say who the
 * user is, the safe answer is "show nothing", not "show everything".
 *
 * Prisma Studio is not affected by this. It signs in as the database owner,
 * which is allowed to see past the rule, so a brief you just created will
 * still be there.
 *
 * This script reads the same way the application does: it opens a transaction,
 * sets the scope to one user, and reads inside it. It therefore shows exactly
 * what that user can see, and can never reveal another user's rows.
 *
 * It is strictly read-only. There is no write path in this file.
 *
 *   npm run inspect                 # every user
 *   npm run inspect -- --email a@b.c  # just one
 *   npm run inspect -- --full       // include internal ids
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RLS_USER_SETTING = "app.current_user_id";

const args = process.argv.slice(2);
const emailArgIndex = args.indexOf("--email");
const onlyEmail =
  emailArgIndex >= 0 ? args[emailArgIndex + 1]?.toLowerCase() : undefined;
const showIds = args.includes("--full");

/**
 * Runs `fn` with the RLS scope set to `userId`, the same way
 * src/lib/briefs/scope.ts does for real requests.
 *
 * `set_config(..., true)` scopes the setting to this transaction, so it cannot
 * leak onto a pooled connection after the transaction ends.
 */
async function asUser(userId, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${RLS_USER_SETTING}, ${userId}, true)`;
    return fn(tx);
  });
}

const pad = (value, width) => String(value ?? "").padEnd(width);

function bytes(n) {
  if (n === null || n === undefined) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function main() {
  console.log("Brief inspector (read-only)\n");

  // Show the rule working rather than just claiming it does: count with nobody
  // set, so the number below is zero, then show the same brief again with a
  // user set, where it comes back.
  const unscoped = await prisma.brief.count();
  console.log(`  briefs visible with NO scope set:  ${unscoped}`);
  console.log(
    "  (always 0 — a connection that hasn't said who is asking is shown\n" +
      "   nothing at all, rather than everything.)\n"
  );

  // `User` has no RLS, so accounts can be listed directly.
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, fullName: true },
  });

  if (users.length === 0) {
    console.log("  No users exist yet.");
    return;
  }

  const targets = onlyEmail
    ? users.filter((u) => u.email.toLowerCase() === onlyEmail)
    : users;

  if (onlyEmail && targets.length === 0) {
    console.log(`  No user with email ${onlyEmail}.`);
    console.log(
      `  Known: ${users.map((u) => u.email).join(", ")}`
    );
    return;
  }

  let totalBriefs = 0;
  let totalDocs = 0;

  for (const user of targets) {
    const result = await asUser(user.id, async (tx) => {
      // octet_length is computed in the database so the file bodies are never
      // loaded into this process just to measure them.
      const rows = await tx.$queryRaw`
        SELECT
          b.id,
          b."publicId",
          b.title,
          b."createdAt"::text AS "createdAt",
          a."publicId"   AS "assetPublicId",
          a."fileName"   AS "fileName",
          a."fileSizeBytes" AS "fileSizeBytes",
          octet_length(a.content) AS "storedBytes"
        FROM briefs b
        LEFT JOIN brief_assets a ON a."briefId" = b.id
        WHERE b."userId" = ${user.id}
        ORDER BY b."createdAt" DESC, a."createdAt" ASC
      `;
      return rows;
    });

    const briefIds = new Set(result.map((r) => r.publicId));
    totalBriefs += briefIds.size;

    console.log(
      `${user.email}${onlyEmail ? "" : `  (${user.id})`}  —  ` +
        `${briefIds.size} brief${briefIds.size === 1 ? "" : "s"}`
    );

    if (result.length === 0) {
      console.log("  (no briefs)\n");
      continue;
    }

    let current = null;
    for (const row of result) {
      if (row.publicId !== current) {
        current = row.publicId;
        console.log(
          `\n  ${pad(row.title || "(untitled)", 40)} ` +
            `${row.createdAt.slice(0, 19).replace("T", " ")}`
        );
        console.log(`    public id ${row.publicId}`);
        if (showIds) {
          console.log(`    internal id ${row.id}`);
        }
      }
      if (row.assetPublicId) {
        totalDocs += 1;
        console.log(
          `    doc  ${pad(row.fileName, 32)} ${pad(bytes(row.fileSizeBytes), 10)}` +
            ` in-db ${bytes(row.storedBytes)}`
        );
        console.log(`         public id ${row.assetPublicId}`);
      } else {
        console.log("    doc  (none)");
      }
    }
    console.log("");
  }

  console.log("-".repeat(60));
  console.log(
    `  ${totalBriefs} brief${totalBriefs === 1 ? "" : "s"}, ` +
      `${totalDocs} document${totalDocs === 1 ? "" : "s"} across ` +
      `${targets.length} user${targets.length === 1 ? "" : "s"}`
  );
}

main()
  .catch((error) => {
    console.error("\nInspector failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
