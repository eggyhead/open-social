import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Create OAuth tables
  await db.schema
    .createTable('auth_state')
    .ifNotExists()
    .addColumn('key', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('state', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('auth_session')
    .ifNotExists()
    .addColumn('key', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('session', 'text', (col) => col.notNull())
    .execute();

  // Create apps table
  await db.schema
    .createTable('apps')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('app_id', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('domain', 'varchar(255)', (col) => col.notNull())
    .addColumn('creator_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('api_key', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('status', 'varchar(50)', (col) => col.notNull().defaultTo('active'))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('apps').ifExists().execute();
  await db.schema.dropTable('auth_session').ifExists().execute();
  await db.schema.dropTable('auth_state').ifExists().execute();
}
