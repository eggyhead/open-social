import { Kysely, sql } from 'kysely';

/**
 * Migration: Seed default permissions for the new split shared content
 * collections: `community.opensocial.sharedDocument` and
 * `community.opensocial.sharedEvent`.
 *
 * Uses the same permission model as the original `sharedContent` collection
 * (members can create/read, admins can update/delete).
 */

const SYSTEM_APP_ID = 'app_system';
const SHARED_DOCUMENT_COLLECTION = 'community.opensocial.sharedDocument';
const SHARED_EVENT_COLLECTION = 'community.opensocial.sharedEvent';

const NEW_COLLECTIONS = [SHARED_DOCUMENT_COLLECTION, SHARED_EVENT_COLLECTION];

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Seed default permissions for both new collections
  for (const collection of NEW_COLLECTIONS) {
    await db
      .insertInto('app_default_permissions')
      .values({
        app_id: SYSTEM_APP_ID,
        collection,
        default_can_create: 'member',
        default_can_read: 'member',
        default_can_update: 'admin',
        default_can_delete: 'admin',
      })
      .onConflict((oc) => oc.columns(['app_id', 'collection']).doNothing())
      .execute();
  }

  // 2. Seed per-community permissions for all existing communities
  const communities = await db
    .selectFrom('communities')
    .select('did')
    .execute();

  for (const community of communities) {
    for (const collection of NEW_COLLECTIONS) {
      await db
        .insertInto('community_app_collection_permissions')
        .values({
          community_did: community.did,
          app_id: SYSTEM_APP_ID,
          collection,
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
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const collection of NEW_COLLECTIONS) {
    await db
      .deleteFrom('community_app_collection_permissions')
      .where('app_id', '=', SYSTEM_APP_ID)
      .where('collection', '=', collection)
      .execute();

    await db
      .deleteFrom('app_default_permissions')
      .where('app_id', '=', SYSTEM_APP_ID)
      .where('collection', '=', collection)
      .execute();
  }
}
