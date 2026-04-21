import { Kysely, sql } from 'kysely';

/**
 * Migration: Seed permissions for the `community.opensocial.hierarchy` collection.
 *
 * Hierarchy records are admin-only — only community admins should be able to
 * create, update, or delete them.  Reads are public (member-level).
 *
 * This migration:
 * 1. Adds default permissions for the hierarchy collection under the system app.
 * 2. Seeds per-community permissions for every existing community.
 */

const SYSTEM_APP_ID = 'app_system';
const HIERARCHY_COLLECTION = 'community.opensocial.hierarchy';

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Seed default permissions for hierarchy collection
  await db
    .insertInto('app_default_permissions')
    .values({
      app_id: SYSTEM_APP_ID,
      collection: HIERARCHY_COLLECTION,
      default_can_create: 'admin',
      default_can_read: 'member',
      default_can_update: 'admin',
      default_can_delete: 'admin',
    })
    .onConflict((oc) => oc.columns(['app_id', 'collection']).doNothing())
    .execute();

  // 2. Seed per-community permissions for all existing communities
  const communities = await db
    .selectFrom('communities')
    .select('did')
    .execute();

  for (const community of communities) {
    await db
      .insertInto('community_app_collection_permissions')
      .values({
        community_did: community.did,
        app_id: SYSTEM_APP_ID,
        collection: HIERARCHY_COLLECTION,
        can_create: 'admin',
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
    .where('collection', '=', HIERARCHY_COLLECTION)
    .execute();

  // Remove default permissions
  await db
    .deleteFrom('app_default_permissions')
    .where('app_id', '=', SYSTEM_APP_ID)
    .where('collection', '=', HIERARCHY_COLLECTION)
    .execute();
}
