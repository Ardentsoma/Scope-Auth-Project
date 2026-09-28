# DOCUMENTATION.md

## Section 1: What This Is

This slice lets a signed-in user create, view, edit, and delete their own
"briefs." A brief is a title plus a set of uploaded documents (PDFs, JPGs,
PNGs). The entire point of this slice is that a brief is private to the user
who created it: no other user can list it, read it, download its files,
change it, or delete it, under any request they can construct, including
ones a normal UI would never let them attempt.

Deliberately not included: there is no processing of a brief's contents (no
AI summarisation, no derived fields, no status), because that belongs to a
separate slice built elsewhere and mixing it in here would blur what this
document is proving. There is also no soft-delete or admin override path,
since both would complicate the ownership story this slice exists to
demonstrate, for no benefit at this scope.

The sign-in, session, and email-verification machinery that decides *who* the
current user is was built in an earlier slice and is treated here as a given.
`src/proxy.ts` redirects unauthenticated visitors away from `/dashboard`
before the page renders, and every API route calls `getSessionUser()` and
returns 401 before touching the database.

## Section 2: How To Run It

1. Install Node.js (LTS) and PostgreSQL, and clone the repository.
2. Run `npm install`.
3. Start or create a PostgreSQL database with an **owner** role. The bundled
   `docker-compose.yml` does this: `docker compose up -d` creates the database
   `scope_briefs` owned by the login `scope`.
4. Create the **application** role yourself. This step is deliberately not a
   migration, so that no password ever lands in version control:

   ```sql
   CREATE ROLE scope_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOBYPASSRLS;
   GRANT CONNECT ON DATABASE scope_briefs TO scope_app;
   ```

   Nothing else creates this role. If you skip it, the grant migration
   (`20260926070000_grant_app_role`) prints a `NOTICE` and skips, and the app
   then cannot connect at all.
5. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL`: the connection string the running app uses. Must point
     at the restricted `scope_app` role, never the owner role, or row-level
     security is silently bypassed (see Section 5).
   - `ADMIN_DATABASE_URL`: the connection string used only for migrations
     and for `npm run db:studio`. Points at the owner role (`scope`).
   - `AUTH_SECRET`: the HMAC key used to sign the session cookie. Generate
     one with `openssl rand -hex 32`. This is not optional: with it unset,
     `isAuthConfigured()` returns false, `/dashboard` redirects to `/signin`,
     and the auth proxy stops gating anything.
   - `DATABASE_APP_ROLE` (optional): overrides the expected app role name
     checked at startup. Defaults to `scope_app` if left blank.
   - `SMTP_USER` / `SMTP_PASS` (optional): leave blank to run in development
     mode, where the verification email is printed to the server console with
     an `[email:dev]` prefix instead of being sent.
6. Run `npx prisma migrate deploy` to apply the schema. Do not use
   `npx prisma migrate dev` against a database with real data in it, since it
   can offer to reset the schema (see Section 6).
7. Start the app with `npm run dev`.
8. Create an account at `http://localhost:3000/create-account`, verify the
   emailed code, then sign in. There is no seeded user, and sign-in is refused
   until `emailVerifiedAt` is set, so you cannot reach `/dashboard` without
   doing this first.
9. Visit `http://localhost:3000/dashboard`.

`.env.example` in the repository root documents the variables above, with
example values rather than commented-out placeholders. It does **not**
mention `DATABASE_APP_ROLE`; that override is read from the environment but
has no entry in the example file. No real credentials are committed — `.env`
is gitignored and only `.env.example` is tracked.

## Section 3: The Flow, Step By Step

**Creating a brief with files.** The user fills in a title and picks files on
the "New brief" form on `/dashboard`. The frontend submits one multipart
request with no `briefId`, to `POST /api/briefs/assets`. The route in
`src/app/api/briefs/assets/route.ts` validates every file first (size,
declared type, extension, magic bytes) and aborts the whole request on the
first failure, so a rejected file never results in a partially-accepted batch.
Only once all files pass does the route call `createBrief` in
`src/lib/briefs/service.ts`, which inserts the `Brief` row with `userId` taken
from the session, never from the request body. That is a **separate
transaction** from the one that stores the files: `createAssetsForBrief` in
`src/lib/briefs/assets.ts` opens its own scoped transaction and inserts each
file's metadata and bytes together in it. If the file insert then fails, the
route best-effort deletes the brief it had just created, so a failed upload
does not leave behind a brief the user never asked for — but that unwinding is
compensating logic, not atomicity, and a crash between the two inserts would
leave an empty brief behind.

