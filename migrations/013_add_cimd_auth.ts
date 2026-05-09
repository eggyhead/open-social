import { Kysely, sql } from 'kysely';

/**
 * Migration: Add CIMD (Client ID Metadata Document) support to the apps table.
 *
 * - `auth_method`: which auth method the app uses ('api_key', 'http_signature', or 'both')
 * - `cimd_url`: optional URL to the app's CIMD or did:web document
 *
 * Existing apps default to 'api_key' auth_method.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('apps')
    .addColumn('auth_method', 'varchar(20)', (col) => col.defaultTo('api_key').notNull())
    .execute();

  await db.schema
    .alterTable('apps')
    .addColumn('cimd_url', 'varchar(500)')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('apps').dropColumn('cimd_url').execute();
  await db.schema.alterTable('apps').dropColumn('auth_method').execute();
}
