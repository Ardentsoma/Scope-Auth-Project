-- Record the application role's table privileges in the migration history.
--
-- `scope_app` is a cluster-level role: it is created once per Postgres cluster,
-- out-of-band, and is deliberately NOT created here so that no password ever
-- lands in version control. Its table privileges, however, are ordinary schema
-- state and belong in the migration ledger — until now they had been applied by
-- hand, so `prisma migrate deploy` against a fresh database produced tables
-- that the application role could not read at all.
--
-- This does not change the two-role design. It records the privileges that the
-- live database already has, so a fresh replay reproduces it exactly. The role
-- still owns nothing, and the tables are still owned by the admin role, so RLS
-- still applies to the application.
--
-- To create the role on a new cluster, before running `migrate deploy`:
--
--   CREATE ROLE scope_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOBYPASSRLS;
--   GRANT CONNECT ON DATABASE <db> TO scope_app;
--
-- `DATABASE_URL` is that role. Prisma Studio and migrations use the owner role
-- in `ADMIN_DATABASE_URL`.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scope_app') THEN
    RAISE NOTICE
      'role scope_app does not exist on this cluster; skipping its grants. '
      'Create it with: CREATE ROLE scope_app LOGIN PASSWORD ''<generated>'' '
      'NOSUPERUSER NOBYPASSRLS; before pointing DATABASE_URL at it.';
    RETURN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO scope_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO scope_app';

  -- Keep future tables covered, so a migration that adds one does not silently
  -- leave the application unable to use it.
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO scope_app';
END
$do$;
