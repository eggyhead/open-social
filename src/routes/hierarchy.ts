import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { createVerifyApiKey, type AuthenticatedRequest } from '../middleware/auth';
import { createCommunityAgent } from '../services/atproto';
import { createWebhookService } from '../services/webhook';
import { isAdminInList } from '../lib/adminUtils';
import { logger } from '../lib/logger';
import { z } from 'zod';
import { didSchema } from '../validation/schemas';

const HIERARCHY_COLLECTION = 'community.opensocial.hierarchy';
const SHARED_CONTENT_COLLECTION = 'community.opensocial.sharedContent';

// Validation schemas
const requestHierarchySchema = z.object({
  adminDid: didSchema,
  parentDid: didSchema,
});

const approveHierarchySchema = z.object({
  adminDid: didSchema,
  childDid: didSchema,
});

const revokeHierarchySchema = z.object({
  adminDid: didSchema,
});

const listHierarchyContentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

/**
 * Fetch the admins list from a community's PDS repo.
 */
async function getAdmins(agent: any, communityDid: string): Promise<any[]> {
  try {
    const adminsRes = await agent.api.com.atproto.repo.getRecord({
      repo: communityDid,
      collection: 'community.opensocial.admins',
      rkey: 'self',
    });
    return (adminsRes.data.value as any)?.admins || [];
  } catch {
    return [];
  }
}

