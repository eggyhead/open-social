#!/usr/bin/env tsx
/**
 * backfillHierarchy.ts — Scan all communities' PDS repos for pending
 * hierarchy records and insert corresponding rows into the
 * `pending_hierarchy_requests` table.
 *
 * This handles the case where hierarchy requests were created in the PDS
 * before the DB table existed (migration 009).
 *
 * Usage:
 *   npx tsx scripts/backfillHierarchy.ts [--dry-run]
 *
 * Options:
 *   --dry-run   Print what would be inserted without writing anything.
 */

import dotenv from 'dotenv';
import { BskyAgent } from '@atproto/api';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../src/db';
import { decryptIfNeeded } from '../src/lib/crypto';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');
const HIERARCHY_COLLECTION = 'community.opensocial.hierarchy';

function pdsServiceUrl(pdsHost: string): string {
  if (pdsHost.startsWith('http://') || pdsHost.startsWith('https://')) {
    return pdsHost;
  }
  return `https://${pdsHost}`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString }),
    }),
  });

  console.log(dryRun ? '🔍 DRY RUN — no writes will be made\n' : '🚀 Backfilling hierarchy pending requests…\n');

  const communities = await db.selectFrom('communities').selectAll().execute();
  console.log(`Found ${communities.length} communities to scan.\n`);

  // Build a set of known community DIDs for validation
  const knownDids = new Set(communities.map((c) => c.did));

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const community of communities) {
    const label = `${community.handle} (${community.did})`;

    try {
      const agent = new BskyAgent({ service: pdsServiceUrl(community.pds_host) });
      await agent.login({
        identifier: community.handle,
        password: decryptIfNeeded(community.app_password),
      });

      // List all hierarchy records for this community
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

          const rkey = record.uri.split('/').pop()!;
          const counterpartyDid = val.counterpartyDid;
          const role = val.role; // 'parent' or 'child'

          // Validate counterparty exists in our system
          if (!knownDids.has(counterpartyDid)) {
            console.log(`  ⚠ ${label}: pending ${role} record → ${counterpartyDid} (unknown community, skipping)`);
            skipped++;
            continue;
          }

          // Determine requester/target based on role
          // If this community's record says role='child' and status='pending',
          // then this community requested to be a child of counterpartyDid
          const requesterDid = community.did;
          const targetDid = counterpartyDid;
          const requesterRole = role;

          console.log(`  📋 ${label}: pending ${role} → ${counterpartyDid} (rkey: ${rkey})`);

          if (!dryRun) {
            await db
              .insertInto('pending_hierarchy_requests')
              .values({
                requester_did: requesterDid,
                target_did: targetDid,
                requester_role: requesterRole,
                requester_record_rkey: rkey,
                admin_did: val.requestedBy || community.did,
              })
              .onConflict((oc) => oc.columns(['requester_did', 'target_did']).doNothing())
              .execute();
          }

          inserted++;
        }

        cursor = response.data.cursor;
      } while (cursor);
    } catch (err) {
      console.error(`  ✗ ${label}: ${err instanceof Error ? err.message : err}`);
      errors++;
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Done. Inserted: ${inserted}, Skipped: ${skipped}, Errors: ${errors}`);
  if (dryRun) console.log('(dry run — nothing was written)');

  await db.destroy();
  process.exit(errors > 0 ? 1 : 0);
}

main();
