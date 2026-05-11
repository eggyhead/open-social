import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Request } from "express";
import type { Database } from "../db";
import type { XrpcHandler } from "./server";
import { XrpcError } from "./server";
import type { AuthenticatedRequest } from "../middleware/auth";
import { createCommunityAgent } from "../services/atproto";
import { createAuditLogService } from "../services/auditLog";
import {
  checkAppVisibility,
  seedCollectionPermissions,
} from "../services/permissions";
import { isAdminInList, normalizeAdmins } from "../lib/adminUtils";
import { encodeCursor, decodeCursor } from "../lib/pagination";
import { logger } from "../lib/logger";
import { logWarning } from "../lib/errors";

export function registerCommunityHandlers(
  handlers: Map<string, XrpcHandler>,
  db: Kysely<Database>,
) {
  const auditLog = createAuditLogService(db);

  handlers.set("community.opensocial.getCommunity", {
    type: "query",
    handler: async (params, req) => {
      const communityDid = params.did as string;
      const userDid = params.userDid as string | undefined;

      if (!communityDid) {
        throw new XrpcError(400, "InvalidRequest", "did is required");
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();

      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      const appId = (req as AuthenticatedRequest).app_data?.app_id;
      if (appId) {
        const visibility = await checkAppVisibility(db, community.did, appId);
        if (!visibility.allowed) {
          throw new XrpcError(403, "PermissionDenied", visibility.reason);
        }
      }

      let profile: any = {};
      let admins: any[] = [];
      let isAdmin = false;
      let memberCount = 0;

      try {
        const agent = await createCommunityAgent(db, communityDid);

        try {
          const profileRes = await agent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.profile",
            rkey: "self",
          });
          profile = profileRes.data.value as any;
        } catch (e) {
          logWarning("Failed to fetch community profile", {
            error: e,
            communityDid,
          });
        }

        try {
          const adminsRes = await agent.api.com.atproto.repo.getRecord({
            repo: communityDid,
            collection: "community.opensocial.admins",
            rkey: "self",
          });
          admins = (adminsRes.data.value as any)?.admins || [];
          if (userDid) {
            isAdmin = isAdminInList(userDid, admins);
          }
        } catch (e) {
          logWarning("Failed to fetch community admins", {
            error: e,
            communityDid,
            userDid,
          });
        }

        try {
          let count = 0;
          let memberCursor: string | undefined;
          do {
            const membersRes = await agent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              limit: 100,
              cursor: memberCursor,
            });
            count += membersRes.data.records.length;
            memberCursor = membersRes.data.cursor;
          } while (memberCursor);
          memberCount = count;
        } catch (e) {
          logWarning("Failed to count community members", {
            error: e,
            communityDid,
          });
        }
      } catch (e) {
        logWarning("Failed to create community agent", {
          error: e,
          communityDid,
        });
      }

      return {
        community: {
          did: community.did,
          handle: community.handle,
          displayName: profile.displayName || community.display_name,
          description: profile.description || "",
          guidelines: profile.guidelines || "",
          type: profile.type || "open",
          avatar: profile.avatar || null,
          banner: profile.banner || null,
          admins: normalizeAdmins(admins).map((a) => a.did),
          createdAt: community.created_at,
          memberCount,
        },
        isAdmin,
      };
    },
  });

  handlers.set("community.opensocial.searchCommunities", {
    type: "query",
    handler: async (params, req) => {
      const query = params.query as string | undefined;
      const userDid = params.userDid as string | undefined;
      const limit = params.limit ? parseInt(params.limit as string, 10) : 25;
      const cursor = params.cursor as string | undefined;
      const offset = cursor ? decodeCursor(cursor) : 0;

      const trimmedQuery = query?.trim();
      if (trimmedQuery && trimmedQuery.length > 0 && trimmedQuery.length < 3) {
        throw new XrpcError(
          400,
          "QueryTooShort",
          "Search query must be at least 3 characters",
        );
      }

      let dbQuery = db.selectFrom("communities").selectAll();

      if (trimmedQuery && trimmedQuery.length >= 3) {
        dbQuery = dbQuery.where((eb) =>
          eb.or([
            eb(sql`similarity(handle, ${trimmedQuery})`, ">", sql`0.15`),
            eb(sql`similarity(display_name, ${trimmedQuery})`, ">", sql`0.15`),
            sql<boolean>`handle ILIKE ${"%" + trimmedQuery + "%"}`,
            sql<boolean>`display_name ILIKE ${"%" + trimmedQuery + "%"}`,
          ]),
        );
      }

      const allCommunities = await dbQuery
        .orderBy(
          trimmedQuery && trimmedQuery.length >= 3
            ? sql`GREATEST(similarity(handle, ${trimmedQuery}), similarity(display_name, ${trimmedQuery}))`
            : sql`COALESCE(member_count, 0)`,
          "desc",
        )
        .offset(offset)
        .limit(limit + 1)
        .execute();

      const hasMore = allCommunities.length > limit;
      const page = hasMore ? allCommunities.slice(0, limit) : allCommunities;

      const appId = (req as AuthenticatedRequest).app_data?.app_id;
      const enrichedUnfiltered = await Promise.all(
        page.map(async (community) => {
          if (appId) {
            const visibility = await checkAppVisibility(
              db,
              community.did,
              appId,
            );
            if (!visibility.allowed) return null;
          }

          let isAdmin = false;
          let type = "open";
          let memberCount = community.member_count || 0;

          try {
            const agent = await createCommunityAgent(db, community.did);

            try {
              const profileRes = await agent.api.com.atproto.repo.getRecord({
                repo: community.did,
                collection: "community.opensocial.profile",
                rkey: "self",
              });
              type = (profileRes.data.value as any)?.type || "open";
            } catch (e) {
              logWarning("Failed to fetch community profile", {
                error: e,
                communityDid: community.did,
              });
            }

            if (userDid) {
              try {
                const adminsRes = await agent.api.com.atproto.repo.getRecord({
                  repo: community.did,
                  collection: "community.opensocial.admins",
                  rkey: "self",
                });
                const admins = (adminsRes.data.value as any)?.admins || [];
                isAdmin = isAdminInList(userDid, admins);
              } catch (e) {
                logWarning("Failed to fetch community admins", {
                  error: e,
                  communityDid: community.did,
                });
              }
            }
          } catch (e) {
            logWarning("Failed to create community agent for enrichment", {
              error: e,
              communityDid: community.did,
            });
          }

          return {
            did: community.did,
            handle: community.handle,
            displayName: community.display_name,
            type,
            isAdmin,
            memberCount,
            createdAt:
              community.created_at instanceof Date
                ? community.created_at.toISOString()
                : community.created_at,
          };
        }),
      );

      const communities = enrichedUnfiltered.filter(Boolean);

      return {
        communities,
        cursor: hasMore ? encodeCursor(offset + limit) : undefined,
      };
    },
  });

  handlers.set("community.opensocial.getPermissions", {
    type: "query",
    handler: async (params, req) => {
      const communityDid = params.communityDid as string;
      const userDid = params.userDid as string | undefined;

      if (!communityDid) {
        throw new XrpcError(400, "InvalidRequest", "communityDid is required");
      }

      const appId = (req as AuthenticatedRequest).app_data?.app_id;
      if (!appId) {
        throw new XrpcError(
          401,
          "InvalidRequest",
          "App identification required",
        );
      }

      const visibility = await checkAppVisibility(db, communityDid, appId);
      if (!visibility.allowed) {
        throw new XrpcError(403, "PermissionDenied", visibility.reason);
      }

      // Collection permissions
      let permRows = await db
        .selectFrom("community_app_collection_permissions")
        .selectAll()
        .where("community_did", "=", communityDid)
        .where("app_id", "=", appId)
        .orderBy("collection", "asc")
        .execute();

      let permissions;
      if (permRows.length > 0) {
        permissions = permRows.map((r) => ({
          collection: r.collection,
          canCreate: r.can_create,
          canRead: r.can_read,
          canUpdate: r.can_update,
          canDelete: r.can_delete,
        }));
      } else {
        const defaultRows = await db
          .selectFrom("app_default_permissions")
          .selectAll()
          .where("app_id", "=", appId)
          .orderBy("collection", "asc")
          .execute();

        permissions = defaultRows.map((r) => ({
          collection: r.collection,
          canCreate: r.default_can_create,
          canRead: r.default_can_read,
          canUpdate: r.default_can_update,
          canDelete: r.default_can_delete,
        }));
      }

      // User roles
      let userRoles: string[] = [];
      if (userDid) {
        try {
          const agent = await createCommunityAgent(db, communityDid);

          let isMember = false;
          let cursor: string | undefined;
          do {
            const membersRes = await agent.api.com.atproto.repo.listRecords({
              repo: communityDid,
              collection: "community.opensocial.membershipProof",
              limit: 100,
              cursor,
            });
            isMember = membersRes.data.records.some(
              (r: any) => r.value.memberDid === userDid,
            );
            cursor = membersRes.data.cursor;
          } while (cursor && !isMember);

          if (isMember) userRoles.push("member");

          try {
            const adminsRes = await agent.api.com.atproto.repo.getRecord({
              repo: communityDid,
              collection: "community.opensocial.admins",
              rkey: "self",
            });
            const admins = (adminsRes.data.value as any)?.admins || [];
            if (isAdminInList(userDid, admins)) {
              userRoles.push("admin");
            }
          } catch (e) {
            logWarning("Failed to check admin status", {
              error: e,
              communityDid,
              userDid,
            });
          }
        } catch (e) {
          logger.warn(
            { error: e, communityDid, userDid },
            "Failed to resolve user roles from PDS",
          );
        }

        const customRoles = await db
          .selectFrom("community_member_roles")
          .select("role_name")
          .where("community_did", "=", communityDid)
          .where("member_did", "=", userDid)
          .execute();
        for (const r of customRoles) {
          if (!userRoles.includes(r.role_name)) {
            userRoles.push(r.role_name);
          }
        }
      }

      return { permissions, userRoles };
    },
  });

  handlers.set("community.opensocial.deleteCommunity", {
    type: "procedure",
    handler: async (input, req) => {
      const { communityDid, adminDid } = input;
      if (!communityDid || !adminDid) {
        throw new XrpcError(
          400,
          "InvalidInput",
          "communityDid and adminDid are required",
        );
      }

      const community = await db
        .selectFrom("communities")
        .selectAll()
        .where("did", "=", communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, "CommunityNotFound", "Community not found");
      }

      try {
        const agent = await createCommunityAgent(db, communityDid);
        const adminsRes = await agent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: "community.opensocial.admins",
          rkey: "self",
        });
        const admins = (adminsRes.data.value as any)?.admins || [];
        if (!isAdminInList(adminDid, admins)) {
          throw new XrpcError(
            403,
            "PermissionDenied",
            "Not an admin of this community",
          );
        }
        if (normalizeAdmins(admins).length > 1) {
          throw new XrpcError(
            400,
            "MultipleAdmins",
            "Community must have only one admin to be deleted. Remove other admins first.",
          );
        }
      } catch (e) {
        if (e instanceof XrpcError) throw e;
        throw new XrpcError(
          500,
          "InternalServerError",
          "Failed to verify admin status",
        );
      }

      await db
        .deleteFrom("communities")
        .where("did", "=", communityDid)
        .execute();
      await db
        .deleteFrom("pending_members")
        .where("community_did", "=", communityDid)
        .execute();
      await db
        .deleteFrom("community_settings")
        .where("community_did", "=", communityDid)
        .execute();
      await db
        .deleteFrom("community_app_visibility")
        .where("community_did", "=", communityDid)
        .execute();
      await db
        .deleteFrom("community_app_collection_permissions")
        .where("community_did", "=", communityDid)
        .execute();
      await db
        .deleteFrom("community_roles")
        .where("community_did", "=", communityDid)
        .execute();
      await db
        .deleteFrom("community_member_roles")
        .where("community_did", "=", communityDid)
        .execute();

      await auditLog.log({
        communityDid,
        adminDid,
        action: "community.deleted",
      });

      return {};
    },
  });
}
