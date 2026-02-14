/**
 * In-memory TTL cache with LRU eviction.
 *
 * Used to avoid repeated PDS round-trips for admin/membership checks
 * that happen on nearly every request.  Entries expire after `ttlMs`
 * milliseconds and are lazily evicted on read. When the cache reaches
 * maxSize, least recently used entries are evicted.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessedAt: number;
}

interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

export class TtlCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private metrics: CacheMetrics = { hits: 0, misses: 0, evictions: 0, size: 0 };

  /**
   * @param ttlMs  Time-to-live in milliseconds (default 5 minutes)
   * @param maxSize Maximum number of entries (default 1000)
   */
  constructor(ttlMs = 300_000, maxSize = 1000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.metrics.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.metrics.size = this.store.size;
      this.metrics.misses++;
      return undefined;
    }
    // Update last accessed time for LRU
    entry.lastAccessedAt = Date.now();
    this.metrics.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict LRU entries if we're at capacity
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      this.evictLRU();
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
      lastAccessedAt: Date.now(),
    });
    this.metrics.size = this.store.size;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.store.delete(oldestKey);
      this.metrics.evictions++;
      this.metrics.size = this.store.size;
    }
  }

  /** Get cache metrics for monitoring */
  getMetrics(): Readonly<CacheMetrics> {
    return { ...this.metrics };
  }

  /** Reset metrics counters (size is not reset) */
  resetMetrics(): void {
    this.metrics.hits = 0;
    this.metrics.misses = 0;
    this.metrics.evictions = 0;
  }

  /** Remove a single key (useful after a mutation that invalidates the cache). */
  invalidate(key: string): void {
    this.store.delete(key);
    this.metrics.size = this.store.size;
  }

  /** Remove all keys whose prefix matches (e.g. invalidate all entries for a community). */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
    this.metrics.size = this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.metrics.size = 0;
  }
}

// ─── Shared singleton caches ──────────────────────────────────────────

/** Cache for "is DID an admin of community?" — key: `${communityDid}:${userDid}` */
export const adminCache = new TtlCache<boolean>(300_000, 1000); // 5 min TTL, 1000 max entries

/** Cache for "is DID a member of community?" — key: `${communityDid}:${userDid}` */
export const memberCache = new TtlCache<boolean>(300_000, 1000); // 5 min TTL, 1000 max entries

/** Cache for user roles in a community — key: `${communityDid}:${userDid}`, value: role names */
export const memberRolesCache = new TtlCache<string[]>(300_000, 1000); // 5 min TTL, 1000 max entries
