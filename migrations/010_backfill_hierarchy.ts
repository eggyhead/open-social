import { Kysely } from 'kysely';
import { BskyAgent } from '@atproto/api';

/**
 * Migration: Backfill `pending_hierarchy_requests` from PDS records.
 *
 * Hierarchy requests may have been created in community PDS repos before the
 * `pending_hierarchy_requests` table existed (migration 009). This migration
 * scans all communities for pending hierarchy records and inserts the
 * corresponding rows.
 */

const HIERARCHY_COLLECTION = 'community.opensocial.hierarchy';

function pdsServiceUrl(pdsHost: string): string {
  if (pdsHost.startsWith('http://') || pdsHost.startsWith('https://')) {
    return pdsHost;
  }
  return `https://${pdsHost}`;
}

/**
 * Best-effort decryption: if the stored password starts with the encryption
 * marker, dynamically import the project's crypto helper. Otherwise return
 * the value as-is (plaintext or already decrypted at rest by the platform).
 */
async function decryptPassword(stored: string): Promise<string> {
  if (stored.startsWith('enc:') || stored.startsWith('v1:')) {
    try {
      const { decryptIfNeeded } = await import('../src/lib/crypto');
      return decryptIfNeeded(stored);
    } catch {
      return stored;
    }
  }
  return stored;
}

export async function up(db: Kysely<any>): Promise<void> {
  // Fetch all communities
  const communities = await db
    .selectFrom('communities')
    .select(['did', 'handle', 'pds_host', 'app_password'])
    .execute();

  if (communities.length === 0) return;

  const knownDids = new Set(communities.map((c) => c.did));
  let inserted = 0;

  for (const community of communities) {
    try {
      const password = await decryptPassword(community.app_password);
      const agent = new BskyAgent({ service: pdsServiceUrl(community.pds_host) });
      await agent.login({
        identifier: community.handle,
        password,
      });

      let cursor: string | undefined;
      do {
        const response = await agent.api.com.atproto.repo.listRecords({
          repo: community.did,
          collection: HIERARCHY_COLLECTION,
          limit: 100,
          cursor,
        });

        for (const record of response.data.records) {
          const val = record.value as any;
          if (val.status !== 'pending') continue;

          const counterpartyDid = val.counterpartyDid;
          if (!knownDids.has(counterpartyDid)) continue;

          const rkey = record.uri.split('/').pop()!;

          await db
            .insertInto('pending_hierarchy_requests')
            .values({
              requester_did: community.did,
              target_did: counterpartyDid,
              requester_role: val.role, // 'parent' or 'child'
              requester_record_rkey: rkey,
              admin_did: val.requestedBy || community.did,
            })
            .onConflict((oc) => oc.columns(['requester_did', 'target_did']).doNothing())
            .execute();

          inserted++;
        }

        cursor = response.data.cursor;
      } while (cursor);
    } catch (err) {
      // Log but don't fail the migration — a PDS being temporarily
      // unreachable shouldn't block the entire deploy.
      console.warn(
        `[010_backfill_hierarchy] Could not scan ${community.handle} (${community.did}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(`[010_backfill_hierarchy] Backfilled ${inserted} pending hierarchy request(s).`);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Truncate the table — the backfilled rows are recoverable by re-running
  // the migration, and ongoing operations will re-create rows naturally.
  await db.deleteFrom('pending_hierarchy_requests').execute();
}
