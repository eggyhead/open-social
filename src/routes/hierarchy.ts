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
  type: z.enum(['document', 'event']).optional(),
});

const inviteHierarchySchema = z.object({
  adminDid: didSchema,
  childDid: didSchema,
});

const acceptHierarchySchema = z.object({
  adminDid: didSchema,
  parentDid: didSchema,
});

const rejectHierarchySchema = z.object({
  adminDid: didSchema,
  counterpartyDid: didSchema,
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

      // Track the pending request in PostgreSQL for discoverability
      const rkey = response.data.uri.split('/').pop()!;
      await db
        .insertInto('pending_hierarchy_requests')
        .values({
          requester_did: childDid,
          target_did: parentDid,
          requester_role: 'child',
          requester_record_rkey: rkey,
          admin_did: adminDid,
        })
        .onConflict((oc) => oc.columns(['requester_did', 'target_did']).doNothing())
        .execute();

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

      // Remove the pending request row now that both sides are approved
      await db
        .deleteFrom('pending_hierarchy_requests')
        .where('requester_did', '=', childDid)
        .where('target_did', '=', parentDid)
        .execute();

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

      const rawRelationships = response.data.records.map((r: any) => ({
        uri: r.uri,
        rkey: r.uri.split('/').pop(),
        role: r.value.role,
        counterpartyDid: r.value.counterpartyDid,
        status: r.value.status,
        requestedBy: r.value.requestedBy,
        createdAt: r.value.createdAt,
      }));

      // Enrich with counterparty display info from the communities table
      const counterpartyDids = rawRelationships.map((r: any) => r.counterpartyDid);
      const counterpartyRows = counterpartyDids.length > 0
        ? await db
            .selectFrom('communities')
            .select(['did', 'display_name', 'handle', 'avatar_url', 'description'])
            .where('did', 'in', counterpartyDids)
            .execute()
        : [];
      const counterpartyMap = new Map(counterpartyRows.map((c) => [c.did, c]));

      const relationships = rawRelationships.map((r: any) => {
        const info = counterpartyMap.get(r.counterpartyDid);
        return {
          ...r,
          displayName: info?.display_name ?? null,
          handle: info?.handle ?? null,
          avatar: info?.avatar_url ?? null,
          description: info?.description ?? null,
        };
      });

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

      // Clean up any pending_hierarchy_requests rows (covers both directions)
      await db
        .deleteFrom('pending_hierarchy_requests')
        .where((eb) =>
          eb.or([
            eb.and([
              eb('requester_did', '=', communityDid),
              eb('target_did', '=', counterpartyDid),
            ]),
            eb.and([
              eb('requester_did', '=', counterpartyDid),
              eb('target_did', '=', communityDid),
            ]),
          ]),
        )
        .execute();

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

      const { limit, type: contentType } = parsed.data;

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
            const recordType = (r.value as any).type;

            // Apply optional type filter
            if (contentType && recordType !== contentType) continue;

            allRecords.push({
              uri: r.uri,
              rkey: r.uri.split('/').pop(),
              sourceCommunityDid: childDid,
              type: recordType,
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

  /**
   * POST /communities/:did/hierarchy/invite
   * Invite a child community to join this community's hierarchy.
   * The calling community (:did) becomes the parent.
   *
   * Body: { adminDid, childDid }
   */
  router.post('/:did/hierarchy/invite', verifyApiKey, async (req: AuthenticatedRequest, res) => {
    const parentDid = decodeURIComponent(req.params.did);
    try {
      const parsed = inviteHierarchySchema.safeParse(req.body);
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
        return res.status(403).json({ error: 'Only community admins can invite a child community' });
      }

      // Check for an existing relationship between these two communities
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
          return res.status(409).json({ error: 'A hierarchy relationship with this child already exists' });
        }
        cursor = existing.data.cursor;
      } while (cursor);

      const response = await parentAgent.api.com.atproto.repo.createRecord({
        repo: parentDid,
        collection: HIERARCHY_COLLECTION,
        record: {
          $type: HIERARCHY_COLLECTION,
          role: 'parent',
          counterpartyDid: childDid,
          status: 'pending',
          requestedBy: adminDid,
          createdAt: new Date().toISOString(),
        },
      });

      await webhooks.dispatch('record.created', parentDid, {
        communityDid: parentDid,
        collection: HIERARCHY_COLLECTION,
        uri: response.data.uri,
        userDid: adminDid,
      });

      // Track the pending request in PostgreSQL for discoverability
      const rkey = response.data.uri.split('/').pop()!;
      await db
        .insertInto('pending_hierarchy_requests')
        .values({
          requester_did: parentDid,
          target_did: childDid,
          requester_role: 'parent',
          requester_record_rkey: rkey,
          admin_did: adminDid,
        })
        .onConflict((oc) => oc.columns(['requester_did', 'target_did']).doNothing())
        .execute();

      res.status(201).json({
        uri: response.data.uri,
        cid: response.data.cid,
        rkey,
        status: 'pending',
        message: 'Hierarchy invite created. Waiting for child community approval.',
      });
    } catch (error: any) {
      logger.error({ error, parentDid }, 'Error inviting child community');
      res.status(500).json({ error: error.message || 'Failed to invite child community' });
    }
  });

  /**
   * POST /communities/:did/hierarchy/accept
   * Accept a pending hierarchy invite from a parent community.
   * The calling community (:did) is the child.
   *
   * Body: { adminDid, parentDid }
   */
  router.post('/:did/hierarchy/accept', verifyApiKey, async (req: AuthenticatedRequest, res) => {
    const childDid = decodeURIComponent(req.params.did);
    try {
      const parsed = acceptHierarchySchema.safeParse(req.body);
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
        return res.status(403).json({ error: 'Only community admins can accept a hierarchy invite' });
      }

      // Check for existing child-side record (already accepted or self-initiated)
      let existingCursor: string | undefined;
      do {
        const existing = await childAgent.api.com.atproto.repo.listRecords({
          repo: childDid,
          collection: HIERARCHY_COLLECTION,
          limit: 100,
          cursor: existingCursor,
        });
        const duplicate = existing.data.records.find(
          (r: any) => r.value.counterpartyDid === parentDid,
        );
        if (duplicate) {
          return res.status(409).json({ error: 'A hierarchy relationship with this parent already exists' });
        }
        existingCursor = existing.data.cursor;
      } while (existingCursor);

      // Find the parent's pending invite record
      const parentAgent = await createCommunityAgent(db, parentDid);
      let parentRecordRkey: string | null = null;
      let parentRecordRequestedBy: string = adminDid;
      let parentRecordCreatedAt: string = new Date().toISOString();
      let parentCursor: string | undefined;
      do {
        const parentRecords = await parentAgent.api.com.atproto.repo.listRecords({
          repo: parentDid,
          collection: HIERARCHY_COLLECTION,
          limit: 100,
          cursor: parentCursor,
        });
        const match = parentRecords.data.records.find(
          (r: any) => r.value.counterpartyDid === childDid && r.value.role === 'parent',
        );
        if (match) {
          parentRecordRkey = match.uri.split('/').pop() ?? null;
          parentRecordRequestedBy = (match.value as any).requestedBy ?? adminDid;
          parentRecordCreatedAt = (match.value as any).createdAt ?? new Date().toISOString();
          break;
        }
        parentCursor = parentRecords.data.cursor;
      } while (parentCursor);

      if (!parentRecordRkey) {
        return res.status(404).json({ error: 'No pending hierarchy invite found from this parent community' });
      }

      // Update parent's record status to approved, preserving original requestedBy
      await parentAgent.api.com.atproto.repo.putRecord({
        repo: parentDid,
        collection: HIERARCHY_COLLECTION,
        rkey: parentRecordRkey,
        record: {
          $type: HIERARCHY_COLLECTION,
          role: 'parent',
          counterpartyDid: childDid,
          status: 'approved',
          requestedBy: parentRecordRequestedBy,
          createdAt: parentRecordCreatedAt,
        },
      });

      // Create approved child-side record
      const childResponse = await childAgent.api.com.atproto.repo.createRecord({
        repo: childDid,
        collection: HIERARCHY_COLLECTION,
        record: {
          $type: HIERARCHY_COLLECTION,
          role: 'child',
          counterpartyDid: parentDid,
          status: 'approved',
          requestedBy: adminDid,
          createdAt: new Date().toISOString(),
        },
      });

      await webhooks.dispatch('record.created', childDid, {
        communityDid: childDid,
        collection: HIERARCHY_COLLECTION,
        uri: childResponse.data.uri,
        userDid: adminDid,
      });

      // Remove the pending request row
      await db
        .deleteFrom('pending_hierarchy_requests')
        .where('requester_did', '=', parentDid)
        .where('target_did', '=', childDid)
        .execute();

      res.status(201).json({
        uri: childResponse.data.uri,
        cid: childResponse.data.cid,
        rkey: childResponse.data.uri.split('/').pop(),
        status: 'approved',
        message: 'Hierarchy invite accepted. Both communities are now linked.',
      });
    } catch (error: any) {
      logger.error({ error, childDid }, 'Error accepting hierarchy invite');
      res.status(500).json({ error: error.message || 'Failed to accept hierarchy invite' });
    }
  });

  /**
   * POST /communities/:did/hierarchy/reject
   * Reject a pending hierarchy request or invite.
   * The calling community (:did) is the target that received the proposal.
   *
   * Body: { adminDid, counterpartyDid }
   */
  router.post('/:did/hierarchy/reject', verifyApiKey, async (req: AuthenticatedRequest, res) => {
    const communityDid = decodeURIComponent(req.params.did);
    try {
      const parsed = rejectHierarchySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }

      const { adminDid, counterpartyDid } = parsed.data;

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
        return res.status(403).json({ error: 'Only community admins can reject a hierarchy request' });
      }

      // Find and validate the pending request row
      const pendingRow = await db
        .selectFrom('pending_hierarchy_requests')
        .selectAll()
        .where('requester_did', '=', counterpartyDid)
        .where('target_did', '=', communityDid)
        .executeTakeFirst();

      if (!pendingRow) {
        return res.status(404).json({ error: 'No pending hierarchy request found from this community' });
      }

      // Delete the requester's PDS record (best-effort)
      try {
        const counterpartyCommunity = await db
          .selectFrom('communities')
          .selectAll()
          .where('did', '=', counterpartyDid)
          .executeTakeFirst();

        if (counterpartyCommunity) {
          const counterpartyAgent = await createCommunityAgent(db, counterpartyDid);
          await counterpartyAgent.api.com.atproto.repo.deleteRecord({
            repo: counterpartyDid,
            collection: HIERARCHY_COLLECTION,
            rkey: pendingRow.requester_record_rkey,
          });
        }
      } catch (deleteError) {
        logger.warn(
          { error: deleteError, communityDid, counterpartyDid },
          'Could not remove counterparty hierarchy record during rejection',
        );
      }

      // Remove the pending request row
      await db
        .deleteFrom('pending_hierarchy_requests')
        .where('id', '=', pendingRow.id)
        .execute();

      res.json({ success: true, message: 'Hierarchy request rejected' });
    } catch (error: any) {
      logger.error({ error, communityDid }, 'Error rejecting hierarchy request');
      res.status(500).json({ error: error.message || 'Failed to reject hierarchy request' });
    }
  });

  /**
   * GET /communities/:did/hierarchy/pending
   * List incoming pending hierarchy requests for a community.
   * Returns proposals from other communities that are awaiting approval.
   */
  router.get('/:did/hierarchy/pending', verifyApiKey, async (req: AuthenticatedRequest, res) => {
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

      const rows = await db
        .selectFrom('pending_hierarchy_requests as p')
        .innerJoin('communities as c', 'c.did', 'p.requester_did')
        .select([
          'p.id',
          'p.requester_did as requesterDid',
          'p.target_did as targetDid',
          'p.requester_role as requesterRole',
          'p.requester_record_rkey as requesterRecordRkey',
          'p.admin_did as adminDid',
          'p.created_at as createdAt',
          'c.display_name as displayName',
          'c.handle',
          'c.avatar_url as avatar',
          'c.description',
        ])
        .where('p.target_did', '=', communityDid)
        .orderBy('p.created_at', 'desc')
        .execute();

      res.json({ requests: rows });
    } catch (error: any) {
      logger.error({ error, communityDid }, 'Error listing pending hierarchy requests');
      res.status(500).json({ error: error.message || 'Failed to list pending hierarchy requests' });
    }
  });

  return router;
}
