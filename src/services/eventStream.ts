import crypto from 'crypto';
import type { Kysely } from 'kysely';
import type { Database, EventLogEntry } from '../db';
import type { WebhookEvent } from './webhook';
import { logger } from '../lib/logger';

const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EVENT_LOG_MAX_AGE_DAYS = 7;

export function createEventStreamService(db: Kysely<Database>) {
  /**
   * Generate a signed stream URL token for an authenticated app.
   * The token is single-use and expires after 5 minutes.
   */
  async function createStreamToken(appId: number, communityDid?: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + STREAM_TOKEN_TTL_MS);

    await db.insertInto('stream_tokens').values({
      token,
      app_id: appId,
      community_did: communityDid ?? null,
      expires_at: expiresAt,
    }).execute();

    return token;
  }

  /**
   * Validate and consume a stream token atomically. Returns the token record
   * if valid, null otherwise. Uses DELETE...RETURNING to prevent race conditions.
   */
  async function consumeStreamToken(token: string) {
    const row = await db
      .deleteFrom('stream_tokens')
      .where('token', '=', token)
      .where('expires_at', '>', new Date())
      .returning(['id', 'token', 'app_id', 'community_did', 'expires_at', 'created_at'])
      .executeTakeFirst();

    return row ?? null;
  }

  /**
   * Log an event to the event_log table for cursor-based resumption.
   * Returns the event's sequential ID (cursor).
   */
  async function logEvent(
    eventType: WebhookEvent,
    communityDid: string,
    data: Record<string, any>
  ): Promise<number> {
    const result = await db
      .insertInto('event_log')
      .values({
        event_type: eventType,
        community_did: communityDid,
        payload: JSON.stringify({ ...data, communityDid }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return result.id as number;
  }

  /**
   * Fetch events after a given cursor (event ID) for replay on reconnection.
   * Optionally filtered by community DID.
   */
  async function getEventsSince(
    cursor: number,
    communityDid?: string,
    limit = 1000
  ): Promise<Array<{ id: number; event_type: string; community_did: string | null; payload: unknown; created_at: Date }>> {
    let query = db
      .selectFrom('event_log')
      .selectAll()
      .where('id', '>', cursor)
      .orderBy('id', 'asc')
      .limit(limit);

    if (communityDid) {
      query = query.where('community_did', '=', communityDid);
    }

    return await query.execute() as any;
  }

  /**
   * Prune old events beyond the retention window.
   */
  async function pruneOldEvents(): Promise<number> {
    const cutoff = new Date(Date.now() - EVENT_LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const result = await db
      .deleteFrom('event_log')
      .where('created_at', '<', cutoff)
      .executeTakeFirst();

    const deleted = Number(result.numDeletedRows);
    if (deleted > 0) {
      logger.info({ deleted, cutoffDate: cutoff.toISOString() }, 'Pruned old event log entries');
    }
    return deleted;
  }

  /**
   * Clean up expired stream tokens.
   */
  async function pruneExpiredTokens(): Promise<number> {
    const result = await db
      .deleteFrom('stream_tokens')
      .where('expires_at', '<', new Date())
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  return {
    createStreamToken,
    consumeStreamToken,
    logEvent,
    getEventsSince,
    pruneOldEvents,
    pruneExpiredTokens,
  };
}

export type EventStreamService = ReturnType<typeof createEventStreamService>;
