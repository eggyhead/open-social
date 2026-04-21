import { Kysely, sql } from 'kysely';

/**
 * Migration: persistent cache for resolved DID documents.
 *
 * Implements the storage layer for `PostgresDidCache`, which satisfies the
 * `DidCache` interface from `@atproto/identity`. Caching DID documents in the
 * database avoids the ~3 second PLC directory round-trip on every login.
 *
 *   - `did`         primary key, the DID being cached
 *   - `doc`         JSONB body of the DID document
 *   - `updated_at`  when the entry was (re)written, used for stale checks
 *   - `expires_at`  hard expiry; rows past this are pruned by the cleanup job
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('did_cache')
    .ifNotExists()
    .addColumn('did', 'text', (col) => col.primaryKey())
    .addColumn('doc', 'jsonb', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .execute();

  await sql`CREATE INDEX IF NOT EXISTS idx_did_cache_expires ON did_cache(expires_at)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_did_cache_expires`.execute(db);
  await db.schema.dropTable('did_cache').ifExists().execute();
}
