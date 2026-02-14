import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Create communities table with all columns including cached metadata
  await db.schema
    .createTable('communities')
    .ifNotExists()
    .addColumn('did', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('handle', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull().defaultTo(''))
    .addColumn('pds_host', 'varchar(255)', (col) => col.notNull())
    .addColumn('app_password', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    // Cached metadata columns for community search results
    .addColumn('description', 'text')
    .addColumn('avatar_url', 'text')
    .addColumn('community_type', 'varchar(50)')
    .addColumn('member_count', 'integer')
    .addColumn('metadata_fetched_at', 'timestamp')
    .execute();

  // Enable pg_trgm extension for trigram search
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('communities').ifExists().execute();
  // Note: We don't drop the pg_trgm extension as it might be used by other applications
}
