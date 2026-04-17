import { Agent } from '@atproto/api';
import { Router, type Request, type Response } from 'express';
import { getIronSession } from 'iron-session';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodeOAuthClient } from '@atproto/oauth-client-node';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { config } from '../config';
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
import { z } from 'zod';

type Session = { did?: string };

const sessionOptions = {
  cookieName: 'sid',
  password: config.cookieSecret,
  cookieOptions: {
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    httpOnly: true,
    path: '/',
  },
};

async function getSessionAgent(
  req: IncomingMessage,
  res: ServerResponse,
  oauthClient: NodeOAuthClient
) {
  res.setHeader('Vary', 'Cookie');
  const session = await getIronSession<Session>(req, res, sessionOptions);
  if (!session.did) return null;
  try {
    const oauthSession = await oauthClient.restore(session.did);
    return oauthSession ? new Agent(oauthSession) : null;
  } catch (err) {
    logger.warn({ error: err }, 'OAuth restore failed');
    await session.destroy();
    return null;
  }
}

const SYSTEM_APP_ID = 'app_system';
const SHARED_CONTENT_COLLECTION = 'community.opensocial.sharedContent';

// Validation schemas
const shareContentSchema = z.object({
  type: z.string().min(1),
  documentUri: z.string().min(1).startsWith('at://'),
  documentCid: z.string().min(1),
  title: z.string().min(1).max(512),
  path: z.string().max(1024).optional(),
});

const listContentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export function createContentRouter(oauthClient: NodeOAuthClient, db: Kysely<Database>): Router {
  const router = Router({ mergeParams: true });
  const webhooks = createWebhookService(db);

  /**
   * Shared helper: verify system app visibility and check collection-level
   * permission for the given operation using the system app's permissions.
   */
  async function enforceContentPermission(
    res: Response,
    communityDid: string,
    userDid: string,
    operation: Operation,
  ) {
    // 1. App visibility gate (system app)
    const visibility = await checkAppVisibility(db, communityDid, SYSTEM_APP_ID);
    if (!visibility.allowed) {
      res.status(403).json({ error: visibility.reason });
      return null;
    }

    // 2. Community exists?
    const community = await db
      .selectFrom('communities')
      .selectAll()
      .where('did', '=', communityDid)
      .executeTakeFirst();
    if (!community) {
      res.status(404).json({ error: 'Community not found' });
      return null;
    }

    const communityAgent = await createCommunityAgent(db, communityDid);

    // 3. Collection permission check
    const requiredRole = await getRequiredRole(
      db, communityDid, SYSTEM_APP_ID, SHARED_CONTENT_COLLECTION, operation,
    );

    // Fall back to app defaults, then 'member'
    let effectiveRequiredRole: string = requiredRole ?? '';
    if (!effectiveRequiredRole) {
      const col = `default_can_${operation}` as const;
      const appDefault = await db
        .selectFrom('app_default_permissions')
        .select(col as any)
        .where('app_id', '=', SYSTEM_APP_ID)
        .where('collection', '=', SHARED_CONTENT_COLLECTION)
        .executeTakeFirst();
      effectiveRequiredRole = appDefault ? (appDefault as any)[col] : 'member';
    }

    // 4. Resolve user's roles
    const userRoles = await getUserRoles(db, communityDid, userDid, communityAgent);

    if (userRoles.length === 0) {
      res.status(403).json({ error: 'User is not a member of this community' });
      return null;
    }

    if (!satisfiesRole(userRoles, effectiveRequiredRole)) {
      res.status(403).json({
        error: `Insufficient permissions. Required role: ${effectiveRequiredRole}`,
      });
      return null;
    }

    return { communityAgent, userRoles };
  }

  /**
   * GET /communities/:did/content
   * List all shared content for a community. Paginated via cursor.
   */
  router.get('/', async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const parsed = listContentSchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      }

      const { limit, cursor } = parsed.data;

      // Verify community exists
      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();
      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      const response = await communityAgent.api.com.atproto.repo.listRecords({
        repo: communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        limit,
        cursor,
      });

      const records = response.data.records.map((r: any) => ({
        uri: r.uri,
        rkey: r.uri.split('/').pop(),
        type: r.value.type,
        documentUri: r.value.documentUri,
        documentCid: r.value.documentCid,
        sharedBy: r.value.sharedBy,
        title: r.value.title,
        path: r.value.path,
        sharedAt: r.value.sharedAt,
      }));

      res.json({
        records,
        cursor: response.data.cursor,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, 'Error listing shared content');
      res.status(500).json({ error: error.message || 'Failed to list shared content' });
    }
  });

  /**
   * POST /communities/:did/content
   * Share content with a community. Requires member role.
   *
   * Body: { userDid, type, documentUri, documentCid, title, path? }
   */
  router.post('/', async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const userDid = agent.assertDid;

      const parsed = shareContentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }

      const { type, documentUri, documentCid, title, path } = parsed.data;

      const result = await enforceContentPermission(res, communityDid, userDid, 'create');
      if (!result) return;

      const { communityAgent } = result;

      // Duplicate check: ensure this document hasn't already been shared
      let cursor: string | undefined;
      let isDuplicate = false;
      do {
        const existing = await communityAgent.api.com.atproto.repo.listRecords({
          repo: communityDid,
          collection: SHARED_CONTENT_COLLECTION,
          limit: 100,
          cursor,
        });
        isDuplicate = existing.data.records.some(
          (r: any) => r.value.documentUri === documentUri,
        );
        cursor = existing.data.cursor;
      } while (cursor && !isDuplicate);

      if (isDuplicate) {
        return res.status(409).json({ error: 'This content has already been shared with this community' });
      }

      const response = await communityAgent.api.com.atproto.repo.createRecord({
        repo: communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        record: {
          $type: SHARED_CONTENT_COLLECTION,
          type,
          documentUri,
          documentCid,
          sharedBy: userDid,
          title,
          ...(path ? { path } : {}),
          sharedAt: new Date().toISOString(),
        },
      });

      await webhooks.dispatch('record.created', communityDid, {
        communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        uri: response.data.uri,
        userDid,
      });

      res.status(201).json({
        uri: response.data.uri,
        cid: response.data.cid,
      });
    } catch (error: any) {
      logger.error({ error, communityDid }, 'Error sharing content');
      res.status(500).json({ error: error.message || 'Failed to share content' });
    }
  });

  /**
   * DELETE /communities/:did/content/:rkey
   * Remove shared content. Requires admin role.
   */
  router.delete('/:rkey', async (req: Request, res: Response) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rkey = req.params.rkey;
    try {
      const { userDid } = req.body;
      if (!userDid || !userDid.startsWith('did:')) {
        return res.status(400).json({ error: 'userDid is required' });
      }

      const result = await enforceContentPermission(res, communityDid, userDid, 'delete');
      if (!result) return;

      const { communityAgent } = result;

      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        rkey,
      });

      await webhooks.dispatch('record.deleted', communityDid, {
        communityDid,
        collection: SHARED_CONTENT_COLLECTION,
        rkey,
        userDid,
      });

      res.json({ success: true });
    } catch (error: any) {
      logger.error({ error, communityDid, rkey }, 'Error removing shared content');
      res.status(500).json({ error: error.message || 'Failed to remove shared content' });
    }
  });

  return router;
}
