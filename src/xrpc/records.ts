import type { Kysely } from 'kysely';
import type { Request } from 'express';
import type { Database } from '../db';
import type { XrpcHandler } from './server';
import { XrpcError } from './server';
import type { AuthenticatedRequest } from '../middleware/auth';
import { createCommunityAgent } from '../services/atproto';
import { createWebhookService } from '../services/webhook';
import {
  checkAppVisibility,
  getRequiredRole,
  getUserRoles,
  satisfiesRole,
  type Operation,
} from '../services/permissions';
import { logger } from '../lib/logger';

/**
 * Shared helper: verify app visibility, resolve user roles, and check
 * collection-level permission for the given operation.
 */
async function enforcePermission(
  req: Request,
  db: Kysely<Database>,
  communityDid: string,
  userDid: string,
  collection: string,
  operation: Operation,
) {
  const appId = (req as AuthenticatedRequest).app_data?.app_id;
  if (!appId) {
    throw new XrpcError(401, 'PermissionDenied', 'App identification missing');
  }

  const visibility = await checkAppVisibility(db, communityDid, appId);
  if (!visibility.allowed) {
    throw new XrpcError(403, 'PermissionDenied', visibility.reason);
  }

  const community = await db
    .selectFrom('communities')
    .selectAll()
    .where('did', '=', communityDid)
    .executeTakeFirst();
  if (!community) {
    throw new XrpcError(404, 'CommunityNotFound', 'Community not found');
  }

  const communityAgent = await createCommunityAgent(db, communityDid);

  const requiredRole = await getRequiredRole(db, communityDid, appId, collection, operation);
  let effectiveRequiredRole: string = requiredRole ?? '';
  if (!effectiveRequiredRole) {
    const col = `default_can_${operation}` as const;
    const appDefault = await db
      .selectFrom('app_default_permissions')
      .select(col as any)
      .where('app_id', '=', appId)
      .where('collection', '=', collection)
      .executeTakeFirst();
    effectiveRequiredRole = appDefault ? (appDefault as any)[col] : 'member';
  }

  const userRoles = await getUserRoles(db, communityDid, userDid, communityAgent);
  if (userRoles.length === 0) {
    throw new XrpcError(403, 'PermissionDenied', 'User is not a member of this community');
  }
  if (!satisfiesRole(userRoles, effectiveRequiredRole)) {
    throw new XrpcError(403, 'PermissionDenied', `Insufficient permissions. Required role: ${effectiveRequiredRole}`);
  }

  return { communityAgent, userRoles };
}

export function registerRecordHandlers(handlers: Map<string, XrpcHandler>, db: Kysely<Database>) {
  const webhooks = createWebhookService(db);

  handlers.set('community.opensocial.createRecord', {
    type: 'procedure',
    handler: async (input, req) => {
      const { communityDid, userDid, collection, record, rkey } = input;
      if (!communityDid || !userDid || !collection || !record) {
        throw new XrpcError(400, 'InvalidInput', 'communityDid, userDid, collection, and record are required');
      }

      const { communityAgent } = await enforcePermission(req, db, communityDid, userDid, collection, 'create');

      const response = await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection,
        rkey,
        record: { $type: collection, ...record },
      });

      await webhooks.dispatch('record.created', communityDid, {
        communityDid, collection, uri: response.data.uri, userDid,
      });

      return { uri: response.data.uri, cid: response.data.cid };
    },
  });

  handlers.set('community.opensocial.putRecord', {
    type: 'procedure',
    handler: async (input, req) => {
      const { communityDid, userDid, collection, rkey, record } = input;
      if (!communityDid || !userDid || !collection || !rkey || !record) {
        throw new XrpcError(400, 'InvalidInput', 'communityDid, userDid, collection, rkey, and record are required');
      }

      const { communityAgent } = await enforcePermission(req, db, communityDid, userDid, collection, 'update');

      const response = await communityAgent.api.com.atproto.repo.putRecord({
        repo: communityDid,
        collection,
        rkey,
        record: { $type: collection, ...record },
      });

      await webhooks.dispatch('record.updated', communityDid, {
        communityDid, collection, rkey, uri: response.data.uri, userDid,
      });

      return { uri: response.data.uri, cid: response.data.cid };
    },
  });

  handlers.set('community.opensocial.deleteRecord', {
    type: 'procedure',
    handler: async (input, req) => {
      const { communityDid, userDid, collection, rkey } = input;
      if (!communityDid || !userDid || !collection || !rkey) {
        throw new XrpcError(400, 'InvalidInput', 'communityDid, userDid, collection, and rkey are required');
      }

      const { communityAgent } = await enforcePermission(req, db, communityDid, userDid, collection, 'delete');

      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid, collection, rkey,
      });

      await webhooks.dispatch('record.deleted', communityDid, {
        communityDid, collection, rkey, userDid,
      });

      return {};
    },
  });

  handlers.set('community.opensocial.listRecords', {
    type: 'query',
    handler: async (params, req) => {
      const { communityDid, collection, userDid } = params;
      const limit = params.limit ? parseInt(params.limit as string, 10) : 50;
      const cursor = params.cursor as string | undefined;

      if (!communityDid || !collection) {
        throw new XrpcError(400, 'InvalidInput', 'communityDid and collection are required');
      }

      const appId = (req as AuthenticatedRequest).app_data?.app_id;
      if (appId) {
        const visibility = await checkAppVisibility(db, communityDid, appId);
        if (!visibility.allowed) {
          throw new XrpcError(403, 'PermissionDenied', visibility.reason);
        }
      }

      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, 'CommunityNotFound', 'Community not found');
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      if (userDid && appId) {
        const requiredRole = await getRequiredRole(db, communityDid, appId, collection, 'read');
        if (requiredRole) {
          const userRoles = await getUserRoles(db, communityDid, userDid, communityAgent);
          if (!satisfiesRole(userRoles, requiredRole)) {
            throw new XrpcError(403, 'PermissionDenied', `Insufficient permissions to read this collection. Required role: ${requiredRole}`);
          }
        }
      }

      const response = await communityAgent.api.com.atproto.repo.listRecords({
        repo: communityDid, collection, limit, cursor,
      });

      return {
        records: response.data.records,
        cursor: response.data.cursor || undefined,
      };
    },
  });

  handlers.set('community.opensocial.getRecord', {
    type: 'query',
    handler: async (params, req) => {
      const { communityDid, collection, rkey, userDid } = params;

      if (!communityDid || !collection || !rkey) {
        throw new XrpcError(400, 'InvalidInput', 'communityDid, collection, and rkey are required');
      }

      const appId = (req as AuthenticatedRequest).app_data?.app_id;
      if (appId) {
        const visibility = await checkAppVisibility(db, communityDid, appId);
        if (!visibility.allowed) {
          throw new XrpcError(403, 'PermissionDenied', visibility.reason);
        }
      }

      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();
      if (!community) {
        throw new XrpcError(404, 'CommunityNotFound', 'Community not found');
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      if (userDid && appId) {
        const requiredRole = await getRequiredRole(db, communityDid, appId, collection, 'read');
        if (requiredRole) {
          const userRoles = await getUserRoles(db, communityDid, userDid, communityAgent);
          if (!satisfiesRole(userRoles, requiredRole)) {
            throw new XrpcError(403, 'PermissionDenied', `Insufficient permissions to read this collection. Required role: ${requiredRole}`);
          }
        }
      }

      const response = await communityAgent.api.com.atproto.repo.getRecord({
        repo: communityDid, collection, rkey,
      });

      return {
        uri: response.data.uri,
        cid: response.data.cid,
        value: response.data.value,
      };
    },
  });
}
