import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Create rate_limits table
  await db.schema
    .createTable('rate_limits')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('app_id', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('max_requests', 'integer', (col) => col.notNull().defaultTo(100))
    .addColumn('window_ms', 'integer', (col) => col.notNull().defaultTo(60000))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Create webhooks table
  await db.schema
    .createTable('webhooks')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('app_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('url', 'text', (col) => col.notNull())
    .addColumn('events', 'text', (col) => col.notNull()) // JSON array
    .addColumn('secret', 'varchar(255)')
    .addColumn('community_did', 'varchar(255)')
    .addColumn('active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Create audit_log table
  await db.schema
    .createTable('audit_log')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('community_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('admin_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('action', 'varchar(100)', (col) => col.notNull())
    .addColumn('target_did', 'varchar(255)')
    .addColumn('reason', 'text')
    .addColumn('metadata', 'text') // JSON
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Create pending_members table
  await db.schema
    .createTable('pending_members')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('community_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('user_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(50)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('reason', 'text')
    .addColumn('reviewed_by', 'varchar(255)')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('pending_members').ifExists().execute();
  await db.schema.dropTable('audit_log').ifExists().execute();
  await db.schema.dropTable('webhooks').ifExists().execute();
  await db.schema.dropTable('rate_limits').ifExists().execute();
}