**Creating a title-only brief.** `POST /api/briefs` does this, inserting one
row via `createBrief` in `service.ts` with `userId` set from the session. It is
a real, tested endpoint, but no screen in the app reaches it: the dashboard's
create form requires at least one file and refuses to submit without one. Only
the test suite exercises this path.

**Viewing the list.** `/dashboard` is a server component. On page load it calls
`listBriefs(user.id)` and `listAllAssets(user.id)` directly and passes the
results into the client component as initial props — it does not call the list
endpoints over HTTP, so the first paint needs no request. Every one of those
queries carries the current user's id in its filter, and this is additionally
enforced by the database itself (see Section 5), so the response can only ever
contain that user's briefs.

**Viewing or downloading one brief.** Selecting a brief from the list is local
state in the browser and makes no request. Opening a file inside the selected
brief requests it by the asset's public id from `GET /api/briefs/assets/
[publicId]`. The server looks it up scoped to the current user; if it exists
but belongs to someone else, or doesn't exist at all, or exists but has no
stored bytes, the response is an identical 404 in every case.

**Editing.** Editing is two sequential requests issued by the browser, not one.
If the title changed, the edit form sends `PATCH /api/briefs/[publicId]` with
the new title as JSON. If files were chosen, it then sends a second multipart
request to `POST /api/briefs/assets` carrying the existing `briefId`. The
`PATCH` endpoint is JSON-only and cannot accept files; the ordering is a
client-side decision, so a failed upload does surface as "the title was saved,
but the upload failed" rather than discarding the rename.

**Deleting.** The user confirms deletion in the UI, which sends
`DELETE /api/briefs/[publicId]`. The server issues one scoped delete; the
database cascades the removal of the brief's file rows (and their bytes)
automatically.

## Section 4: The Data Model

**`Brief`**: one row per brief a user owns.

| Column | Type | Decision |
|---|---|---|
| `id` | String (cuid) | Internal primary key. Never returned to a client, so it can be a cheap, non-secret identifier. |
| `publicId` | String (UUIDv4) | The only id ever exposed in a URL or API response. Must be unguessable, so it uses a cryptographically random generator, not the internal id's generator. |
| `userId` | String, FK to User, NOT NULL | Set only from the authenticated session. NOT NULL because a brief with no owner is a meaningless, unreachable row under this slice's access model. |
| `title` | String, nullable | The user's own label. Nullable because a brief can exist with only files and no title yet. |
| `createdAt`, `updatedAt` | DateTime | Standard bookkeeping. |

Backed by indexes on `(userId, createdAt)` and `(userId, title)`.

**`BriefAsset`**: one row per uploaded file, many per brief.

| Column | Type | Decision |
|---|---|---|
| `id` | String (cuid) | Internal primary key, never returned to a client. |
| `publicId` | String (UUIDv4) | The file's own external identifier, same unguessability rule as `Brief.publicId`. |
| `briefId` | FK to Brief, `ON DELETE CASCADE` | Deleting a brief must remove its files with no separate cleanup step, so an orphaned file row is impossible by construction. |
| `userId` | String, FK to User, NOT NULL | Denormalised from the parent brief on purpose: it lets a file be authorised with one direct query, rather than joining through `Brief` first. A join that gets forgotten in a future query is a cross-user read waiting to happen; the copy removes that risk entirely. |
| `fileName` | String | The user's original filename, sanitised of directory components and control characters, for display only. |
| `contentType` | String | The validated, allow-listed content type. |
| `fileSizeBytes` | Integer | Measured from the buffer that was actually written, not the client-declared length. |
| `storageKey` | String, unique, server-generated | Never derived from anything the user supplies, so nothing about a file's storage location can be influenced by user input. Formatted `<userId>/<assetPublicId>`. Filtered out of every client response. |
| `content` | Bytes, nullable | Nullable only so a schema migration could not fail against pre-existing rows from a prior storage approach. Every read path treats `NULL` as "no bytes" and answers 404; every new row writes its bytes in the same INSERT as its metadata. |
| `createdAt` | DateTime | Standard bookkeeping. |

Backed by indexes on `(userId, createdAt)` and `(briefId)`.

**Which constraints make an invalid state impossible:**
- `userId NOT NULL` on both tables makes an ownerless row impossible to
  insert at all, closing off any code path that might otherwise create data
  nothing can ever legitimately claim.
- `ON DELETE CASCADE` on `briefId` makes an orphaned file row (one whose
  brief no longer exists) impossible, regardless of what application code
  does or forgets to do.
- The row-level security policy's `WITH CHECK` clause (Section 5) makes it
  impossible to insert or update a row that claims a `userId` other than the
  one currently authenticated, even if application code had a bug that tried.

## Section 5: The Concepts
### Row-Level Security (RLS)

**What it is.** Row-level security is a Postgres feature that lets the
database itself refuse to return or modify rows that don't belong to the
current caller, regardless of what query was written to ask for them.

**Why it is needed.** Without it, every single one of the dozens of queries
in this slice would individually have to remember to filter by owner. One
query written in a hurry that forgets that filter, for example a future
`findUnique({ where: { id } })` with no `userId`, hands back another user's
brief in full, and no amount of code review guarantees every future query
gets it right.

**How I implemented it.** `ENABLE ROW LEVEL SECURITY` on both tables, with a
matching policy:

```sql
CREATE POLICY "briefs_owner_isolation" ON "briefs"
  FOR ALL
  TO PUBLIC
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
```

`brief_assets` has an identical policy under its own name. The current user's
id is set once per transaction in `src/lib/briefs/scope.ts`, with
`set_config(..., is_local => true)` so it is discarded on commit or rollback
and cannot bleed onto a reused pooled connection. Every brief read and write in
the application goes through `withBriefScope`; there is no unscoped escape
hatch.

**What I chose against, and why.** Relying only on application-level
filtering (a `WHERE userId = ...` clause hand-written into every query) was
the alternative, and it's still done as a first line of defence, but it was
not trusted as the *only* line. It depends entirely on every present and
future line of code being correct; RLS depends on the database, which is
enforced the same way for every caller including raw SQL, so it was chosen
as the authoritative layer rather than the only one.

### Preventing Cross-User Access via Direct IDs (IDOR)

**What it is.** An Insecure Direct Object Reference is when an application
takes an id from a request and fetches or modifies the matching row without
checking whether the current user is actually allowed to touch that row.

**Why it is needed.** Without this, a user could take their own brief's URL,
change the id in it to a guessed or observed one, and read or delete someone
else's brief directly, with no need to break into anything, just by editing
a number or id in a request.

**How I implemented it.** Every read and every write filters on both the
target id and the current `userId` in the same statement, so a mismatch
returns zero rows rather than the wrong row:

```ts
await tx.brief.deleteMany({ where: { publicId, userId } });
```

There is no version of this code that looks the row up first and checks
ownership afterward; the check and the action are the same database call. The
asset service follows the same rule, including for the upload path, where the
parent brief is resolved with a scoped `findFirst` before any file is written.

**What I chose against, and why.** A "look it up, then check `.userId ===
currentUser.id` in application code, then act" pattern was the alternative.
It was rejected because it introduces a gap between the check and the
action where the two could, in a future refactor, drift apart, whereas a
single scoped statement cannot.

### Fail-Closed Authorization

**What it is.** If the system ever gets confused about who's asking, or that information is missing entirely, it defaults to showing nothing rather than showing everything.

**Why it is needed.** If some future code change accidentally forgets to say who the current user is, and the system's default reaction was "just show all the rows," that one small mistake would hand over every user's private data at once instead of just failing quietly.

**How I implemented it.** The security rule checks "does this row belong to whoever is currently asking?" When nobody's identity was set, that comparison can never come out true, since there's nothing to match against. So instead of accidentally matching everything, it matches nothing. I tested this directly: sending a request with no identity set returns zero briefs, not all of them.

What I chose against, and why. The other option was to let a missing identity default to "show everything," trusting that the rest of the app would always remember to set it correctly first. That's exactly the kind of trust this whole safety setup is meant to avoid relying on.

### 404 Instead of 403 (Information Disclosure)

**What it is.** When someone asks for a brief that isn't theirs, or one that doesn't exist at all, they get the exact same "not found" answer either way, not a different message that would give away which one it actually was.

**Why it is needed.** If the two cases looked different, someone could try a bunch of guessed ids and use the different responses to figure out which ids are real, basically counting how many private briefs exist and which ones are live, without ever seeing the actual contents.

**How I implemented it.** Anytime a lookup, edit, or delete comes back empty, whether the brief truly doesn't exist or just belongs to someone else, the app treats it the same way and sends back an identical "not found" response. A file that exists in the database but has no bytes saved (an old leftover row) also gets treated as "not found" for the same reason, so it can't be told apart from something that was never there. This is checked directly in `scripts/test-briefs-slice.mjs`, which confirms both situations produce the exact same response.

**What I chose against, and why.** The more typical approach would be to send a different response ("forbidden") when the brief exists but isn't yours. That was rejected because it would confirm the brief is real, which gives away more than it's worth just to follow convention.

### Unguessable Identifiers

**What it is.** Every id shown to the outside world is generated using a proper randomizer built for security, so nobody can guess one from another.

**Why it is needed.** If ids followed a pattern (like counting up, or based on when something was created), someone could just work through them in order and try each one. The security rule still blocks them from actually reading anything, but a guessable id space still invites pointless scanning and adds noise to logs and rate limits meant to catch that kind of thing.

**How I implemented it.** Every `publicId` on both tables is a properly randomized id (UUIDv4). The app explicitly generates one using `randomUUID()` from `node:crypto` every time it creates a row, and the database itself is set up the same way as a backup, so even a raw insert can't accidentally end up with something weaker:

```prisma
publicId String @unique @default(dbgenerated("(gen_random_uuid())::text"))
```

The tests check that every id actually has this exact random shape, so if anyone ever accidentally switched back to a weaker id generator, the tests would catch it immediately.

**What I chose against, and why.** It originally used Prisma's built-in `cuid()` id, which avoids duplicates but is partly based on the current time, so someone could narrow down the guessing range if they knew roughly when something was created. That's a different guarantee than "impossible to guess," so it was swapped out.

### Database Role Separation and Startup Verification

**What it is.** The app logs into the database using a limited, restricted account, while a separate, more powerful account is reserved only for manual admin work and setup. A check runs automatically to make sure the app is actually using the right one.

**Why it is needed.** Postgres has a quirk: whoever owns a table gets to skip that table's own security rules. If the app ever accidentally logged in using the powerful account instead of the restricted one, all of the security protections would turn off silently, with no error or warning telling anyone.

**How I implemented it.** Two separate logins: `scope_app` (what the app uses day to day, owns nothing, has no special powers, set up outside the codebase so no password ends up saved in it) and `scope` (the powerful one, only used for admin browsing and setup work). Before the app touches the database at all, `src/lib/db-role.ts` runs a check (through a function called `ensureAppDatabaseRole`) that asks the database "which login am I, and does it have any powers it shouldn't?" If anything looks wrong, the app refuses to run at all instead of continuing quietly. This check only costs one extra question per run, and if it ever fails, it doesn't get remembered as "fine" afterward, so fixing the login and trying again works right away without needing a restart. It also only runs once the app actually needs the database, not the moment the app is built, so building the app doesn't require a live database connection.

**What I chose against, and why.** The original setup used just one powerful login, with an extra Postgres setting that forces even that account to follow its own rules. The problem was that setting affected every single connection, including the tool used to browse the database by hand, which then couldn't see anything unless it separately identified itself, making the data look like it had disappeared (see Section 6).

### File Upload Validation

**What it is.** Before accepting an uploaded file, checking that it really is what it claims to be, using more than one way of checking.

**Why it is needed.** A browser can say a file is one type when it's actually another, and so can a file's name, since both can be set by whoever's uploading it. A renamed program pretending to be a PDF would sail through either check alone.

**How I implemented it.** Three things all have to agree before a file is accepted: the type it claims to be is allowed, its file extension matches that claim, and its actual starting bytes match what that file type should really look like. If any one of these disagrees, the whole upload is rejected, not just the bad file, and nothing partial gets saved. The check reads the real file itself, never trusting a size number the browser reports. Tests cover all three checks separately, including trying to sneak in a program file renamed to look like a PDF.

**What I chose against, and why.** Just trusting whatever type the upload claims to be was the easy option, and it was rejected because anyone can rename a file to fake that.

### Migration Integrity (Verified From an Empty Database)

**What it is.** Proving the full set of database setup steps can actually build things correctly from a totally empty database, not just confirming it matches a database that's already working.

**Why it is needed.** Just because the recorded setup steps match your current database doesn't prove anything about a brand new one. It says nothing about whether someone starting completely fresh, a new teammate, a new server, could actually build the same thing from scratch.

**How I implemented it.** I created a brand new, empty database, replayed every setup step into it in order, and then compared the result against what the code expects:

```bash
npx prisma migrate diff --from-url "$FRESH_DB_URL" \
  --to-schema-datamodel prisma/schema.prisma --exit-code
