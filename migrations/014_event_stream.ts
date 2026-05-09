import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Event log for cursor-based stream resumption
  await db.schema
    .createTable('event_log')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('community_did', 'text')
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_event_log_created_at')
    .on('event_log')
    .column('created_at')
    .execute();

  await db.schema
    .createIndex('idx_event_log_community_did')
    .on('event_log')
    .column('community_did')
    .execute();

  await db.schema
    .createIndex('idx_event_log_community_did_id')
    .on('event_log')
    .columns(['community_did', 'id'])
    .execute();

  // Stream tokens for signed URL authentication
  await db.schema
    .createTable('stream_tokens')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('token', 'text', (col) => col.notNull().unique())
    .addColumn('app_id', 'integer', (col) => col.notNull().references('apps.id').onDelete('cascade'))
    .addColumn('community_did', 'text')
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await db.schema
    .createIndex('idx_stream_tokens_token')
    .on('stream_tokens')
    .column('token')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('stream_tokens').execute();
  await db.schema.dropTable('event_log').execute();
}
