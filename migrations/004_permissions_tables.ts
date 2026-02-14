import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Create community_settings table
  await db.schema
    .createTable('community_settings')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('community_did', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('app_visibility_default', 'varchar(50)', (col) => col.notNull().defaultTo('open'))
    .addColumn('blocked_app_ids', 'text', (col) => col.notNull().defaultTo('[]'))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Create community_app_visibility table
  await db.schema
    .createTable('community_app_visibility')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('community_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('app_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(50)', (col) => col.notNull().defaultTo('enabled'))
    .addColumn('requested_by', 'varchar(255)')
    .addColumn('reviewed_by', 'varchar(255)')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Create community_roles table
  await db.schema
    .createTable('community_roles')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('community_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(100)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('visible', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('can_view_audit_log', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Create community_member_roles table
  await db.schema
    .createTable('community_member_roles')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('community_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('member_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('role_name', 'varchar(100)', (col) => col.notNull())
    .addColumn('assigned_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Create app_default_permissions table
  await db.schema
    .createTable('app_default_permissions')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('app_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('collection', 'varchar(255)', (col) => col.notNull())
    .addColumn('default_can_create', 'varchar(100)', (col) => col.notNull().defaultTo('member'))
    .addColumn('default_can_read', 'varchar(100)', (col) => col.notNull().defaultTo('member'))
    .addColumn('default_can_update', 'varchar(100)', (col) => col.notNull().defaultTo('member'))
    .addColumn('default_can_delete', 'varchar(100)', (col) => col.notNull().defaultTo('admin'))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Create community_app_collection_permissions table
  await db.schema
    .createTable('community_app_collection_permissions')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('community_did', 'varchar(255)', (col) => col.notNull())
    .addColumn('app_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('collection', 'varchar(255)', (col) => col.notNull())
    .addColumn('can_create', 'varchar(100)', (col) => col.notNull().defaultTo('member'))
    .addColumn('can_read', 'varchar(100)', (col) => col.notNull().defaultTo('member'))
    .addColumn('can_update', 'varchar(100)', (col) => col.notNull().defaultTo('member'))
    .addColumn('can_delete', 'varchar(100)', (col) => col.notNull().defaultTo('admin'))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('community_app_collection_permissions').ifExists().execute();
  await db.schema.dropTable('app_default_permissions').ifExists().execute();
  await db.schema.dropTable('community_member_roles').ifExists().execute();
  await db.schema.dropTable('community_roles').ifExists().execute();
  await db.schema.dropTable('community_app_visibility').ifExists().execute();
  await db.schema.dropTable('community_settings').ifExists().execute();
}
