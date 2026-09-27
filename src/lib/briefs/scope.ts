import "server-only";

import { ensureAppDatabaseRole, prisma } from "@/lib/prisma";

/**
 * Postgres session variable the `briefs_owner_isolation` RLS policy reads.
 * Must match the name used in
 * prisma/migrations/20260926000000_briefs_rls/migration.sql.
 */
export const RLS_USER_SETTING = "app.current_user_id";

/**
 * The transaction client type handed to a {@link withBriefScope} callback.
 * Every brief query runs on this, so it is always inside a transaction that has
 * the RLS session variable set.
 */
export type BriefScopedClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

/**
 * Runs `fn` inside a transaction whose Postgres session carries
 * `app.current_user_id = userId`, which is what the RLS policy on `briefs`
 * filters rows by.
 *
 * Why this exists rather than a bare `prisma.brief.findMany({ where: { userId } })`:
 * the application-layer filter is the first line of defence, but a future query
 * that forgets it would then silently read another user's rows. Running inside
 * this scope means the database refuses to hand back rows belonging to anyone
 * else even if a filter is omitted.
 *
 * `set_config(..., is_local => true)` scopes the setting to this transaction
 * only, so it is discarded on commit or rollback and can never bleed into an
 * unrelated request that happens to reuse the pooled connection. That also
 * means a crash mid-transaction cannot leave a stale user id behind: the next
 * transaction starts with the variable unset, which the policy treats as
 * "see nothing".
 *
 * Every brief read and write in the application goes through here. There is no
 * unscoped escape hatch — see src/lib/briefs/service.ts.
 */
export async function withBriefScope<T>(
  userId: string,
  fn: (tx: BriefScopedClient) => Promise<T>
): Promise<T> {
  // Refuse to touch the database at all unless the connection is the non-owner
  // role. If this is ever a privileged connection the policy on `briefs` is not
  // being enforced, and the failure would otherwise be silent.
  await ensureAppDatabaseRole();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${RLS_USER_SETTING}, ${userId}, true)`;
    return fn(tx);
  });
}
