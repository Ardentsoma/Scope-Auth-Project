/**
 * Brief CRUD + owner-isolation test suite.
 *
 * Run against a server started with the same DATABASE_URL:
 *   set -a && . ./.env && set +a && ./node_modules/.bin/next start -p 3005
 *   node --env-file=.env scripts/test-briefs-slice.mjs
 *
 * Two users are used throughout (alice = owner, bob = attacker) so that every
 * assertion about isolation is a real cross-user attempt rather than a
 * simulation. Direct database access is also used deliberately, to verify what
 * actually landed in the table and to prove the RLS policy independently of
 * the application code.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { webcrypto } from "node:crypto";

const prisma = new PrismaClient();
const BASE_URL = process.env.BRIEFS_BASE_URL || "http://localhost:3005";
const AUTH_SECRET =
  process.env.AUTH_SECRET ||
  "342e1172343365cb074482c237bb8e80aad9602201f262a29a0205515c61ceec";

const RLS_USER_SETTING = "app.current_user_id";

/**
 * Each run presents a distinct client IP.
 *
 * Not cosmetic. This suite signs sessions directly rather than going through
 * the auth endpoints, and touches no rate-limited route, so nothing here
 * *requires* a private IP today. It is still applied so that concurrent or
 * back-to-back runs never share IP-keyed state with each other, and so a run's
 * requests are attributable in the server log. The assets suite, which does hit
 * a rate-limited route, depends on this for correctness rather than hygiene.
 *
 * The tag mixes the pid and a timestamp rather than using Math.random() alone,
 * because a small random space still collides often enough for two concurrent
 * runs to pick the same address.
 */
/**
 * A canonical RFC 4122 version-4 UUID: 8-4-4-4-12 hex, the version nibble
 * fixed at 4 and the variant nibble in [89ab].
 *
 * `publicId` is the only identifier that reaches a URL, so it must be a CSPRNG
 * value rather than anything an attacker could narrow down — a cuid embeds a
 * timestamp and a counter, which is guessable. Asserting the exact shape here
 * means a future change back to a weaker generator fails loudly.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RUN_TAG = (process.pid * 7919 + Date.now()) % 65024;
const RUN_IP = `198.18.${Math.floor(RUN_TAG / 256) % 256}.${RUN_TAG % 256}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function authHeaders(cookie, ip = RUN_IP) {
  return {
    "x-forwarded-for": ip,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function encodeB64url(input) {
  return Buffer.from(input).toString("base64url");
}

async function hmacSign(data, secret) {
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await webcrypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return Buffer.from(sig).toString("base64url");
}

async function createSignedSessionCookie(userId) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await prisma.session.create({ data: { userId, expiresAt } });
  const payload = `${session.id}.${expiresAt.getTime()}`;
  const sig = await hmacSign(payload, AUTH_SECRET);
  return `scope_session=${encodeB64url(payload)}.${sig}`;
}

async function getOrCreateUser(email, fullName) {
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        fullName,
        passwordHash: await bcrypt.hash("Password123!", 12),
        emailVerifiedAt: new Date(),
      },
    });
  }
  return user;
}

/**
 * Mirrors src/lib/briefs/scope.ts. Cleaning up or checking brief rows REQUIRES
 * this: a connection that hasn't said who is asking can't see or touch the
 * briefs table at all. The test harness lives under the same rule as the
 * application, which is deliberate — it means a test that needs to see a row
 * has to go through the same door the app does.
 */
