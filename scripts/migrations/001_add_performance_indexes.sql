-- Performance optimization indexes
-- Created: 2026-02-14
-- Purpose: Add indexes for common query patterns to improve performance

-- Index for audit log queries (by community and timestamp)
CREATE INDEX IF NOT EXISTS idx_audit_log_community_created
  ON audit_log(community_did, created_at DESC);

-- Index for audit log queries by admin
CREATE INDEX IF NOT EXISTS idx_audit_log_admin
  ON audit_log(admin_did, created_at DESC);

-- Index for pending members queries
CREATE INDEX IF NOT EXISTS idx_pending_members_community_status
  ON pending_members(community_did, status, created_at DESC);

-- Index for community member roles lookup
CREATE INDEX IF NOT EXISTS idx_community_member_roles_lookup
  ON community_member_roles(community_did, member_did);

-- Index for role name lookup (for permissions checks)
CREATE INDEX IF NOT EXISTS idx_community_member_roles_name
  ON community_member_roles(community_did, role_name);

-- Index for community search by handle (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_communities_handle_lower
  ON communities(LOWER(handle));

-- Index for community search by display name (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_communities_display_name_lower
  ON communities(LOWER(display_name));

-- Trigram indexes for fuzzy search (requires pg_trgm extension)
-- These significantly improve ILIKE and similarity() query performance
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_communities_handle_trgm
  ON communities USING gin(handle gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_communities_display_name_trgm
  ON communities USING gin(display_name gin_trgm_ops);

-- Index for community app visibility lookups
CREATE INDEX IF NOT EXISTS idx_community_app_visibility_lookup
  ON community_app_visibility(community_did, app_id, status);

-- Index for community settings lookup
CREATE INDEX IF NOT EXISTS idx_community_settings_community
  ON community_settings(community_did);

-- Index for app collection permissions lookup
CREATE INDEX IF NOT EXISTS idx_community_app_collection_perms
  ON community_app_collection_permissions(community_did, app_id, collection);

-- Index for webhook queries by app and community
CREATE INDEX IF NOT EXISTS idx_webhooks_app_community
  ON webhooks(app_id, community_did, active);
