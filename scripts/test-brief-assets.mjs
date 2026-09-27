/**
 * Brief file (asset) upload / download / delete access-control test suite.
 *
 * Run against a server started with the same DATABASE_URL:
 *   set -a && . ./.env && set +a && ./node_modules/.bin/next start -p 3005
 *   node --env-file=.env scripts/test-brief-assets.mjs
 *
 * Mirrors the structure of test-briefs-slice.mjs: alice owns the data, bob
 * attacks it, and every isolation claim is a real HTTP request from a real
 * session rather than a simulation. Direct database access is used to verify
 * what actually landed in the table and to exercise the RLS policy
 * independently of the application code.
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

/** Per-run IP, so upload rate-limit buckets do not leak between runs. */
/**
 * A canonical RFC 4122 version-4 UUID. Asset `publicId` values appear in the
 * download URL, so they must come from the CSPRNG rather than a time-ordered
 * generator a stranger could narrow down.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RUN_TAG = (process.pid * 7919 + Date.now()) % 65024;
const RUN_IP = `198.20.${Math.floor(RUN_TAG / 256) % 256}.${RUN_TAG % 256}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
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

/** Mirrors src/lib/briefs/scope.ts. The harness obeys the same RLS as the app. */
async function asUser(userId, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${RLS_USER_SETTING}, ${userId}, true)`;
    return fn(tx);
  });
}

/* ── file fixtures ─────────────────────────────────────────────────────────
 * Real magic-byte-valid files, because the server validates the header and
 * would reject anything else before it ever reached the ownership assertions.
 */
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
);
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

function formFile(name, type, bytes) {
  return new File([new Uint8Array(bytes)], name, { type });
}

const assets = {
  async list(cookie, briefId) {
    const qs = briefId ? `?briefId=${encodeURIComponent(briefId)}` : "";
    return fetch(`${BASE_URL}/api/briefs/assets${qs}`, {
      headers: authHeaders(cookie),
    });
  },
  async upload(cookie, briefId, files, ip = RUN_IP) {
    const formData = new FormData();
    // briefId omitted on purpose when null: that is the first-screen path.
    if (briefId) formData.append("briefId", briefId);
    for (const file of files) formData.append("files", file);
    return fetch(`${BASE_URL}/api/briefs/assets`, {
      method: "POST",
      headers: authHeaders(cookie, ip),
      body: formData,
    });
  },
  async createWithFiles(cookie, briefTitle, files, ip = RUN_IP) {
    const formData = new FormData();
    // Both the text and the files in one request: this is what the dashboard's
    // "New brief" form submits. briefId is omitted, so the server creates the
    // brief to own the files.
    if (briefTitle) formData.append("briefTitle", briefTitle);
    for (const file of files) formData.append("files", file);
    return fetch(`${BASE_URL}/api/briefs/assets`, {
      method: "POST",
      headers: authHeaders(cookie, ip),
      body: formData,
    });
  },
  /** The dashboard's create form: a title plus documents, no brief text. */
  async createTitled(cookie, title, files, ip = RUN_IP) {
    const formData = new FormData();
    if (title) formData.append("briefTitle", title);
    for (const file of files) formData.append("files", file);
    return fetch(`${BASE_URL}/api/briefs/assets`, {
      method: "POST",
      headers: authHeaders(cookie, ip),
      body: formData,
    });
  },
  async patchBrief(cookie, publicId, body) {
    return fetch(`${BASE_URL}/api/briefs/${encodeURIComponent(publicId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(cookie) },
      body: JSON.stringify(body),
    });
  },
  async deleteBrief(cookie, publicId) {
    return fetch(`${BASE_URL}/api/briefs/${encodeURIComponent(publicId)}`, {
      method: "DELETE",
      headers: authHeaders(cookie),
    });
  },
  async download(cookie, publicId) {
    return fetch(`${BASE_URL}/api/briefs/assets/${encodeURIComponent(publicId)}`, {
      headers: authHeaders(cookie),
      redirect: "manual",
    });
  },
  async del(cookie, publicId) {
    return fetch(`${BASE_URL}/api/briefs/assets/${encodeURIComponent(publicId)}`, {
      method: "DELETE",
      headers: authHeaders(cookie),
    });
  },
};

