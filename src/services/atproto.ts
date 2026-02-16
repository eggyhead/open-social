import { BskyAgent, AtpAgent } from '@atproto/api';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { decryptIfNeeded } from '../lib/crypto';
import { retry, isTransientError } from '../lib/retry';
import { logger } from '../lib/logger';
import { config } from '../config';

/** Ensure a PDS host string is a full URL with scheme. */
export function ensureServiceUrl(pdsHost: string): string {
  if (pdsHost.startsWith('http://') || pdsHost.startsWith('https://')) {
    return pdsHost;
  }
  return `https://${pdsHost}`;
}

/**
 * Resolve a DID to its actual PDS endpoint via the PLC directory.
 * Falls back to the provided fallback URL if resolution fails.
 */
export async function resolvePdsEndpoint(did: string, fallback?: string): Promise<string> {
  try {
    const res = await fetch(`${config.plcUrl}/${did}`);
    if (!res.ok) throw new Error(`PLC directory returned ${res.status}`);
    const doc = await res.json() as { service?: { id: string; serviceEndpoint: string }[] };
    const pds = doc.service?.find((s) => s.id === '#atproto_pds');
    if (pds?.serviceEndpoint) {
      return pds.serviceEndpoint;
    }
  } catch (err) {
    logger.warn({ did, error: err }, 'Failed to resolve PDS from DID document');
  }
  if (fallback) return ensureServiceUrl(fallback);
  throw new Error(`Could not resolve PDS for ${did}`);
}

export async function createCommunityAgent(db: Kysely<Database>, did: string): Promise<BskyAgent> {
  const community = await db
    .selectFrom('communities')
    .select(['handle', 'pds_host', 'app_password'])
    .where('did', '=', did)
    .executeTakeFirst();

  if (!community) {
    throw new Error('Community not found');
  }

  // Resolve the actual PDS endpoint from the DID document,
  // falling back to the stored pds_host if resolution fails.
  const pdsUrl = await resolvePdsEndpoint(did, community.pds_host);

  const agent = new BskyAgent({ service: pdsUrl });

  await retry(
    () => agent.login({
      identifier: did,
      password: decryptIfNeeded(community.app_password),
    }),
    {
      maxRetries: 3,
      initialDelay: 1000,
      shouldRetry: (error) => isTransientError(error),
      context: {
        did,
        handle: community.handle,
        pdsHost: pdsUrl,
      },
    }
  );

  return agent;
}

export async function getPublicAgent(pdsHost: string): Promise<AtpAgent> {
  return new AtpAgent({ service: ensureServiceUrl(pdsHost) });
}
