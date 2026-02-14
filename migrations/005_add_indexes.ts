import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // GIN trigram indexes for fuzzy search on communities
  await sql`CREATE INDEX IF NOT EXISTS idx_communities_handle_trgm ON communities USING gin (handle gin_trgm_ops)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_communities_display_name_trgm ON communities USING gin (display_name gin_trgm_ops)`.execute(db);

  // Unique constraint for community_app_visibility
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_app_visibility_unique ON community_app_visibility (community_did, app_id)`.execute(db);

  // Unique constraint for community_roles
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_roles_unique ON community_roles (community_did, name)`.execute(db);

  // Unique constraint for community_member_roles
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_member_roles_unique ON community_member_roles (community_did, member_did, role_name)`.execute(db);

  // Unique constraint for app_default_permissions
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_default_permissions_unique ON app_default_permissions (app_id, collection)`.execute(db);

  // Unique constraint for community_app_collection_permissions
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_app_collection_perms_unique ON community_app_collection_permissions (community_did, app_id, collection)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_community_app_collection_perms_unique`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_app_default_permissions_unique`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_community_member_roles_unique`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_community_roles_unique`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_community_app_visibility_unique`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_communities_display_name_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_communities_handle_trgm`.execute(db);
}