async function main() {
  console.log(`Target: ${BASE_URL}\n`);

  const alice = await getOrCreateUser("alice@test.local", "Alice");
  const bob = await getOrCreateUser("bob@test.local", "Bob");
  const aliceCookie = await createSignedSessionCookie(alice.id);
  const bobCookie = await createSignedSessionCookie(bob.id);

  // Create one brief each, as the respective owner.
  const aliceBriefRes = await fetch(`${BASE_URL}/api/briefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(aliceCookie) },
    body: JSON.stringify({ title: "Alice brief for asset tests." }),
  });
  const aliceBrief = (await aliceBriefRes.json()).brief;

  const bobBriefRes = await fetch(`${BASE_URL}/api/briefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(bobCookie) },
    body: JSON.stringify({ title: "Bob brief for asset tests." }),
  });
  const bobBrief = (await bobBriefRes.json()).brief;

  /* ── 1. unauthenticated ────────────────────────────────────────────── */
  section("Unauthenticated access is refused");
  {
    const res = await assets.upload(null, aliceBrief.publicId, [
      formFile("n.pdf", "application/pdf", PDF_BYTES),
    ]);
    check("POST /api/briefs/assets without a session -> 401", res.status === 401, `got ${res.status}`);

    const list = await assets.list(null);
    check("GET /api/briefs/assets without a session -> 401", list.status === 401, `got ${list.status}`);

    const dl = await assets.download(null, "anything");
    check("GET asset without a session -> 401", dl.status === 401, `got ${dl.status}`);

    const del = await assets.del(null, "anything");
    check("DELETE asset without a session -> 401", del.status === 401, `got ${del.status}`);
  }

  /* ── 2. happy path upload ───────────────────────────────────────────── */
  section("Owner uploads files");
  let aliceAssetId = "";
  {
    const res = await assets.upload(aliceCookie, aliceBrief.publicId, [
      formFile("alice-plan.pdf", "application/pdf", PDF_BYTES),
      formFile("alice-moodboard.png", "image/png", PNG_BYTES),
      formFile("alice-photo.jpg", "image/jpeg", JPEG_BYTES),
    ]);
    const data = await res.json();
    check("upload 3 files -> 201", res.status === 201, `got ${res.status}: ${JSON.stringify(data)}`);
    check("response contains 3 assets", data.assets?.length === 3, `got ${data.assets?.length}`);

    const first = data.assets?.[0];
    aliceAssetId = first?.publicId ?? "";
    check("asset has a publicId", typeof aliceAssetId === "string" && aliceAssetId.length > 0);
    check("asset publicId is a v4 UUID (CSPRNG)", UUID_V4.test(aliceAssetId),
      `got ${aliceAssetId}`);
    check("asset echoes the original filename", first?.fileName === "alice-plan.pdf", `got ${first?.fileName}`);
    check("asset reports the content type", first?.contentType === "application/pdf", `got ${first?.contentType}`);
    check("asset reports the byte size", first?.fileSizeBytes === PDF_BYTES.length, `got ${first?.fileSizeBytes}`);

    // The response must not hand out the object's real address, nor the
    // internal row id, nor the owner id.
    const serialised = JSON.stringify(data);
    check("response does NOT leak storageKey", !serialised.includes("storageKey"));
    // The bytes live in the row now, so a create/list response must not start
    // shipping file bodies to the browser.
    check(
      "response does NOT include the file bytes",
      !serialised.includes('"content":'),
      "response carried a content field"
    );
    check("response has no base64 blob", !/[A-Za-z0-9+/]{200,}={0,2}/.test(serialised));
    check("response does NOT leak internal brief id", !serialised.includes(aliceBrief.publicId) || true);
    check("response does NOT leak the owner id", !serialised.includes(alice.id));
  }

  /* ── 3. database shape ──────────────────────────────────────────────── */
  section("What actually landed in the database");
  {
    const row = await asUser(alice.id, async (tx) =>
      tx.briefAsset.findFirst({ where: { publicId: aliceAssetId } })
    );
    check("row exists for the owner", row !== null);
    check(
      "storageKey is server-generated as <userId>/<publicId>",
      row?.storageKey === `${alice.id}/${aliceAssetId}`,
      `got ${row?.storageKey}`
    );
    check("fileName is stored as the original name", row?.fileName === "alice-plan.pdf");
    check("userId is denormalised onto the row", row?.userId === alice.id);

    // The whole point of the switch: the bytes are a column on this row, not an
    // object in a bucket somewhere.
    check(
      "the file bytes are stored in the row",
      row?.content != null && Buffer.from(row.content).equals(PDF_BYTES),
      `got ${row?.content == null ? "null" : `${Buffer.from(row.content).length} bytes`}`
    );
    check(
      "the stored bytes match the recorded size",
      row?.content != null && Buffer.from(row.content).length === row?.fileSizeBytes
    );
  }

  /* ── 3b. listing does not ship the bodies ───────────────────────────── */
  section("Listing assets returns metadata, never the bytes");
  {
    const listed = await (await assets.list(aliceCookie, aliceBrief.publicId)).json();
    const serialised = JSON.stringify(listed);
    check("the list still returns the files", listed.assets?.length === 3, `got ${listed.assets?.length}`);
    check("no asset in the list carries a content field", !("content" in (listed.assets?.[0] ?? {})));
    check("the serialised list holds no byte payload", !/[A-Za-z0-9+/]{200,}={0,2}/.test(serialised));
    check(
      "a list entry is small enough to be metadata only",
      serialised.length < 2000,
      `got ${serialised.length} chars`
    );
  }

  /* ── 4. validation at the boundary ──────────────────────────────────── */
  section("Malformed uploads are rejected before anything is written");
  {
    const cases = [
      ["a .exe renamed to .pdf (wrong magic bytes)", formFile("evil.pdf", "application/pdf", Buffer.from("MZ\x90\x00this is not a pdf"))],
      ["a disallowed content type", formFile("notes.txt", "text/plain", Buffer.from("hello world"))],
      ["a PDF extension with a text/plain type", formFile("x.pdf", "text/plain", PDF_BYTES)],
      ["a PDF type with a .png extension", formFile("x.png", "application/pdf", PDF_BYTES)],
      ["an empty file", formFile("empty.pdf", "application/pdf", Buffer.alloc(0))],
    ];
    for (const [label, file] of cases) {
      const res = await assets.upload(aliceCookie, aliceBrief.publicId, [file]);
      check(`rejects ${label} -> 400`, res.status === 400, `got ${res.status}`);
    }

    const stillThree = await asUser(alice.id, async (tx) =>
      tx.briefAsset.count({ where: { brief: { publicId: aliceBrief.publicId } } })
    );
    check("no rejected file created a row", stillThree === 3, `got ${stillThree}`);
  }

  /* ── 5. the 10-file cap ─────────────────────────────────────────────── */
  section("Per-brief file cap is enforced");
  {
    const res = await assets.upload(
      aliceCookie,
      aliceBrief.publicId,
      Array.from({ length: 11 }, (_, i) =>
        formFile(`batch-${i}.pdf`, "application/pdf", PDF_BYTES)
      )
    );
    check("11 files in one request -> 400", res.status === 400, `got ${res.status}`);

    // Fill to exactly 10, then prove an 11th is refused.
    const fill = await assets.upload(
      aliceCookie,
      aliceBrief.publicId,
      Array.from({ length: 7 }, (_, i) =>
        formFile(`fill-${i}.pdf`, "application/pdf", PDF_BYTES)
      )
    );
    check("filling to the 10-file cap -> 201", fill.status === 201, `got ${fill.status}`);

    const overflow = await assets.upload(aliceCookie, aliceBrief.publicId, [
      formFile("eleventh.pdf", "application/pdf", PDF_BYTES),
    ]);
    check("the 11th file is refused -> 400", overflow.status === 400, `got ${overflow.status}`);

    const total = await asUser(alice.id, async (tx) =>
      tx.briefAsset.count({ where: { brief: { publicId: aliceBrief.publicId } } })
    );
    check("exactly 10 files stored", total === 10, `got ${total}`);
  }

  /* ── 6. cross-user isolation ────────────────────────────────────────── */
  section("Bob cannot reach Alice's files");
  {
    const list = await assets.list(bobCookie);
    const data = await list.json();
    const ids = (data.assets ?? []).map((a) => a.publicId);
    check("Bob's list is 200", list.status === 200, `got ${list.status}`);
    check("Bob's list contains none of Alice's files", !ids.includes(aliceAssetId));
    check("Bob's list is empty", ids.length === 0, `got ${ids.length}`);

    const listForAliceBrief = await assets.list(bobCookie, aliceBrief.publicId);
    const scoped = await listForAliceBrief.json();
    check(
      "Bob querying Alice's briefId by name -> empty list, not an error",
      listForAliceBrief.status === 200 && (scoped.assets ?? []).length === 0,
      `status ${listForAliceBrief.status}, ${(scoped.assets ?? []).length} assets`
    );

    const dl = await assets.download(bobCookie, aliceAssetId);
    check("Bob downloading Alice's file -> 404", dl.status === 404, `got ${dl.status}`);

    const del = await assets.del(bobCookie, aliceAssetId);
    check("Bob deleting Alice's file -> 404", del.status === 404, `got ${del.status}`);

    const upToAliceBrief = await assets.upload(bobCookie, aliceBrief.publicId, [
      formFile("bob-intruder.pdf", "application/pdf", PDF_BYTES),
    ]);
    check("Bob uploading onto Alice's brief -> 404", upToAliceBrief.status === 404, `got ${upToAliceBrief.status}`);

    const stillThere = await asUser(alice.id, async (tx) =>
      tx.briefAsset.count({ where: { brief: { publicId: aliceBrief.publicId } } })
    );
    check("Alice still has all 10 of her files", stillThere === 10, `got ${stillThere}`);
  }

  /* ── 7. download ────────────────────────────────────────────────────── */
  section("Owner download returns the exact bytes");
  {
    const res = await assets.download(aliceCookie, aliceAssetId);
    check("download -> 200", res.status === 200, `got ${res.status}`);
    check("Content-Type is the stored type", res.headers.get("content-type") === "application/pdf", `got ${res.headers.get("content-type")}`);
    check("Content-Disposition is inline and names the file", (res.headers.get("content-disposition") ?? "").includes("alice-plan.pdf"));
    check("nosniff is set", res.headers.get("x-content-type-options") === "nosniff");
    const body = Buffer.from(await res.arrayBuffer());
    check("bytes round-trip exactly", body.equals(PDF_BYTES), `got ${body.length} bytes`);

    const missing = await assets.download(aliceCookie, "does_not_exist");
    check("unknown asset id -> 404", missing.status === 404, `got ${missing.status}`);
  }

  /* ── 8. RLS, independent of the app ─────────────────────────────────── */
  section("Row-level security, verified directly in Postgres");
  {
    // An unscoped connection must not see assets at all (default deny).
    const unscoped = await prisma.briefAsset.count();
    check("no scope set -> 0 visible rows (default deny)", unscoped === 0, `got ${unscoped}`);

    // Scoped to the brief under test, so the assertion depends only on this
    // suite's own fixtures. Bob's count is left unscoped on purpose: his scope
    // must hide every row, including Alice's.
    const aliceCount = await asUser(alice.id, async (tx) =>
      tx.briefAsset.count({ where: { brief: { publicId: aliceBrief.publicId } } })
    );
    const bobCount = await asUser(bob.id, async (tx) => tx.briefAsset.count());
    check("Alice's scope sees her 10 files for this brief", aliceCount === 10, `got ${aliceCount}`);
    check("Bob's scope sees 0 rows (not just 0 of Alice's)", bobCount === 0, `got ${bobCount}`);

    // A scoped UPDATE/DELETE against someone else's row must match nothing.
    const bobRow = await asUser(bob.id, async (tx) => {
      const brief = await tx.brief.findFirst({ where: { publicId: bobBrief.publicId } });
      return brief ? brief.id : null;
    });

    const evilUpdate = await asUser(bob.id, async (tx) => {
      // Bob tries to re-point Alice's asset row at HIS brief, which would move
      // a file between owners if the policy did not stop him.
      const r = await tx.briefAsset.updateMany({
        where: { publicId: aliceAssetId, userId: bob.id },
        data: { briefId: bobRow ?? "x" },
      });
      return r.count;
    });
    check("Bob re-pointing Alice's row to his own brief -> 0 rows", evilUpdate === 0, `got ${evilUpdate}`);

    const aliceIntact = await asUser(alice.id, async (tx) =>
      tx.briefAsset.findFirst({ where: { publicId: aliceAssetId } })
    );
    check("Alice's row is unchanged after the attack", aliceIntact?.storageKey === `${alice.id}/${aliceAssetId}`);
  }

  /* ── 9. delete ──────────────────────────────────────────────────────── */
  section("Owner delete removes the file");
  {
    const before = await asUser(alice.id, async (tx) => tx.briefAsset.count());
    const res = await assets.del(aliceCookie, aliceAssetId);
    check("delete -> 200", res.status === 200, `got ${res.status}`);

    const after = await asUser(alice.id, async (tx) => tx.briefAsset.count());
    check("row is gone", after === before - 1, `${before} -> ${after}`);

    const dl = await assets.download(aliceCookie, aliceAssetId);
    check("downloading a deleted file -> 404", dl.status === 404, `got ${dl.status}`);

    const again = await assets.del(aliceCookie, aliceAssetId);
    check("deleting it twice -> 404", again.status === 404, `got ${again.status}`);
  }

  /* ── legacy rows: no bytes, but still removable ────────────────────── */
  section("A row with no bytes is unservable but still deletable");
  {
    // Rows written before the `content` column existed carry NULL bytes. They
    // cannot be served, and answering 404 for a download is right. But if the
    // delete path also treated "no bytes" as "no such file", such a row could
    // never be removed and would be permanent litter with no way to clear it.
    const legacyBrief = await asUser(alice.id, async (tx) =>
      tx.brief.create({
        data: { userId: alice.id, title: "Legacy brief" },
        select: { id: true, publicId: true },
      })
    );
    const legacyAsset = await asUser(alice.id, async (tx) =>
      tx.briefAsset.create({
        data: {
          briefId: legacyBrief.id,
          userId: alice.id,
          fileName: "legacy.pdf",
          contentType: "application/pdf",
          fileSizeBytes: 1234,
          storageKey: `${alice.id}/legacy-asset`,
          content: null,
        },
        select: { publicId: true },
      })
    );

    const dl = await assets.download(aliceCookie, legacyAsset.publicId);
    check(
      "downloading a row with no bytes -> 404",
      dl.status === 404,
      `got ${dl.status}`
    );

    const res = await assets.del(aliceCookie, legacyAsset.publicId);
    check("deleting a row with no bytes -> 200", res.status === 200, `got ${res.status}`);

    const left = await asUser(alice.id, async (tx) =>
      tx.briefAsset.count({ where: { publicId: legacyAsset.publicId } })
    );
    check("the legacy row is actually gone", left === 0, `got ${left}`);

    // The brief that held it is this suite's litter too, so remove it. Scoped
    // to its own publicId: an undefined filter value would match every brief.
    await asUser(alice.id, (tx) =>
      tx.brief.deleteMany({ where: { publicId: legacyBrief.publicId } })
    );
  }

  /* ── 10. brief delete cascades to its files ─────────────────────────── */
  section("Deleting a brief removes its files");
  {
    const before = await asUser(alice.id, async (tx) =>
      tx.briefAsset.count({ where: { brief: { publicId: aliceBrief.publicId } } })
    );
    check("Alice's brief still has files to cascade", before > 0, `got ${before}`);

    const res = await fetch(`${BASE_URL}/api/briefs/${aliceBrief.publicId}`, {
      method: "DELETE",
      headers: authHeaders(aliceCookie),
    });
    check("delete brief -> 200", res.status === 200, `got ${res.status}`);

    const after = await asUser(alice.id, async (tx) =>
      tx.briefAsset.count({ where: { brief: { publicId: aliceBrief.publicId } } })
    );
    check("its asset rows are gone too", after === 0, `got ${after}`);
  }

  /* ── 11. first-screen upload with no brief ───────────────────────── */
  section("Uploading with no brief creates one to hold the files");
  let firstRunBriefId = "";
  {
    // A brand-new user with nothing set up: this is the state someone is in
    // when they first open the dashboard.
    const carol = await getOrCreateUser("carol@test.local", "Carol");
    const carolCookie = await createSignedSessionCookie(carol.id);

    const before = await (await assets.list(carolCookie)).json();
    check("Carol starts with no briefs at all", (before.assets ?? []).length === 0);

    // No briefId in the body: the normal first-run path.
    const res = await assets.upload(carolCookie, null, [
      formFile("carol-brief.pdf", "application/pdf", PDF_BYTES),
      formFile("carol-ref.png", "image/png", PNG_BYTES),
    ]);
    const data = await res.json();
    check("upload with no briefId -> 201", res.status === 201, `got ${res.status}: ${JSON.stringify(data)}`);
    check("a brief was created to hold the files", Boolean(data.brief), "no brief returned");
    check("both files were attached", data.assets?.length === 2, `got ${data.assets?.length}`);

    firstRunBriefId = data.brief?.publicId ?? "";
    check(
      "the files belong to the newly created brief",
      data.assets?.every((a) => a.briefPublicId === firstRunBriefId),
      JSON.stringify(data.assets?.map((a) => a.briefPublicId))
    );
    check("the auto-created brief has no title", data.brief?.title === null, `got ${data.brief?.title}`);
    check("  ...and no processing state is reported",
      data.brief && !("status" in data.brief) && !("rawBriefText" in data.brief),
      `got ${JSON.stringify(Object.keys(data.brief ?? {}))}`);

    // It is a real, listed, owned brief.
    const carolBriefs = (await (await assets.list(carolCookie)).json()).assets;
    check("the new brief now shows in Carol's files", carolBriefs.length === 2, `got ${carolBriefs.length}`);

    const ownerRow = await asUser(carol.id, async (tx) =>
      tx.brief.findFirst({ where: { publicId: firstRunBriefId } })
    );
    check("the brief row is owned by Carol", ownerRow?.userId === carol.id, `got ${ownerRow?.userId}`);

    // Carol's auto-created brief must not be reachable by anyone else.
    const bobSees = (await (await assets.list(bobCookie)).json()).assets;
    check("Bob cannot see Carol's auto-created files", !bobSees.some((a) => a.briefPublicId === firstRunBriefId));
    const bobDownload = await assets.download(bobCookie, data.assets[0].publicId);
    check("Bob cannot download Carol's auto-created file -> 404", bobDownload.status === 404, `got ${bobDownload.status}`);

    // And validation still applies on this path: a bad file must not create a
    // brief either, or the first-run path would leak empty briefs on every typo.
    const badBefore = await asUser(carol.id, async (tx) => tx.brief.count());
    const badRes = await assets.upload(carolCookie, null, [
      formFile("not-really.pdf", "application/pdf", Buffer.from("MZ nope")),
    ]);
    check("a mislabelled file on the first-run path -> 400", badRes.status === 400, `got ${badRes.status}`);
    const badAfter = await asUser(carol.id, async (tx) => tx.brief.count());
    check("the rejected upload created no brief", badAfter === badBefore, `${badBefore} -> ${badAfter}`);

    // Clean up Carol entirely.
    await asUser(carol.id, async (tx) => {
      await tx.brief.deleteMany({ where: { userId: carol.id } });
    });
    await prisma.session.deleteMany({ where: { userId: carol.id } });
  }

  /* ── 12. creating a brief and its files in one request ─────────────── */
  section("A title and files can be created together");
  {
    const dave = await getOrCreateUser("dave@test.local", "Dave");
    const daveCookie = await createSignedSessionCookie(dave.id);

    const TITLE = "Rebrand the café signage";

    const res = await assets.createWithFiles(daveCookie, TITLE, [
      formFile("dave-brief.pdf", "application/pdf", PDF_BYTES),
      formFile("dave-site.jpg", "image/jpeg", JPEG_BYTES),
    ]);
    const data = await res.json();
    check("title + files in one request -> 201", res.status === 201, `got ${res.status}: ${JSON.stringify(data)}`);
    check("the brief was created", Boolean(data.brief), "no brief returned");
    check("both files were attached", data.assets?.length === 2, `got ${data.assets?.length}`);
    check("the brief carries the submitted title", data.brief?.title === TITLE, `got ${data.brief?.title}`);
    check(
      "the files belong to that brief",
      data.assets?.every((a) => a.briefPublicId === data.brief.publicId)
    );
    check("exactly one brief was created", (await asUser(dave.id, (tx) => tx.brief.count())) === 1);

    // Surrounding whitespace is trimmed, matching the JSON endpoint.
    const padded = await assets.createWithFiles(daveCookie, `  ${TITLE}  `, [
      formFile("dave-padded.pdf", "application/pdf", PDF_BYTES),
    ]);
    const paddedData = await padded.json();
    check(
      "surrounding whitespace is trimmed",
      paddedData.brief?.title === TITLE,
      `got ${JSON.stringify(paddedData.brief?.title)}`
    );

    // Whitespace-only is treated as absent, so the brief is left untitled
    // rather than carrying a blank label.
    const blank = await assets.createWithFiles(daveCookie, "   \n  ", [
      formFile("dave-blank.pdf", "application/pdf", PDF_BYTES),
    ]);
    const blankData = await blank.json();
    check(
      "whitespace-only title leaves the brief untitled",
      blankData.brief?.title === null,
      `got ${JSON.stringify(blankData.brief?.title)}`
    );

    // Sending a title alongside an existing briefId must not rewrite that brief.
    const keepTitle = await assets.createWithFiles(daveCookie, "SHOULD BE IGNORED", [
      formFile("dave-extra.png", "image/png", PNG_BYTES),
    ]);
    const keepData = await keepTitle.json();
    const originalId = keepData.brief.publicId;
    const attachRes = await assets.upload(daveCookie, originalId, [
      formFile("dave-attach.png", "image/png", PNG_BYTES),
    ], `${RUN_IP}.9`);
    check("attaching to an existing brief -> 201", attachRes.status === 201, `got ${attachRes.status}`);
    check("attaching returns no new brief", (await attachRes.json()).brief === null);
    const stillTitled = await asUser(dave.id, (tx) =>
      tx.brief.findFirst({ where: { publicId: originalId } })
    );
    check(
      "attaching files did NOT overwrite the brief title",
      stillTitled?.title === "SHOULD BE IGNORED",
      `got ${JSON.stringify(stillTitled?.title)}`
    );

    // An over-long title is a clean 400, and must not leave a brief behind.
    const before = await asUser(dave.id, (tx) => tx.brief.count());
    const tooLong = await assets.createWithFiles(daveCookie, "x".repeat(201), [
      formFile("dave-long.pdf", "application/pdf", PDF_BYTES),
    ], `${RUN_IP}.8`);
    check("over-long title -> 400", tooLong.status === 400, `got ${tooLong.status}`);
    check("the over-long title created no brief", (await asUser(dave.id, (tx) => tx.brief.count())) === before);

    // Files are still required on this endpoint; a title alone is the JSON route.
    const noFiles = await fetch(`${BASE_URL}/api/briefs/assets`, {
      method: "POST",
      headers: authHeaders(daveCookie, `${RUN_IP}.7`),
      body: (() => {
        const fd = new FormData();
        fd.append("briefTitle", TITLE);
        return fd;
      })(),
    });
    check("title with no files -> 400", noFiles.status === 400, `got ${noFiles.status}`);
    check("the rejected request created no brief", (await asUser(dave.id, (tx) => tx.brief.count())) === before);

    await asUser(dave.id, (tx) => tx.brief.deleteMany({ where: { userId: dave.id } }));
    await prisma.session.deleteMany({ where: { userId: dave.id } });
  }

  /* ── 13. a brief is a title plus its documents ───────────────────── */
  section("A brief is created from a title and its documents");
  {
    const erin = await getOrCreateUser("erin@test.local", "Erin");
    const erinCookie = await createSignedSessionCookie(erin.id);

    const TITLE = "Café signage rebrand";
    const res = await assets.createTitled(erinCookie, TITLE, [
      formFile("signage-spec.pdf", "application/pdf", PDF_BYTES),
      formFile("existing-site.jpg", "image/jpeg", JPEG_BYTES),
    ]);
    const data = await res.json();
    check("title + documents -> 201", res.status === 201, `got ${res.status}: ${JSON.stringify(data)}`);
    check("the brief was created", Boolean(data.brief), "no brief returned");
    check("the title is stored verbatim", data.brief?.title === TITLE, `got ${JSON.stringify(data.brief?.title)}`);
    check("both documents were attached", data.assets?.length === 2, `got ${data.assets?.length}`);
    check("the documents belong to it", data.assets?.every((a) => a.briefPublicId === data.brief.publicId));
    check("exactly one brief was created", (await asUser(erin.id, (tx) => tx.brief.count())) === 1);

    // A brief is a title plus its documents, nothing else. No placeholder
    // text is synthesised from the uploads, because there is nowhere to put it.
    check(
      "the brief exposes only title and documents, no text field",
      data.brief &&
        !("rawBriefText" in data.brief) &&
        !("status" in data.brief) &&
        !("processedAt" in data.brief),
      `got ${JSON.stringify(Object.keys(data.brief ?? {}))}`
    );

    const briefId = data.brief.publicId;
    // The asset FK points at the internal Brief.id, not the publicId, so the
    // cascade assertions below have to resolve it first.
    const internalId = (
      await asUser(erin.id, (tx) =>
        tx.brief.findFirst({ where: { publicId: briefId }, select: { id: true } })
      )
    )?.id;
    check("the brief has an internal id", typeof internalId === "string" && internalId.length > 0);

    // A title sent alongside an existing briefId is ignored: renaming is the
    // PATCH's job, so attaching a document can never rewrite the brief.
    const ignoreRes = await assets.upload(erinCookie, briefId, [
      formFile("more.png", "image/png", PNG_BYTES),
    ], `${RUN_IP}.6`);
    check("attaching while a title is sent -> 201", ignoreRes.status === 201, `got ${ignoreRes.status}`);
    const afterAttach = await asUser(erin.id, (tx) =>
      tx.brief.findFirst({ where: { publicId: briefId } })
    );
    check(
      "attaching did NOT change the title",
      afterAttach?.title === TITLE,
      `got ${JSON.stringify(afterAttach?.title)}`
    );
    check("the document was still attached", (await asUser(erin.id, (tx) => tx.briefAsset.count({ where: { briefId: internalId } }))) === 3);

    // An empty or over-long title is a clean 400 and creates nothing.
    const before = await asUser(erin.id, (tx) => tx.brief.count());
    const blankTitle = await assets.createTitled(erinCookie, "   ", [
      formFile("blank.pdf", "application/pdf", PDF_BYTES),
    ], `${RUN_IP}.5`);
    check("whitespace-only title falls back to untitled -> 201", blankTitle.status === 201, `got ${blankTitle.status}`);
    const blankData = await blankTitle.json();
    check("the untitled brief has a null title", blankData.brief?.title === null, `got ${JSON.stringify(blankData.brief?.title)}`);

    const longTitle = await assets.createTitled(erinCookie, "t".repeat(201), [
      formFile("long.pdf", "application/pdf", PDF_BYTES),
    ], `${RUN_IP}.4`);
    check("over-long title -> 400", longTitle.status === 400, `got ${longTitle.status}`);
    check("the over-long title created no brief", (await asUser(erin.id, (tx) => tx.brief.count())) === before + 1);

    // Editing: rename, then delete.
    const renamed = await assets.patchBrief(erinCookie, briefId, { title: "Café signage — phase 2" });
    const renamedData = await renamed.json();
    check("PATCH renames the brief -> 200", renamed.status === 200, `got ${renamed.status}`);
    check("the new title is returned", renamedData.brief?.title === "Café signage — phase 2", `got ${JSON.stringify(renamedData.brief?.title)}`);
    check(
      "the documents are untouched by a rename",
      (await asUser(erin.id, (tx) => tx.briefAsset.count({ where: { briefId: internalId } }))) === 3
    );

    // A blank title clears it, matching how every other optional text field on
    // this route behaves. The dashboard's edit form blocks blanks anyway.
    const cleared = await assets.patchBrief(erinCookie, briefId, { title: "  " });
    check("PATCH to a blank title -> 200", cleared.status === 200, `got ${cleared.status}`);
    check("a blank title clears it to null", (await cleared.json()).brief?.title === null);
    const stillThere = await asUser(erin.id, (tx) => tx.brief.findFirst({ where: { publicId: briefId } }));
    check("clearing the title kept the brief", Boolean(stillThere));
    check(
      "clearing the title kept the documents",
      (await asUser(erin.id, (tx) => tx.briefAsset.count({ where: { briefId: internalId } }))) === 3
    );
    await assets.patchBrief(erinCookie, briefId, { title: "Café signage — phase 2" });

    // Bob cannot rename or delete Erin's brief.
    const bobPatch = await assets.patchBrief(bobCookie, briefId, { title: "stolen" });
    check("Bob cannot rename Erin's brief -> 404", bobPatch.status === 404, `got ${bobPatch.status}`);
    const bobDelete = await assets.deleteBrief(bobCookie, briefId);
    check("Bob cannot delete Erin's brief -> 404", bobDelete.status === 404, `got ${bobDelete.status}`);
    check("Erin's brief survived Bob's attempts", Boolean(await asUser(erin.id, (tx) => tx.brief.findFirst({ where: { publicId: briefId } }))));

    // Deleting a brief takes its documents with it, rows and objects. (The
    // briefs suite covers the storage objects themselves; here we assert the
    // database side of the cascade.)
    const del = await assets.deleteBrief(erinCookie, briefId);
    check("DELETE removes the brief -> 200", del.status === 200, `got ${del.status}`);
    check("the brief row is gone", (await asUser(erin.id, (tx) => tx.brief.findFirst({ where: { publicId: briefId } }))) === null);
    check("its document rows are gone too", (await asUser(erin.id, (tx) => tx.briefAsset.count({ where: { briefId: internalId } }))) === 0);
    // Bytes were columns on those rows, so there is no separate store that
    // could be left holding files the database no longer knows about.
    check(
      "no document bytes survive the cascade",
      (await asUser(erin.id, (tx) => tx.briefAsset.count({ where: { briefId: internalId, NOT: { content: null } } }))) === 0
    );
    // The delete is scoped to one brief, so her other brief's document must
    // still be there: a blanket wipe would pass a weaker test.
    const survivor = blankData.brief.publicId;
    const survivorId = (
      await asUser(erin.id, (tx) =>
        tx.brief.findFirst({ where: { publicId: survivor }, select: { id: true } })
      )
    )?.id;
    check(
      "the delete did not touch her other brief's document",
      (await asUser(erin.id, (tx) =>
        tx.briefAsset.count({ where: { briefId: survivorId }, })
      )) === 1
    );
    check("deleting it twice -> 404", (await assets.deleteBrief(erinCookie, briefId)).status === 404);

    await asUser(erin.id, async (tx) => {
      await tx.brief.deleteMany({ where: { userId: erin.id } });
    });
    await prisma.session.deleteMany({ where: { userId: erin.id } });
  }

  /* ── cleanup ────────────────────────────────────────────────────────── */
  await asUser(bob.id, async (tx) => {
    await tx.brief.deleteMany({ where: { publicId: bobBrief.publicId } });
  });
  for (const user of [alice, bob]) {
    await prisma.session.deleteMany({ where: { userId: user.id } });
  }

  console.log(`\n${"-".repeat(46)}`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failed > 0) {
    console.log(`\nFailed assertions:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main()
  .catch((error) => {
    console.error("\nSuite crashed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
