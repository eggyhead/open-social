import { BskyAgent, AtpAgent } from '@atproto/api';
import { DidResolver, HandleResolver, MemoryCache, getPds, getHandle } from '@atproto/identity';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { decryptIfNeeded } from '../lib/crypto';
import { retry, isTransientError } from '../lib/retry';
import { logger } from '../lib/logger';
import { config } from '../config';

/**
 * Shared identity resolvers backed by an in-memory DID document cache.
 *
 * Using the official `@atproto/identity` package gives us:
 *   - support for both `did:plc` and `did:web`
 *   - bidirectional handle verification (handle -> DID -> handle)
 *   - automatic caching of DID documents (avoids repeated PLC lookups)
 *   - DNS TXT + HTTPS well-known handle resolution
 */
const didCache = new MemoryCache();

export const didResolver = new DidResolver({
  plcUrl: config.plcUrl,
  didCache,
});

export const handleResolver = new HandleResolver({});

/**
 * In-memory cache for authenticated community agents.
 *
 * The Bluesky PDS enforces a rate limit of ~30 createSession calls per
 * 5-minute window.  Without caching, every inbound API request calls
 * `login()`, so a single page load (which fires 5-10 parallel requests)
 * quickly exhausts the budget and causes cascading 429 errors.
 *
 * Cached agents are reused for 4 minutes (well within the JWT lifetime)
 * and automatically evicted when they expire.
 */
interface CachedAgent {
  agent: BskyAgent;
  expiresAt: number;
}

const agentCache = new Map<string, CachedAgent>();
const AGENT_CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutes

/**
 * Pending login promises so concurrent requests for the same community
 * share a single login() call instead of each triggering their own.
 */
const pendingLogins = new Map<string, Promise<BskyAgent>>();

/** Periodically prune expired entries so the map doesn't grow forever. */
setInterval(() => {
  const now = Date.now();
  for (const [did, entry] of agentCache) {
    if (now >= entry.expiresAt) {
      agentCache.delete(did);
    }
  }
}, 60_000);

/** Ensure a PDS host string is a full URL with scheme. */
export function ensureServiceUrl(pdsHost: string): string {
  if (pdsHost.startsWith('http://') || pdsHost.startsWith('https://')) {
    return pdsHost;
  }
  return `https://${pdsHost}`;
}

/**
 * Resolve a DID to its actual PDS endpoint via the DID document.
 *
 * Uses the official `@atproto/identity` `DidResolver`, which supports both
 * `did:plc` (via the PLC directory) and `did:web` (via the well-known URL),
 * and caches DID documents in memory. Falls back to the provided fallback
 * URL if resolution fails.
 */
export async function resolvePdsEndpoint(did: string, fallback?: string): Promise<string> {
  try {
    const doc = await didResolver.resolve(did);
    if (doc) {
      const pds = getPds(doc);
      if (pds) {
        return pds;
      }
    }
  } catch (err) {
    logger.warn({ did, error: err }, 'Failed to resolve PDS from DID document');
  }
  if (fallback) return ensureServiceUrl(fallback);
  throw new Error(`Could not resolve PDS for ${did}`);
}

/**
 * Resolve a handle to its DID with bidirectional verification.
 *
 * Per the ATProto identity spec, a handle "claim" is only valid if the DID
 * document the handle resolves to also lists the same handle. This function
 * performs that round-trip check and throws if the two do not agree.
 */
export async function resolveHandleToDid(handle: string): Promise<string> {
  const normalized = handle.toLowerCase().replace(/^@/, '');
  const did = await handleResolver.resolve(normalized);
  if (!did) {
    throw new Error(`Could not resolve handle "${handle}" to a DID`);
  }
  const doc = await didResolver.resolve(did);
  if (!doc) {
    throw new Error(`Could not resolve DID document for "${did}"`);
  }
  const docHandle = getHandle(doc);
  if (!docHandle || docHandle.toLowerCase() !== normalized) {
    throw new Error(
      `Handle verification failed: "${handle}" does not match DID document handle "${docHandle ?? 'none'}"`,
    );
  }
  return did;
}

export async function createCommunityAgent(db: Kysely<Database>, did: string): Promise<BskyAgent> {
  // 1. Return a cached agent if it's still valid
  const cached = agentCache.get(did);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.agent;
  }

  // 2. If another caller is already logging in for this DID, await that
  //    instead of firing a second createSession call.
  const pending = pendingLogins.get(did);
  if (pending) {
    return pending;
  }

  // 3. Perform the actual login, sharing the promise with concurrent callers
  const loginPromise = (async (): Promise<BskyAgent> => {
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
        maxRetries: 2,
        initialDelay: 1000,
        shouldRetry: (error) => {
          return isTransientError(error);
        },
        context: {
          did,
          handle: community.handle,
          pdsHost: pdsUrl,
        },
      }
    );

    // Cache the authenticated agent
    agentCache.set(did, { agent, expiresAt: Date.now() + AGENT_CACHE_TTL_MS });
    logger.info({ did }, 'Community agent cached');

    return agent;
  })();

  pendingLogins.set(did, loginPromise);

  try {
    return await loginPromise;
  } finally {
    pendingLogins.delete(did);
  }
}

/**
 * Evict a cached community agent (e.g. after an app-password update).
 */
export function invalidateCommunityAgent(did: string): void {
  agentCache.delete(did);
  pendingLogins.delete(did);
}

export async function getPublicAgent(pdsHost: string): Promise<AtpAgent> {
  return new AtpAgent({ service: ensureServiceUrl(pdsHost) });
}
