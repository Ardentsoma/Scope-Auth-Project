-- The application now connects as `scope_app`, a role that owns nothing, so the
-- row-level security policies apply to it through ordinary ownership rules and
-- `FORCE` is no longer required.
--
-- `FORCE` previously existed only because the app connected as the table owner,
-- whom Postgres exempts from its own policies. Leaving it on would also drag the
-- owner role under the policies, which is what stopped Prisma Studio (an
-- unscoped connection) from browsing briefs. See DOCUMENTATION.md.
--
-- The policies themselves are unchanged: RLS stays enabled, and only the owner
-- role is exempt.
ALTER TABLE "briefs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brief_assets" NO FORCE ROW LEVEL SECURITY;
