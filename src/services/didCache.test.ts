/**
 * Unit tests for `PostgresDidCache`.
 *
 * Uses a small in-memory stub of the `did_cache` table behind the bits of the
 * Kysely query-builder we actually call.  This keeps the test fast and lets
 * us exercise the cache semantics (stale/expired flags, upsert, cleanup)
 * without standing up a real Postgres instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { DidDocument } from '@atproto/identity';

import type { Database } from '../db';
import { PostgresDidCache } from './didCache';

interface Row {
  did: string;
  doc: string;
  updated_at: Date;
  expires_at: Date;
}

/** Build a tiny query-builder stub that backs `did_cache` with a Map. */
function createFakeDb(): { db: Kysely<Database>; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();

  const insertBuilder = (table: string) => {
    let pendingValues: Row | null = null;
    let conflictUpdate: Partial<Row> | null = null;
    const builder: any = {
      values(v: Row) {
        pendingValues = { ...v, doc: String(v.doc) };
        return builder;
      },
      onConflict(cb: (oc: any) => any) {
        const oc = {
          column() {
            return oc;
          },
          doUpdateSet(set: Partial<Row>) {
            conflictUpdate = { ...set, doc: set.doc != null ? String(set.doc) : set.doc };
            return oc;
          },
        };
        cb(oc);
        return builder;
      },
      async execute() {
        if (table !== 'did_cache' || !pendingValues) return;
        const existing = rows.get(pendingValues.did);
        if (existing && conflictUpdate) {
          rows.set(pendingValues.did, { ...existing, ...conflictUpdate });
        } else {
          rows.set(pendingValues.did, pendingValues);
        }
      },
    };
    return builder;
  };

  const selectBuilder = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const builder: any = {
      where(col: keyof Row, op: string, val: unknown) {
        if (op === '=') filters.push((r) => (r as any)[col] === val);
        return builder;
      },
      select() {
        return builder;
      },
      selectAll() {
        return builder;
      },
      async executeTakeFirst() {
        if (table !== 'did_cache') return undefined;
        for (const r of rows.values()) {
          if (filters.every((f) => f(r))) return r;
        }
        return undefined;
      },
    };
    return builder;
  };

  const deleteBuilder = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const builder: any = {
      where(col: keyof Row, op: string, val: unknown) {
        if (op === '=') {
          filters.push((r) => (r as any)[col] === val);
        } else if (op === '<') {
          // Used for `expires_at < now()` cleanup.
          filters.push((r) => (r as any)[col] < new Date());
        }
        return builder;
      },
      async execute() {
        if (table !== 'did_cache') return;
        for (const [k, r] of [...rows]) {
          if (filters.every((f) => f(r))) rows.delete(k);
        }
      },
      async executeTakeFirst() {
        let n = 0;
        for (const [k, r] of [...rows]) {
          if (filters.every((f) => f(r))) {
            rows.delete(k);
            n++;
          }
        }
        return { numDeletedRows: BigInt(n) };
      },
    };
    return builder;
  };

  const db = {
    insertInto: (t: string) => insertBuilder(t),
    selectFrom: (t: string) => selectBuilder(t),
    deleteFrom: (t: string) => deleteBuilder(t),
  } as unknown as Kysely<Database>;

  return { db, rows };
}

const sampleDoc: DidDocument = {
  id: 'did:plc:abc123',
  alsoKnownAs: ['at://alice.example.com'],
} as DidDocument;

describe('PostgresDidCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a DID document and reads it back as fresh', async () => {
    const { db } = createFakeDb();
    const cache = new PostgresDidCache(db);

    await cache.cacheDid('did:plc:abc123', sampleDoc);
    const result = await cache.checkCache('did:plc:abc123');

    expect(result).not.toBeNull();
    expect(result!.doc).toEqual(sampleDoc);
    expect(result!.did).toBe('did:plc:abc123');
    expect(result!.stale).toBe(false);
    expect(result!.expired).toBe(false);
  });

  it('returns null when no entry exists', async () => {
    const { db } = createFakeDb();
    const cache = new PostgresDidCache(db);

    expect(await cache.checkCache('did:plc:nope')).toBeNull();
  });

  it('flags entries past staleTTL as stale but not expired', async () => {
    const { db } = createFakeDb();
    const cache = new PostgresDidCache(db, { staleTTL: 10, maxTTL: 60_000 });

    await cache.cacheDid('did:plc:abc123', sampleDoc);
    vi.advanceTimersByTime(25);

    const result = await cache.checkCache('did:plc:abc123');
    expect(result!.stale).toBe(true);
    expect(result!.expired).toBe(false);
  });

  it('flags entries past maxTTL as expired', async () => {
    const { db } = createFakeDb();
    const cache = new PostgresDidCache(db, { staleTTL: 5, maxTTL: 10 });

    await cache.cacheDid('did:plc:abc123', sampleDoc);
    vi.advanceTimersByTime(25);

    const result = await cache.checkCache('did:plc:abc123');
    expect(result!.expired).toBe(true);
  });

  it('upserts on subsequent cacheDid calls (same did)', async () => {
    const { db, rows } = createFakeDb();
    const cache = new PostgresDidCache(db);

    await cache.cacheDid('did:plc:abc123', sampleDoc);
    const updated: DidDocument = { ...sampleDoc, alsoKnownAs: ['at://updated.example.com'] };
    await cache.cacheDid('did:plc:abc123', updated);

    expect(rows.size).toBe(1);
    const result = await cache.checkCache('did:plc:abc123');
    expect(result!.doc).toEqual(updated);
  });

  it('clearEntry removes the cached document', async () => {
    const { db } = createFakeDb();
    const cache = new PostgresDidCache(db);

    await cache.cacheDid('did:plc:abc123', sampleDoc);
    await cache.clearEntry('did:plc:abc123');

    expect(await cache.checkCache('did:plc:abc123')).toBeNull();
  });

  it('refreshCache writes the document returned by getDoc', async () => {
    const { db } = createFakeDb();
    const cache = new PostgresDidCache(db);

    await cache.refreshCache('did:plc:abc123', async () => sampleDoc);
    const result = await cache.checkCache('did:plc:abc123');
    expect(result!.doc).toEqual(sampleDoc);
  });

  it('refreshCache clears the entry when getDoc returns null', async () => {
    const { db } = createFakeDb();
    const cache = new PostgresDidCache(db);

    await cache.cacheDid('did:plc:abc123', sampleDoc);
    await cache.refreshCache('did:plc:abc123', async () => null);

    expect(await cache.checkCache('did:plc:abc123')).toBeNull();
  });

  it('cleanupExpired removes only entries past expires_at', async () => {
    const { db, rows } = createFakeDb();
    const cache = new PostgresDidCache(db, { staleTTL: 5, maxTTL: 10 });

    await cache.cacheDid('did:plc:soon-expired', sampleDoc);
    vi.advanceTimersByTime(25);

    // Insert a fresh entry (long maxTTL) that should survive the sweep.
    const freshCache = new PostgresDidCache(db, { staleTTL: 5_000, maxTTL: 60_000 });
    await freshCache.cacheDid('did:plc:fresh', sampleDoc);

    const removed = await cache.cleanupExpired();
    expect(removed).toBe(1);
    expect(rows.has('did:plc:fresh')).toBe(true);
    expect(rows.has('did:plc:soon-expired')).toBe(false);
  });
});
