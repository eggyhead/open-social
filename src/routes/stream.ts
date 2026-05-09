import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { createVerifyApiKey, type AuthenticatedRequest } from '../middleware/auth';
import type { EventStreamService } from '../services/eventStream';

/**
 * Stream token endpoint.
 * Apps authenticate via API key or CIMD/HTTP Message Signatures,
 * then receive a short-lived token for WebSocket connection.
 */
export function createStreamRouter(db: Kysely<Database>, eventStreamService: EventStreamService): Router {
  const router = Router();
  const verifyApiKey = createVerifyApiKey(db);

  // POST /api/v1/stream/token — get a signed stream URL token
  router.post('/token', verifyApiKey, async (req: AuthenticatedRequest, res) => {
    try {
      const { communityDid } = req.body;

      const appRecord = await db
        .selectFrom('apps')
        .select('id')
        .where('app_id', '=', req.app_data!.app_id)
        .executeTakeFirst();

      if (!appRecord) {
        return res.status(404).json({ error: 'App not found' });
      }

      const token = await eventStreamService.createStreamToken(
        appRecord.id as number,
        communityDid
      );

      // Build the WebSocket URL
      const protocol = req.protocol === 'https' ? 'wss' : 'ws';
      const host = req.get('host');
      const wsUrl = `${protocol}://${host}/api/v1/stream?token=${token}`;

      return res.status(201).json({
        token,
        url: wsUrl,
        expiresIn: 300, // 5 minutes
        message: 'Connect to the WebSocket URL within 5 minutes. Pass ?cursor=<last-event-id> to resume from a previous position.',
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to create stream token' });
    }
  });

  return router;
}