```

Doing this actually caught a real problem before it ever passed cleanly (see Section 6).

**What I chose against, and why.** Just trusting that the setup steps were "up to date" against the already-working database was the easier option, and it was rejected because that check can't catch something that quietly exists on the live database but was never actually captured in an official setup step.

## Section 6: What Went Wrong

**1. The database-browsing tool showed no briefs after the security rule was switched on.**

- *Symptom*: after turning on the security rule, the browsing tool showed an empty table, even though the data was still there.
- *Investigation*: checked if the rows had actually been deleted (they hadn't), checked the security rule for a typo (it was fine), then checked which login the browsing tool was actually using.
- *Cause*: the app's login owned the table, so an extra setting had been used to force that login to follow the rule too. That meant every connection, including the browsing tool, now had to follow the rule, and since the tool never identified itself, it matched nothing.
- *Fix*: split the single login into two: a restricted one that owns nothing (so it doesn't need that extra forcing setting) for the app, and the original powerful one kept only for the browsing tool and setup work. `20260926030000_briefs_owner_exempt` removes the forcing setting, and `20260926070000_grant_app_role` records the restricted login's permissions properly so rebuilding everything from scratch reproduces them correctly.

**2. The usual database update command offered to wipe real data.**

- *Symptom*: running the normal command to update the database locally warned that it wanted to reset everything.
- *Investigation*: compared the recorded setup steps against what had actually already been done to the real database.
- *Cause*: some earlier changes had been made by hand instead of through the official recorded steps, so the record was out of sync with reality, and the tool couldn't reconcile the difference on its own.
- *Fix*: wrote the missing changes properly as official steps, applied them directly, then told the system "these are already done" so its records matched reality without touching any real data.

**3. Building a brand-new, empty database didn't produce a complete result.**

- *Symptom*: replaying every setup step into a fresh empty database left out two things the code expected to exist: an entire table for keeping an audit trail, and a search shortcut (index) on the briefs table.
- *Investigation*: compared what was missing on the fresh database against the live one, and found the same two things absent from both.
- *Cause*: both had been added directly to the live database by hand at some point, never through an official recorded step, so nothing had ever captured them properly. A truly fresh setup would have quietly ended up with a database the code wasn't actually built for, including breaking anything that tried to write an audit record.
- *Fix*: added one official step that creates both missing pieces safely, in a way that works whether or not they already exist, then re-ran the fresh-database test to confirm everything now builds correctly.

## Section 7: What This Slice Does Not Handle

- **No document processing.** Nothing reads what's actually inside an uploaded file. That's handled by a separate part of the project, not this one.
- **Not built for very large files.** Storing files directly in the database works fine at the current small limits. Going much bigger would need proper dedicated file storage instead; this was left out on purpose, not from a lack of time.
- **Upload speed limiting only works properly if there's one copy of the app running.** The limiter keeping uploads from happening too fast lives in the app's own memory, so if more than one copy of the app ran at once, the actual limit would effectively multiply. This would need fixing before handling real-world scale; it was left this way due to time, not because it didn't matter.
- **Two very old rows still use the older, less random id style.** Changing them now would break any existing links pointing at them, so this was left alone on purpose, not missed by accident. The security rule still protects them the same as everything else.
- **There's an audit-trail table in the database that nothing actually uses yet.** Nothing reads from or writes to it. It only exists because the fresh-database test needed it to exist, not because any feature depends on it.
- **Creating a brief and attaching its first file aren't one single guaranteed step.** If something fails partway between the two, cleanup happens on a best-effort basis rather than being guaranteed.
- **Two comments left in the code are now outdated and contradict this document.** The comment on the `Brief` model in `prisma/schema.prisma`, and the note at the top of `scripts/inspect-briefs.mjs`, both still describe the old forced security setting and the "why Studio looks empty" issue from before it was fixed. Both were true once, but no longer are.

## Section 8: If I Built This Again

The single biggest change would be starting with two separate database logins (a restricted one for the app, a powerful one for setup and admin work) right from the very first setup step, instead of starting with one all-powerful login and fixing the split later after running into the browsing-tool problem. The fix worked fine, but it cost a whole extra round of investigation to find a problem that simply wouldn't have existed with the right setup from day one.

Two smaller things I'd also do differently:

- **Make creating a brief and attaching its first file happen as one guaranteed all-or-nothing step**, instead of the current approach, which cleans up after a failure on a best-effort basis rather than a guarantee. It's the one spot in this slice where something could end up half-done.
- **Set up the app's restricted login through an actual setup script that the instructions point to**, rather than a manual step described only in a comment. Keeping the password out of the codebase was the right call, but the downside is that someone following the setup steps exactly, on a brand new clone, won't be able to connect, and they'll just see a connection error instead of a clear explanation of what to do.