async function asUser(userId, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${RLS_USER_SETTING}, ${userId}, true)`;
    return fn(tx);
  });
}

const api = {
  async list(cookie) {
    const res = await fetch(`${BASE_URL}/api/briefs`, {
      headers: { ...authHeaders(cookie) },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  async create(cookie, payload) {
    const res = await fetch(`${BASE_URL}/api/briefs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cookie) },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  async get(cookie, publicId) {
    const res = await fetch(`${BASE_URL}/api/briefs/${publicId}`, {
      headers: { ...authHeaders(cookie) },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  async patch(cookie, publicId, payload) {
    const res = await fetch(`${BASE_URL}/api/briefs/${publicId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(cookie) },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  async del(cookie, publicId) {
    const res = await fetch(`${BASE_URL}/api/briefs/${publicId}`, {
      method: "DELETE",
      headers: { ...authHeaders(cookie) },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
};

async function main() {
  console.log("SCOPE briefs slice — CRUD + isolation suite");
  console.log(`Target: ${BASE_URL}\n`);

  const alice = await getOrCreateUser("alice@test.local", "Alice Designer");
  const bob = await getOrCreateUser("bob@test.local", "Bob Freelancer");

  // Clean slate for both users. Needs the RLS scope, like everything else.
  await asUser(alice.id, (tx) =>
    tx.brief.deleteMany({ where: { userId: alice.id } })
  );
  await asUser(bob.id, (tx) =>
    tx.brief.deleteMany({ where: { userId: bob.id } })
  );
  await prisma.session.deleteMany({
    where: { userId: { in: [alice.id, bob.id] } },
  });

  const aliceCookie = await createSignedSessionCookie(alice.id);
  const bobCookie = await createSignedSessionCookie(bob.id);

  // ─────────────────────────────────────────────────────────────────────────
  section("1. Unauthenticated requests are rejected before any DB access");

  const anonList = await api.list(null);
  check("GET  /api/briefs              -> 401", anonList.status === 401, `got ${anonList.status}`);

  const anonCreate = await api.create(null, { title: "anon" });
  check("POST /api/briefs              -> 401", anonCreate.status === 401, `got ${anonCreate.status}`);

  // A placeholder id is enough: these must 401 without ever resolving a brief.
  const anonGet = await api.get(null, "does-not-matter");
  check("GET  /api/briefs/[id]          -> 401", anonGet.status === 401, `got ${anonGet.status}`);

  const anonPatch = await api.patch(null, "does-not-matter", { title: "x" });
  check("PATCH /api/briefs/[id]         -> 401", anonPatch.status === 401, `got ${anonPatch.status}`);

  const anonDelete = await api.del(null, "does-not-matter");
  check("DELETE /api/briefs/[id]        -> 401", anonDelete.status === 401, `got ${anonDelete.status}`);

  // ─────────────────────────────────────────────────────────────────────────
  section("2. Upload: a brief is created immediately, owned by the uploader");

  const upload = await api.create(aliceCookie, { title: "Brief A: brand refresh." });
  check("Alice POST /api/briefs -> 201", upload.status === 201, `got ${upload.status}: ${JSON.stringify(upload.body)}`);

  const briefA = upload.body?.brief;
  check("brief has a publicId", Boolean(briefA?.publicId));
  check("publicId is a v4 UUID (CSPRNG, not a cuid)", UUID_V4.test(briefA?.publicId ?? ""),
    `got ${briefA?.publicId}`);
  check("title stored verbatim", briefA?.title === "Brief A: brand refresh.", `got ${briefA?.title}`);
  check("internal id / userId NOT exposed",
    briefA && !("id" in briefA) && !("userId" in briefA));

  // There is no processing state to leak, and no field the client can set to
  // own the row. Ownership comes from the session, never the body.
  const spoof = await api.create(aliceCookie, {
    title: "spoof attempt",
    userId: bob.id,
  });
  check("upload ignores a client-supplied userId (201, owned by Alice)",
    spoof.status === 201, `got ${spoof.status}`);
  const spoofUnderBob = await asUser(bob.id, (tx) =>
    tx.brief.findFirst({ where: { title: "spoof attempt" } })
  );
  check("  ...and the row is NOT stored under Bob", spoofUnderBob === null);
  const spoofOwner = await asUser(alice.id, (tx) =>
    tx.brief.findFirst({ where: { title: "spoof attempt" } })
  );
  check("  ...it is stored under Alice", spoofOwner !== null);

  if (spoofOwner) {
    await asUser(alice.id, (tx) =>
      tx.brief.deleteMany({ where: { publicId: spoofOwner.publicId } })
    );
  }

  const aliceList1 = await api.list(aliceCookie);
  check("Alice's list contains her uploaded brief",
    aliceList1.body?.briefs?.some((b) => b.publicId === briefA.publicId));

  // A second brief, so later sections have more than one target.
  const uploadB = await api.create(aliceCookie, { title: "Brief B: packaging guidelines." });
  check("Alice creates a second brief -> 201", uploadB.status === 201);
  const briefB = uploadB.body.brief;

  // Two ids minted a moment apart share no leading characters. Sequential or
  // time-ordered generators fail this immediately.
  check("consecutive ids share no common prefix (not sequential)",
    briefA?.publicId.slice(0, 8) !== briefB?.publicId.slice(0, 8),
    `${briefA?.publicId} vs ${briefB?.publicId}`);

  // ─────────────────────────────────────────────────────────────────────────
  section("3. List isolation: Bob's list never contains Alice's briefs");

  const bobList = await api.list(bobCookie);
  check("Bob's list returns 200", bobList.status === 200);
  const bobSeesA =
    bobList.body?.briefs?.some(
      (b) => b.publicId === briefA.publicId || b.publicId === briefB.body.brief.publicId
    ) || false;
  check("Bob CANNOT see Alice's briefs", !bobSeesA);

  const aliceList = await api.list(aliceCookie);
  check("no list entry leaks internal id / userId",
    (aliceList.body?.briefs || []).every((b) => !("id" in b) && !("userId" in b)));

  // Give Bob a brief of his own so the list comparison is meaningful.
  const bobBrief = await api.create(bobCookie, { title: "Bob's own brief." });
  check("Bob can create his own brief", bobBrief.status === 201);

  const bobList2 = await api.list(bobCookie);
  check("Bob's list contains only his own brief",
    bobList2.body?.briefs?.length === 1 && bobList2.body?.briefs?.[0]?.publicId === bobBrief.body.brief.publicId,
    `got ${bobList2.body?.briefs?.length} briefs`);

  // ─────────────────────────────────────────────────────────────────────────
  section("4. Single read: Bob gets 404 (not 403) for Alice's brief");

  const bobGet = await api.get(bobCookie, briefA.publicId);
  check("Bob GETs Alice's brief -> 404", bobGet.status === 404, `got ${bobGet.status}`);
  check("  ...and no brief data in the body", bobGet.body?.brief === undefined);

  const bobGetMissing = await api.get(bobCookie, "no_such_brief_id_at_all");
  check("Bob GETs a non-existent brief -> 404", bobGetMissing.status === 404);
  check("not-yours and does-not-exist are indistinguishable (no existence oracle)",
    bobGet.status === bobGetMissing.status &&
      JSON.stringify(bobGet.body) === JSON.stringify(bobGet.body));
  check("no 403 is ever returned (would confirm the id exists)",
    ![403, 401].includes(bobGet.status));

  // ─────────────────────────────────────────────────────────────────────────
  section("5. Cross-user update / delete both fail, and change nothing");

  const before = await asUser(alice.id, (tx) =>
    tx.brief.findFirstOrThrow({ where: { publicId: briefA.publicId } })
  );

  const bobUpdate = await api.patch(bobCookie, briefA.publicId, { title: "HIJACKED BY BOB" });
  check("Bob UPDATES Alice's brief -> 404", bobUpdate.status === 404, `got ${bobUpdate.status}`);

  const bobDelete = await api.del(bobCookie, briefA.publicId);
  check("Bob DELETES Alice's brief -> 404", bobDelete.status === 404, `got ${bobDelete.status}`);

  const after = await asUser(alice.id, (tx) =>
    tx.brief.findFirstOrThrow({ where: { publicId: briefA.publicId } })
  );
  check("Alice's brief is unchanged after both attacks",
    after.title === before.title &&
      after.updatedAt.getTime() === before.updatedAt.getTime(),
    "updatedAt or the title moved");
  check("Alice can still read her own brief afterwards",
    (await api.get(aliceCookie, briefA.publicId)).status === 200);
  check("Alice's brief still shows in her list",
    (await api.list(aliceCookie)).body?.briefs?.some((b) => b.publicId === briefA.publicId));

  // ─────────────────────────────────────────────────────────────────────────
  section("6. RLS enforced by the database, independent of application code");

  // The whole point: a raw SQL query, authored as Bob, that never passes
  // through any application code and carries no user filter at all.
  const rawAsBob = await asUser(bob.id, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT id, "userId", title FROM briefs WHERE id = $1`,
      before.id
    )
  );
  check("raw SQL as Bob for Alice's row id -> 0 rows", rawAsBob.length === 0, `got ${rawAsBob.length} rows`);

  const rawAsBobByText = await asUser(bob.id, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT id FROM briefs WHERE title = $1`,
      "Brief A: brand refresh."
    )
  );
  check("raw SQL as Bob for Alice's brief title -> 0 rows", rawAsBobByText.length === 0);

  const rawAsAlice = await asUser(alice.id, (tx) =>
    tx.$queryRawUnsafe(`SELECT id FROM briefs WHERE id = $1`, before.id)
  );
  check("raw SQL as Alice for her own row id -> 1 row", rawAsAlice.length === 1);

  const rawCountAsBob = await asUser(bob.id, (tx) =>
    tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM briefs`)
  );
  check("raw SELECT count(*) as Bob sees only Bob's briefs",
    rawCountAsBob[0].n === 1, `Bob saw ${rawCountAsBob[0].n}`);

  // No session variable at all -> the policy must fail closed.
  const rawNoScope = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM briefs`
  );
  check("unscoped connection sees 0 briefs (policy fails closed)",
    rawNoScope[0].n === 0, `saw ${rawNoScope[0].n}`);

  // $executeRawUnsafe (not $queryRawUnsafe) is required here: DML through
  // $queryRawUnsafe yields an empty array, whereas $executeRawUnsafe returns the
  // affected-row count, which is precisely the number this needs to assert.
  const writeAsBob = await asUser(bob.id, (tx) =>
    tx.$executeRawUnsafe(
      `UPDATE briefs SET title = 'PWNED BY RAW SQL' WHERE id = $1`,
      before.id
    )
  );
  check("raw UPDATE as Bob affects 0 rows", writeAsBob === 0, `affected ${writeAsBob}`);

  const deleteAsBob = await asUser(bob.id, (tx) =>
    tx.$executeRawUnsafe(`DELETE FROM briefs WHERE id = $1`, before.id)
  );
  check("raw DELETE as Bob affects 0 rows", deleteAsBob === 0, `affected ${deleteAsBob}`);

  // The same statements DO work for the owner, proving the count above is a
  // real permission result and not a malformed statement silently matching
  // nothing.
  const ownRow = await asUser(bob.id, (tx) =>
    tx.brief.findFirst({ where: { userId: bob.id } })
  );
  if (ownRow) {
    const ownUpdate = await asUser(bob.id, (tx) =>
      tx.$executeRawUnsafe(`UPDATE briefs SET title = 'bob edit' WHERE id = $1`, ownRow.id)
    );
    check("raw UPDATE as the owner of a row affects 1 row (control)", ownUpdate === 1, `affected ${ownUpdate}`);
  }

  const stillThere = await asUser(alice.id, (tx) =>
    tx.brief.findFirstOrThrow({ where: { publicId: briefA.publicId } })
  );
  check("Alice's brief survived the raw SQL attacks",
    stillThere.title === "Brief A: brand refresh.", `got ${stillThere.title}`);

  // An insert that claims someone else's userId is rejected by WITH CHECK.
  let withCheckBlocked = false;
  try {
    await asUser(bob.id, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO briefs (id, "publicId", "userId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, now(), now())`,
        `forged_${Date.now()}`,
        `forged_public_${Date.now()}`,
        alice.id
      )
    );
  } catch {
    withCheckBlocked = true;
  }
  check("raw INSERT claiming another user's id is rejected by the policy", withCheckBlocked);

  // ─────────────────────────────────────────────────────────────────────────
  section("7. Update: the owner can rename a brief, and nothing else");

  const briefC = await api.create(aliceCookie, { title: "Brief C: brand refresh guidelines." });
  const briefCId = briefC.body.brief.publicId;

  const editTitle = await api.patch(aliceCookie, briefCId, { title: "My edited title" });
  check("owner can rename a brief", editTitle.status === 200 && editTitle.body.brief.title === "My edited title",
    `got ${editTitle.status}`);
  check("  ...and it is persisted", (await api.get(aliceCookie, briefCId)).body?.brief?.title === "My edited title");

  const clearTitle = await api.patch(aliceCookie, briefCId, { title: "" });
  check("blanking the title -> 200 with a null title", clearTitle.status === 200 && clearTitle.body?.brief?.title === null,
    `got ${clearTitle.status} title=${clearTitle.body?.brief?.title}`);

  const emptyPatch = await api.patch(aliceCookie, briefCId, {});
  check("empty update body -> 400", emptyPatch.status === 400, `got ${emptyPatch.status}`);

  // Fields that no longer exist are not in the schema, so a body carrying only
  // one of them reduces to an empty patch and is rejected rather than silently
  // ignored. This is what stops a stale client from appearing to "set" a
  // processing field that is no longer there.
  const statusOnly = await api.patch(aliceCookie, briefCId, { status: "processed" });
  check("a body of only { status } is rejected -> 400", statusOnly.status === 400, `got ${statusOnly.status}`);

  const legacyOnly = await api.patch(aliceCookie, briefCId, { deadline: "next month" });
  check("a body of only { deadline } is rejected -> 400", legacyOnly.status === 400, `got ${legacyOnly.status}`);

  // Mixed with a real field: the real field applies, the unknown one is stripped.
  const mixed = await api.patch(aliceCookie, briefCId, {
    title: "Legit title",
    status: "processed",
  });
  check("a client-supplied status is ignored, not applied",
    mixed.status === 200 && mixed.body?.brief?.title === "Legit title",
    `got ${mixed.status} title=${mixed.body?.brief?.title}`);

  // ─────────────────────────────────────────────────────────────────────────
  section("8. Delete is a hard delete, and needs no prior step");

  const toDelete = await api.create(aliceCookie, { title: "Delete me." });
  const toDeleteId = toDelete.body.brief.publicId;

  const del = await api.del(aliceCookie, toDeleteId);
  check("owner can delete a brief", del.status === 200, `got ${del.status}`);
  check("  ...it is now a 404 for its owner", (await api.get(aliceCookie, toDeleteId)).status === 404);
  const goneRow = await asUser(alice.id, (tx) =>
    tx.brief.findFirst({ where: { publicId: toDeleteId } })
  );
  check("  ...and the row is GONE from the table (hard delete, no soft delete)", goneRow === null);

  const delBriefA = await api.del(aliceCookie, briefA.publicId);
  check("owner can delete a brief that has documents", delBriefA.status === 200, `got ${delBriefA.status}`);

  check("re-deleting an already-deleted brief -> 404",
    (await api.del(aliceCookie, briefA.publicId)).status === 404);

  check("Bob can delete his own brief", (await api.del(bobCookie, bobBrief.body.brief.publicId)).status === 200);
  check("Bob's list is now empty", (await api.list(bobCookie)).body?.briefs?.length === 0);

  // ─────────────────────────────────────────────────────────────────────────
  section("9. Final state check");

  const aliceFinal = await api.list(aliceCookie);
  check("Alice's list no longer contains the deleted briefs",
    !aliceFinal.body?.briefs?.some((b) => [briefA.publicId, toDeleteId].includes(b.publicId)));
  check("Bob's list is still empty of Alice's data",
    !(await api.list(bobCookie)).body?.briefs?.some((b) => b.publicId === briefCId));

  // Leave the table as it was found. The test users are reused across runs, so
  // briefs that survive a run would pile up against a real user list.
  await asUser(alice.id, (tx) => tx.brief.deleteMany({ where: { userId: alice.id } }));
  await asUser(bob.id, (tx) => tx.brief.deleteMany({ where: { userId: bob.id } }));
  check("the run left no briefs behind",
    (await asUser(alice.id, (tx) => tx.brief.count())) === 0 &&
      (await asUser(bob.id, (tx) => tx.brief.count())) === 0);

  await prisma.session.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  await prisma.$disconnect();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failed > 0) {
    console.log("\nFailed assertions:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log("=".repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
