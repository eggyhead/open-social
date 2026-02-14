#!/usr/bin/env tsx
/**
 * Seed the devnet community account into the open-social database.
 *
 * Reads the community credentials from atproto-devnet/data/accounts.json
 * (written by the init container) and inserts a row into the `communities`
 * table so the app can act on behalf of the community DID.
 *
 * Usage:
 *   npm run seed:devnet          # from package.json
 *   npx tsx scripts/seed-devnet-community.ts   # directly
 *
 * Requires .env.devnet to be sourced (DATABASE_URL, ENCRYPTION_KEY, PDS_URL).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createDb } from '../src/db';
import { encrypt } from '../src/lib/crypto';
import { config } from '../src/config';

const ACCOUNTS_PATH = path.resolve(
  __dirname,
  '../../atproto-devnet/data/accounts.json'
);

async function main() {
  // ── Load devnet accounts ───────────────────────────────────────
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    console.error(
      `ERROR: ${ACCOUNTS_PATH} not found.\n` +
        'Run "npm run devnet:up" first to start the devnet and seed accounts.'
    );
    process.exit(1);
  }

  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8'));
  const community = accounts.COMMUNITY;

  if (!community?.did || !community?.appPassword) {
    console.error(
      'ERROR: Community account missing DID or appPassword in accounts.json.\n' +
        'Make sure the devnet init container has finished seeding.'
    );
    process.exit(1);
  }

  console.log(`Community DID:    ${community.did}`);
  console.log(`Community handle: ${community.handle}`);

  // ── Connect to the database ────────────────────────────────────
  if (!config.databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set. Source .env.devnet first.');
    process.exit(1);
  }

  const db = createDb(config.databaseUrl);

  // ── Upsert community row ──────────────────────────────────────
  const pdsHost = config.pdsUrl || 'http://localhost:3002';

  const existing = await db
    .selectFrom('communities')
    .selectAll()
    .where('did', '=', community.did)
    .executeTakeFirst();

  if (existing) {
    console.log('Community already exists in database — updating credentials.');
    await db
      .updateTable('communities')
      .set({
        handle: community.handle,
        display_name: community.handle,
        pds_host: pdsHost,
        app_password: encrypt(community.appPassword),
      })
      .where('did', '=', community.did)
      .execute();
  } else {
    console.log('Inserting community into database...');
    await db
      .insertInto('communities')
      .values({
        did: community.did,
        handle: community.handle,
        display_name: community.handle,
        pds_host: pdsHost,
        app_password: encrypt(community.appPassword),
        created_at: new Date(),
      })
      .execute();
  }

  console.log('✅ Community row seeded in database.');

  // ── Create PDS records (profile, admins, membership proof) ─────
  // The community endpoints expect these records to exist.
  const { BskyAgent } = await import('@atproto/api');

  console.log('Logging into PDS as community account...');
  const agent = new BskyAgent({ service: pdsHost });
  await agent.login({
    identifier: community.did,
    password: community.appPassword,
  });

  // Use Alice as the initial admin / member
  const alice = accounts.ALICE;
  const adminDid = alice?.did || community.did;

  // Create profile record (idempotent — putRecord overwrites)
  console.log('Creating community profile record...');
  await agent.api.com.atproto.repo.putRecord({
    repo: community.did,
    collection: 'community.opensocial.profile',
    rkey: 'self',
    record: {
      $type: 'community.opensocial.profile',
      displayName: community.handle,
      description: 'Devnet test community',
      type: 'open',
      createdAt: new Date().toISOString(),
    },
  });

  // Create admins record
  console.log('Creating community admins record...');
  await agent.api.com.atproto.repo.putRecord({
    repo: community.did,
    collection: 'community.opensocial.admins',
    rkey: 'self',
    record: {
      $type: 'community.opensocial.admins',
      admins: [{ did: adminDid, addedAt: new Date().toISOString() }],
    },
  });

  // Create membership proof for admin
  console.log('Creating membership proof for admin...');
  // Check if proof already exists
  const existingProofs = await agent.api.com.atproto.repo.listRecords({
    repo: community.did,
    collection: 'community.opensocial.membershipProof',
    limit: 100,
  });
  const alreadyMember = existingProofs.data.records.some(
    (r: any) => r.value.memberDid === adminDid
  );
  if (!alreadyMember) {
    await agent.api.com.atproto.repo.createRecord({
      repo: community.did,
      collection: 'community.opensocial.membershipProof',
      record: {
        $type: 'community.opensocial.membershipProof',
        memberDid: adminDid,
        cid: '',
        confirmedAt: new Date().toISOString(),
      },
    });
  }

  console.log('✅ Community fully seeded (DB + PDS records).');

  // Clean up DB connection
  await db.destroy();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