export function createHierarchyRouter(db: Kysely<Database>): Router {
  const router = Router();
  const verifyApiKey = createVerifyApiKey(db);
  const webhooks = createWebhookService(db);

  /**
   * POST /communities/:did/hierarchy/request
   * Request a parent-child hierarchy relationship. The calling community (:did)
   * becomes the child and sends a request to the specified parentDid.
   *
   * Body: { adminDid, parentDid }
   */
  router.post('/:did/hierarchy/request', verifyApiKey, async (req: AuthenticatedRequest, res) => {
    const childDid = decodeURIComponent(req.params.did);
    try {
      const parsed = requestHierarchySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }

      const { adminDid, parentDid } = parsed.data;

      if (childDid === parentDid) {
        return res.status(400).json({ error: 'A community cannot be its own parent' });
      }

      // Verify child community exists
      const childCommunity = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', childDid)
        .executeTakeFirst();
      if (!childCommunity) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Verify parent community exists
      const parentCommunity = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', parentDid)
        .executeTakeFirst();
      if (!parentCommunity) {
        return res.status(404).json({ error: 'Parent community not found' });
      }

      const childAgent = await createCommunityAgent(db, childDid);

      // Verify caller is an admin of the child community
      const admins = await getAdmins(childAgent, childDid);
      if (!isAdminInList(adminDid, admins)) {
        return res.status(403).json({ error: 'Only community admins can request a hierarchy relationship' });
      }

      // Check for an existing relationship between these two communities
      let cursor: string | undefined;
      do {
        const existing = await childAgent.api.com.atproto.repo.listRecords({
          repo: childDid,
          collection: HIERARCHY_COLLECTION,
          limit: 100,
          cursor,
        });
        const duplicate = existing.data.records.find(
          (r: any) => r.value.counterpartyDid === parentDid,
        );
        if (duplicate) {
          return res.status(409).json({ error: 'A hierarchy relationship with this parent already exists' });
        }
        cursor = existing.data.cursor;
      } while (cursor);

      const response = await childAgent.api.com.atproto.repo.createRecord({
        repo: childDid,
        collection: HIERARCHY_COLLECTION,
        record: {
          $type: HIERARCHY_COLLECTION,
          role: 'child',
          counterpartyDid: parentDid,
          status: 'pending',
          requestedBy: adminDid,
          createdAt: new Date().toISOString(),
        },
      });

      await webhooks.dispatch('record.created', childDid, {
        communityDid: childDid,
        collection: HIERARCHY_COLLECTION,
        uri: response.data.uri,
        userDid: adminDid,
      });

      res.status(201).json({
        uri: response.data.uri,
        cid: response.data.cid,
        rkey: response.data.uri.split('/').pop(),
        status: 'pending',
        message: 'Hierarchy request created. Waiting for parent community approval.',
      });
    } catch (error: any) {
      logger.error({ error, childDid }, 'Error requesting hierarchy relationship');
      res.status(500).json({ error: error.message || 'Failed to request hierarchy relationship' });
    }
  });

  /**
   * POST /communities/:did/hierarchy/approve
   * Approve a pending hierarchy request. The calling community (:did) is the
   * parent. Creates an approved record in the parent's repo and updates the
   * child's pending record to approved.
   *
   * Body: { adminDid, childDid }
   */
  router.post('/:did/hierarchy/approve', verifyApiKey, async (req: AuthenticatedRequest, res) => {
    const parentDid = decodeURIComponent(req.params.did);
    try {
      const parsed = approveHierarchySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }

      const { adminDid, childDid } = parsed.data;

      if (parentDid === childDid) {
        return res.status(400).json({ error: 'A community cannot be its own child' });
      }

      // Verify parent community exists
      const parentCommunity = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', parentDid)
        .executeTakeFirst();
      if (!parentCommunity) {
        return res.status(404).json({ error: 'Community not found' });
      }

      // Verify child community exists
      const childCommunity = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', childDid)
        .executeTakeFirst();
      if (!childCommunity) {
        return res.status(404).json({ error: 'Child community not found' });
      }

      const parentAgent = await createCommunityAgent(db, parentDid);

      // Verify caller is an admin of the parent community
      const admins = await getAdmins(parentAgent, parentDid);
      if (!isAdminInList(adminDid, admins)) {
        return res.status(403).json({ error: 'Only community admins can approve a hierarchy relationship' });
      }

      // Check for an existing approved parent-side record
      let cursor: string | undefined;
      do {
        const existing = await parentAgent.api.com.atproto.repo.listRecords({
          repo: parentDid,
          collection: HIERARCHY_COLLECTION,
          limit: 100,
          cursor,
        });
        const duplicate = existing.data.records.find(
          (r: any) => r.value.counterpartyDid === childDid,
        );
        if (duplicate) {
          return res.status(409).json({ error: 'This hierarchy relationship has already been approved' });
        }
        cursor = existing.data.cursor;
      } while (cursor);

      // Find the child's pending request record
      const childAgent = await createCommunityAgent(db, childDid);
      let childRecordRkey: string | null = null;
      let childRecordRequestedBy: string = adminDid; // fallback to approver if not found
      let childRecordCreatedAt: string = new Date().toISOString();
      let childCursor: string | undefined;
      do {
        const childRecords = await childAgent.api.com.atproto.repo.listRecords({
          repo: childDid,
          collection: HIERARCHY_COLLECTION,
          limit: 100,
          cursor: childCursor,
        });
        const match = childRecords.data.records.find(
          (r: any) => r.value.counterpartyDid === parentDid && r.value.role === 'child',
        );
        if (match) {
          childRecordRkey = match.uri.split('/').pop() ?? null;
          // Preserve the original requester and creation timestamp from the pending record
          childRecordRequestedBy = (match.value as any).requestedBy ?? adminDid;
          childRecordCreatedAt = (match.value as any).createdAt ?? new Date().toISOString();
          break;
        }
        childCursor = childRecords.data.cursor;
      } while (childCursor);

      if (!childRecordRkey) {
        return res.status(404).json({ error: 'No pending hierarchy request found from this child community' });
      }

      // Update child's record status to approved, preserving original requestedBy
      await childAgent.api.com.atproto.repo.putRecord({
        repo: childDid,
        collection: HIERARCHY_COLLECTION,
        rkey: childRecordRkey,
        record: {
          $type: HIERARCHY_COLLECTION,
          role: 'child',
          counterpartyDid: parentDid,
          status: 'approved',
          requestedBy: childRecordRequestedBy,
          createdAt: childRecordCreatedAt,
        },
      });

      // Create approved parent-side record, recording who approved it
      const parentResponse = await parentAgent.api.com.atproto.repo.createRecord({
        repo: parentDid,
        collection: HIERARCHY_COLLECTION,
        record: {
          $type: HIERARCHY_COLLECTION,
          role: 'parent',
          counterpartyDid: childDid,
          status: 'approved',
          requestedBy: adminDid,
          createdAt: new Date().toISOString(),
        },
      });

      await webhooks.dispatch('record.created', parentDid, {
        communityDid: parentDid,
        collection: HIERARCHY_COLLECTION,
        uri: parentResponse.data.uri,
        userDid: adminDid,
      });

      res.status(201).json({
        uri: parentResponse.data.uri,
        cid: parentResponse.data.cid,
        rkey: parentResponse.data.uri.split('/').pop(),
        status: 'approved',
        message: 'Hierarchy relationship approved. Both communities are now linked.',
      });
    } catch (error: any) {
      logger.error({ error, parentDid }, 'Error approving hierarchy relationship');
      res.status(500).json({ error: error.message || 'Failed to approve hierarchy relationship' });
    }
  });

  /**
   * GET /communities/:did/hierarchy
   * List all hierarchy relationships for a community (both pending and approved).
   * No authentication required.
   */
  router.get('/:did/hierarchy', async (req: AuthenticatedRequest, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
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
        collection: HIERARCHY_COLLECTION,
        limit: 100,
      });

      const relationships = response.data.records.map((r: any) => ({
        uri: r.uri,
        rkey: r.uri.split('/').pop(),
        role: r.value.role,
        counterpartyDid: r.value.counterpartyDid,
        status: r.value.status,
        requestedBy: r.value.requestedBy,
        createdAt: r.value.createdAt,
      }));

      res.json({ relationships });
    } catch (error: any) {
      logger.error({ error, communityDid }, 'Error listing hierarchy relationships');
      res.status(500).json({ error: error.message || 'Failed to list hierarchy relationships' });
    }
  });

  /**
   * DELETE /communities/:did/hierarchy/:rkey
   * Revoke a hierarchy relationship. Allowed only by admins of the community.
   * Also removes the counterparty's corresponding record.
   *
   * Body: { adminDid }
   */
  router.delete('/:did/hierarchy/:rkey', verifyApiKey, async (req: AuthenticatedRequest, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    const rkey = req.params.rkey;
    try {
      const parsed = revokeHierarchySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }

      const { adminDid } = parsed.data;

      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', communityDid)
        .executeTakeFirst();
      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      const communityAgent = await createCommunityAgent(db, communityDid);

      // Verify caller is an admin
      const admins = await getAdmins(communityAgent, communityDid);
      if (!isAdminInList(adminDid, admins)) {
        return res.status(403).json({ error: 'Only community admins can revoke a hierarchy relationship' });
      }

      // Fetch the record to get counterparty info
      let hierarchyRecord: any;
      try {
        const record = await communityAgent.api.com.atproto.repo.getRecord({
          repo: communityDid,
          collection: HIERARCHY_COLLECTION,
          rkey,
        });
        hierarchyRecord = record.data.value;
      } catch {
        return res.status(404).json({ error: 'Hierarchy record not found' });
      }

      const counterpartyDid = hierarchyRecord.counterpartyDid;

      // Delete this community's record
      await communityAgent.api.com.atproto.repo.deleteRecord({
        repo: communityDid,
        collection: HIERARCHY_COLLECTION,
        rkey,
      });

      await webhooks.dispatch('record.deleted', communityDid, {
        communityDid,
        collection: HIERARCHY_COLLECTION,
        rkey,
        userDid: adminDid,
      });

      // Attempt to also remove the counterparty's record (best-effort)
      try {
        const counterpartyCommunity = await db
          .selectFrom('communities')
          .selectAll()
          .where('did', '=', counterpartyDid)
          .executeTakeFirst();

        if (counterpartyCommunity) {
          const counterpartyAgent = await createCommunityAgent(db, counterpartyDid);
          let counterpartyCursor: string | undefined;
          do {
            const counterpartyRecords = await counterpartyAgent.api.com.atproto.repo.listRecords({
              repo: counterpartyDid,
              collection: HIERARCHY_COLLECTION,
              limit: 100,
              cursor: counterpartyCursor,
            });
            const match = counterpartyRecords.data.records.find(
              (r: any) => r.value.counterpartyDid === communityDid,
            );
            if (match) {
              const counterpartyRkey = match.uri.split('/').pop() ?? '';
              if (counterpartyRkey) {
                await counterpartyAgent.api.com.atproto.repo.deleteRecord({
                  repo: counterpartyDid,
                  collection: HIERARCHY_COLLECTION,
                  rkey: counterpartyRkey,
                });
              }
              break;
            }
            counterpartyCursor = counterpartyRecords.data.cursor;
          } while (counterpartyCursor);
        }
      } catch (counterpartyError) {
        // Log but don't fail — the local record is already deleted
        logger.warn(
          { error: counterpartyError, communityDid, counterpartyDid },
          'Could not remove counterparty hierarchy record',
        );
      }

      res.json({ success: true, message: 'Hierarchy relationship revoked' });
    } catch (error: any) {
      logger.error({ error, communityDid, rkey }, 'Error revoking hierarchy relationship');
      res.status(500).json({ error: error.message || 'Failed to revoke hierarchy relationship' });
    }
  });

  /**
   * GET /communities/:did/hierarchy/content
   * Aggregate shared content from all approved child communities.
   * Returns a combined list of shared content records from children.
   *
   * Query: { limit?, cursor? }
   */
  router.get('/:did/hierarchy/content', async (req: AuthenticatedRequest, res) => {
    const parentDid = decodeURIComponent(req.params.did);
    try {
      const parsed = listHierarchyContentSchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      }

      const { limit } = parsed.data;

      const community = await db
        .selectFrom('communities')
        .selectAll()
        .where('did', '=', parentDid)
        .executeTakeFirst();
      if (!community) {
        return res.status(404).json({ error: 'Community not found' });
      }

      const parentAgent = await createCommunityAgent(db, parentDid);

      // Collect all approved child DIDs from parent's hierarchy records
      const approvedChildDids: string[] = [];
      let hierarchyCursor: string | undefined;
      do {
        const hierarchyRecords = await parentAgent.api.com.atproto.repo.listRecords({
          repo: parentDid,
          collection: HIERARCHY_COLLECTION,
          limit: 100,
          cursor: hierarchyCursor,
        });
        for (const r of hierarchyRecords.data.records) {
          const val = r.value as any;
          if (val.role === 'parent' && val.status === 'approved') {
            approvedChildDids.push(val.counterpartyDid);
          }
        }
        hierarchyCursor = hierarchyRecords.data.cursor;
      } while (hierarchyCursor);

      if (approvedChildDids.length === 0) {
        return res.json({ records: [] });
      }

      // Fetch shared content from each approved child community
      const allRecords: any[] = [];
      for (const childDid of approvedChildDids) {
        try {
          const childCommunity = await db
            .selectFrom('communities')
            .selectAll()
            .where('did', '=', childDid)
            .executeTakeFirst();

          if (!childCommunity) continue;

          const childAgent = await createCommunityAgent(db, childDid);
          const contentResponse = await childAgent.api.com.atproto.repo.listRecords({
            repo: childDid,
            collection: SHARED_CONTENT_COLLECTION,
            limit: Math.min(limit, 100),
          });

          for (const r of contentResponse.data.records) {
            allRecords.push({
              uri: r.uri,
              rkey: r.uri.split('/').pop(),
              sourceCommunityDid: childDid,
              type: (r.value as any).type,
              documentUri: (r.value as any).documentUri,
              documentCid: (r.value as any).documentCid,
              sharedBy: (r.value as any).sharedBy,
              title: (r.value as any).title,
              path: (r.value as any).path,
              sharedAt: (r.value as any).sharedAt,
              // Event-specific cached fields
              ...((r.value as any).startsAt !== undefined ? { startsAt: (r.value as any).startsAt } : {}),
              ...((r.value as any).endsAt !== undefined ? { endsAt: (r.value as any).endsAt } : {}),
              ...((r.value as any).location !== undefined ? { location: (r.value as any).location } : {}),
              ...((r.value as any).mode !== undefined ? { mode: (r.value as any).mode } : {}),
            });
          }
        } catch (childError) {
          logger.warn({ error: childError, childDid, parentDid }, 'Failed to fetch content from child community');
        }
      }

      // Sort by sharedAt descending and apply limit
      allRecords.sort((a, b) => {
        const aTime = a.sharedAt ? new Date(a.sharedAt).getTime() : 0;
        const bTime = b.sharedAt ? new Date(b.sharedAt).getTime() : 0;
        return bTime - aTime;
      });

      res.json({ records: allRecords.slice(0, limit) });
    } catch (error: any) {
      logger.error({ error, parentDid }, 'Error fetching hierarchy content');
      res.status(500).json({ error: error.message || 'Failed to fetch hierarchy content' });
    }
  });

  return router;
}
