import { sql, type Kysely } from 'kysely';
import type { CacheResult, DidCache, DidDocument } from '@atproto/identity';
import type { Database } from '../db';
import { logger } from '../lib/logger';

/**
 * Default cache lifetimes.
 *
 * `staleTTL` controls when an entry is considered "stale" — still served, but
 * refreshed in the background on the next read.  `maxTTL` is the hard cutoff
 * after which an entry must be re-resolved before being returned.
 *
 * The ATProto identity spec recommends keeping cache lifetimes under ~10
 * minutes for auth flows so handle/key changes propagate quickly; we default
 * to 5 minutes stale and 1 hour max to satisfy that guidance.
 */
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface PostgresDidCacheOpts {
  /** Time before an entry is considered stale (ms). Default: 5 minutes. */
  staleTTL?: number;
  /** Time before an entry is considered expired (ms). Default: 1 hour. */
  maxTTL?: number;
}

/**
 * PostgreSQL-backed implementation of the `@atproto/identity` `DidCache`
 * interface.  Caches DID documents in the `did_cache` table so repeat lookups
 * are served from the database instead of hitting the PLC directory on every
 * request (a ~3 second round-trip for uncached handles).
 *
 * Mirrors the semantics of the SQLite reference implementation in the Bluesky
 * PDS: writes never throw out of the cache (they are logged), and a stale
 * entry is returned immediately while `DidResolver` refreshes it in the
 * background via `refreshCache`.
 */
export class PostgresDidCache implements DidCache {
  public readonly staleTTL: number;
  public readonly maxTTL: number;

  constructor(
    private readonly db: Kysely<Database>,
    opts: PostgresDidCacheOpts = {},
  ) {
    this.staleTTL = opts.staleTTL ?? FIVE_MINUTES_MS;
    this.maxTTL = opts.maxTTL ?? ONE_HOUR_MS;
  }

  async cacheDid(did: string, doc: DidDocument): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.maxTTL);
    // Send the document as a JSON string; Postgres implicitly casts to `jsonb`
    // for the column type.  This avoids relying on driver-specific object
    // serialisation.
    const docJson = JSON.stringify(doc);
    try {
      await this.db
        .insertInto('did_cache')
        .values({
          did,
          doc: docJson,
          updated_at: now,
          expires_at: expiresAt,
        })
        .onConflict((oc) =>
          oc.column('did').doUpdateSet({
            doc: docJson,
            updated_at: now,
            expires_at: expiresAt,
          }),
        )
        .execute();
    } catch (err) {
      // Never let cache-write failures break resolution — the resolver will
      // simply fall back to a live HTTP lookup next time.
      logger.error({ did, err }, 'Failed to write DID document to cache');
    }
  }

  async refreshCache(
    did: string,
    getDoc: () => Promise<DidDocument | null>,
  ): Promise<void> {
    try {
      const doc = await getDoc();
      if (doc) {
        await this.cacheDid(did, doc);
      } else {
        await this.clearEntry(did);
      }
    } catch (err) {
      logger.error({ did, err }, 'Refreshing DID cache entry failed');
    }
  }

  async checkCache(did: string): Promise<CacheResult | null> {
    try {
      const row = await this.db
        .selectFrom('did_cache')
        .where('did', '=', did)
        .select(['did', 'doc', 'updated_at'])
        .executeTakeFirst();
      if (!row) return null;

      // `pg` returns timestamptz columns as native Date objects.
      const updatedAt = (row.updated_at as Date).getTime();
      const now = Date.now();
      // The `jsonb` column comes back already-parsed from `pg`, but if a
      // caller (e.g. a test) inserted a raw JSON string, parse it defensively.
      const doc =
        typeof row.doc === 'string'
          ? (JSON.parse(row.doc) as DidDocument)
          : (row.doc as DidDocument);

      return {
        did,
        doc,
        updatedAt,
        stale: now > updatedAt + this.staleTTL,
        expired: now > updatedAt + this.maxTTL,
      };
    } catch (err) {
      logger.error({ did, err }, 'Failed to read DID document from cache');
      return null;
    }
  }

  async clearEntry(did: string): Promise<void> {
    try {
      await this.db.deleteFrom('did_cache').where('did', '=', did).execute();
    } catch (err) {
      logger.error({ did, err }, 'Failed to clear DID cache entry');
    }
  }

  async clear(): Promise<void> {
    await this.db.deleteFrom('did_cache').execute();
  }

  /**
   * Prune entries whose `expires_at` is in the past.  Intended to be invoked
   * periodically (see `startDidCacheCleanup`).  Returns the number of rows
   * removed so callers can log/meter it.
   */
  async cleanupExpired(): Promise<number> {
    try {
      const result = await this.db
        .deleteFrom('did_cache')
        .where('expires_at', '<', sql<Date>`now()`)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    } catch (err) {
      logger.error({ err }, 'Failed to clean up expired DID cache entries');
      return 0;
    }
  }
}

/**
 * Schedule periodic cleanup of expired DID cache entries.
 *
 * Returns a disposer that clears the timer — useful in tests so the interval
 * doesn't keep the event loop alive.
 */
export function startDidCacheCleanup(
  cache: PostgresDidCache,
  intervalMs: number = 10 * 60 * 1000,
): () => void {
  const timer = setInterval(() => {
    cache.cleanupExpired().then((removed) => {
      if (removed > 0) {
        logger.info({ removed }, 'Pruned expired DID cache entries');
      }
    });
  }, intervalMs);
  // Don't keep the Node process alive solely for cleanup work.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return () => clearInterval(timer);
}
