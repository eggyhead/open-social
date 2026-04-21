import { Kysely, sql } from 'kysely';

/**
 * Migration: Create the `pending_hierarchy_requests` table.
 *
 * Tracks pending parent/child hierarchy requests so the target community can
 * discover incoming proposals without scanning every community's PDS.
 * Analogous to `pending_members` for membership join requests.
 */

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('pending_hierarchy_requests')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('requester_did', 'varchar', (c) => c.notNull())
    .addColumn('target_did', 'varchar', (c) => c.notNull())
    .addColumn('requester_role', 'varchar', (c) => c.notNull()) // 'parent' | 'child'
    .addColumn('requester_record_rkey', 'varchar', (c) => c.notNull())
    .addColumn('admin_did', 'varchar', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) =>
      c.defaultTo(sql`now()`).notNull(),
    )
    .addUniqueConstraint('uq_pending_hierarchy_requester_target', [
      'requester_did',
      'target_did',
    ])
    .execute();

  await db.schema
    .createIndex('idx_pending_hierarchy_target')
    .on('pending_hierarchy_requests')
    .column('target_did')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('pending_hierarchy_requests').execute();
}
