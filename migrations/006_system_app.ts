import { Kysely, sql } from 'kysely';

/**
 * Migration: Introduce the "System App" for platform-native collections.
 *
 * The system app (app_id = 'app_system') owns the `community.opensocial.*`
 * collection namespace.  Its domain 'opensocial.community' reverses to
 * 'community.opensocial.' which satisfies the existing domain-prefix
 * validation without code changes.
 *
 * This migration:
 * 1. Inserts the system app into the `apps` table.
 * 2. Seeds default permissions for `community.opensocial.sharedContent`.
 * 3. Enables the system app for every existing community and copies
 *    default permissions into each community's permission table.
 */

const SYSTEM_APP_ID = 'app_system';
const SYSTEM_APP_DOMAIN = 'opensocial.community';
const SHARED_CONTENT_COLLECTION = 'community.opensocial.sharedContent';

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Insert system app (api_key is a sentinel — never used for authentication)
  await db
    .insertInto('apps')
    .values({
      app_id: SYSTEM_APP_ID,
      name: 'Open Social',
      domain: SYSTEM_APP_DOMAIN,
      creator_did: 'system',
      api_key: 'SYSTEM_APP_NO_KEY',
      status: 'active',
      created_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .onConflict((oc) => oc.column('app_id').doNothing())
    .execute();

  // 2. Seed default permissions for sharedContent collection
  await db
    .insertInto('app_default_permissions')
    .values({
      app_id: SYSTEM_APP_ID,
      collection: SHARED_CONTENT_COLLECTION,
      default_can_create: 'member',
      default_can_read: 'member',
      default_can_update: 'admin',
      default_can_delete: 'admin',
    })
    .onConflict((oc) => oc.columns(['app_id', 'collection']).doNothing())
    .execute();

  // 3. Enable system app for all existing communities and seed permissions
  const communities = await db
    .selectFrom('communities')
    .select('did')
    .execute();

  for (const community of communities) {
    // Enable app visibility
    await db
      .insertInto('community_app_visibility')
      .values({
        community_did: community.did,
        app_id: SYSTEM_APP_ID,
        status: 'enabled',
        created_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .onConflict((oc) => oc.columns(['community_did', 'app_id']).doNothing())
      .execute();

    // Seed collection permissions from defaults
    await db
      .insertInto('community_app_collection_permissions')
      .values({
        community_did: community.did,
        app_id: SYSTEM_APP_ID,
        collection: SHARED_CONTENT_COLLECTION,
        can_create: 'member',
        can_read: 'member',
        can_update: 'admin',
        can_delete: 'admin',
      })
      .onConflict((oc) =>
        oc.columns(['community_did', 'app_id', 'collection']).doNothing(),
      )
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Remove seeded permissions for all communities
  await db
    .deleteFrom('community_app_collection_permissions')
    .where('app_id', '=', SYSTEM_APP_ID)
    .where('collection', '=', SHARED_CONTENT_COLLECTION)
    .execute();

  // Remove system app visibility for all communities
  await db
    .deleteFrom('community_app_visibility')
    .where('app_id', '=', SYSTEM_APP_ID)
    .execute();

  // Remove default permissions
  await db
    .deleteFrom('app_default_permissions')
    .where('app_id', '=', SYSTEM_APP_ID)
    .execute();

  // Remove system app
  await db
    .deleteFrom('apps')
    .where('app_id', '=', SYSTEM_APP_ID)
    .execute();
}
