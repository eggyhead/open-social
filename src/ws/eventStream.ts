import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { EventStreamService } from '../services/eventStream';
import type { WebhookEvent } from '../services/webhook';
import { logger } from '../lib/logger';

interface StreamClient {
  ws: WebSocket;
  appId: number;
  communityDid: string | null;
  lastCursor: number;
}

/**
 * Create and attach a WebSocket event stream to the HTTP server.
 *
 * Clients connect via:
 *   ws://host/api/v1/stream?token=<stream-token>[&cursor=<last-event-id>]
 *
 * The token is obtained from POST /api/v1/stream/token (authenticated via API key or CIMD).
 * Once connected, the server pushes events as JSON frames:
 *   { id: number, type: string, timestamp: string, data: {...} }
 *
 * If a cursor is provided, all events since that cursor are replayed before live streaming begins.
 */
export function createEventStream(
  server: Server,
  eventStreamService: EventStreamService
) {
  const clients = new Set<StreamClient>();

  const wss = new WebSocketServer({
    server,
    path: '/api/v1/stream',
    verifyClient: async (info, callback) => {
      try {
        const url = new URL(info.req.url ?? '', `http://${info.req.headers.host}`);
        const token = url.searchParams.get('token');

        if (!token) {
          callback(false, 401, 'Missing stream token');
          return;
        }

        const tokenRecord = await eventStreamService.consumeStreamToken(token);
        if (!tokenRecord) {
          callback(false, 401, 'Invalid or expired stream token');
          return;
        }

        // Attach token info to the request for use in connection handler
        (info.req as any)._streamAuth = {
          appId: tokenRecord.app_id,
          communityDid: tokenRecord.community_did,
        };

        callback(true);
      } catch (err) {
        logger.error({ error: err }, 'Stream token verification failed');
        callback(false, 500, 'Internal error');
      }
    },
  });

  wss.on('connection', async (ws, req) => {
    const auth = (req as any)._streamAuth as { appId: number; communityDid: string | null };
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const cursorParam = url.searchParams.get('cursor');
    const parsedCursor = cursorParam ? parseInt(cursorParam, 10) : 0;
    const cursor = Number.isFinite(parsedCursor) && parsedCursor > 0 ? parsedCursor : 0;

    const client: StreamClient = {
      ws,
      appId: auth.appId,
      communityDid: auth.communityDid,
      lastCursor: cursor,
    };

    clients.add(client);

    logger.info({
      appId: auth.appId,
      communityDid: auth.communityDid,
      cursor,
      totalClients: clients.size,
    }, 'Event stream client connected');

    // Replay missed events if cursor provided
    if (cursor > 0) {
      try {
        const missed = await eventStreamService.getEventsSince(
          cursor,
          auth.communityDid ?? undefined
        );

        for (const event of missed) {
          if (ws.readyState !== WebSocket.OPEN) break;

          // Parse payload if stored as JSON string to ensure consistent frame format
          const data = typeof event.payload === 'string'
            ? JSON.parse(event.payload)
            : event.payload;

          ws.send(JSON.stringify({
            id: event.id,
            type: event.event_type,
            timestamp: event.created_at,
            data,
          }));

          client.lastCursor = event.id as number;
        }

        if (missed.length > 0) {
          logger.info({
            appId: auth.appId,
            replayed: missed.length,
            fromCursor: cursor,
            toCursor: client.lastCursor,
          }, 'Replayed missed events');
        }
      } catch (err) {
        logger.error({ error: err, appId: auth.appId }, 'Failed to replay missed events');
      }
    }

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('close', () => {
      clients.delete(client);
      clearInterval(heartbeat);
      logger.info({ appId: auth.appId, totalClients: clients.size }, 'Event stream client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ error: err, appId: auth.appId }, 'Event stream client error');
      clients.delete(client);
      clearInterval(heartbeat);
    });

    ws.on('pong', () => {
      // Connection is alive
    });
  });

  /**
   * Broadcast an event to all connected stream clients.
   */
  async function broadcast(event: WebhookEvent, communityDid: string, data: Record<string, any>) {
    let eventId: number;
    try {
      eventId = await eventStreamService.logEvent(event, communityDid, data);
    } catch (err) {
      logger.error({ error: err, event, communityDid }, 'Failed to log event for stream');
      return;
    }

    const message = JSON.stringify({
      id: eventId,
      type: event,
      timestamp: new Date().toISOString(),
      data: { ...data, communityDid },
    });

    for (const client of clients) {
      if (client.communityDid && client.communityDid !== communityDid) continue;

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
        client.lastCursor = eventId;
      }
    }
  }

  function close() {
    for (const client of clients) {
      client.ws.close(1001, 'Server shutting down');
    }
    clients.clear();
    wss.close();
  }

  return { broadcast, close, getClientCount: () => clients.size };
}

export type EventStream = ReturnType<typeof createEventStream>;
