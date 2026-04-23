import { Agent } from '@atproto/api';
import { Router, type Request, type Response } from 'express';
import { getIronSession } from 'iron-session';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodeOAuthClient } from '@atproto/oauth-client-node';
import { config } from '../config';
import { resolveHandleToDid, resolvePdsEndpoint } from '../services/atproto';
import { logger } from '../lib/logger';
import { z } from 'zod';

type Session = { did?: string };

const sessionOptions = {
  cookieName: 'sid',
  password: config.cookieSecret,
  cookieOptions: {
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    httpOnly: true,
    path: '/',
  },
};

async function getSessionAgent(
  req: IncomingMessage,
  res: ServerResponse,
  oauthClient: NodeOAuthClient
) {
  res.setHeader('Vary', 'Cookie');
  const session = await getIronSession<Session>(req, res, sessionOptions);
  if (!session.did) return null;
  try {
    const oauthSession = await oauthClient.restore(session.did);
    return oauthSession ? new Agent(oauthSession) : null;
  } catch (err) {
    logger.warn({ error: err }, 'OAuth restore failed');
    await session.destroy();
    return null;
  }
}

const EVENT_COLLECTION = 'community.lexicon.calendar.event';

const resolveEventSchema = z.object({
  handle: z.string().min(1),
  rkey: z.string().min(1),
});

function parseEventMode(value: unknown): 'in-person' | 'virtual' | 'hybrid' {
  const s = String(value ?? '').replace('#', '');
  if (s === 'inperson' || s === 'in-person') return 'in-person';
  if (s === 'virtual') return 'virtual';
  if (s === 'hybrid') return 'hybrid';
  return 'virtual';
}

function extractEventLocation(locations: unknown): string | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  const loc = locations[0] as Record<string, unknown>;

  if (loc.locality || loc.region || loc.country) {
    return [loc.locality, loc.region, loc.country].filter(Boolean).join(', ');
  }
  if (loc.latitude !== undefined && loc.longitude !== undefined) {
    if (typeof loc.name === 'string' && loc.name.length > 0) return loc.name;
    return `${loc.latitude}, ${loc.longitude}`;
  }
  if (typeof loc.name === 'string') return loc.name;
  return undefined;
}

/**
 * Extract the best external URL from a community.lexicon.calendar.event's uris array.
 * Prefers URIs named "OpenMeet Event" or similar, then falls back to the first http(s) URI.
 */
function extractEventUrl(uris: unknown): string | undefined {
  if (!Array.isArray(uris) || uris.length === 0) return undefined;

  // Prefer a named event page link (OpenMeet, etc.)
  const eventPage = uris.find(
    (u: any) =>
      typeof u?.uri === 'string' &&
      u.uri.startsWith('http') &&
      typeof u?.name === 'string' &&
      /event/i.test(u.name) &&
      !/image/i.test(u.name),
  );
  if (eventPage) return (eventPage as any).uri;

  // Fallback: first http(s) URI that isn't an image
  const fallback = uris.find(
    (u: any) =>
      typeof u?.uri === 'string' &&
      u.uri.startsWith('http') &&
      !/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(u.uri),
  );
  if (fallback) return (fallback as any).uri;

  return undefined;
}

export function createEventsRouter(oauthClient: NodeOAuthClient): Router {
  const router = Router();

  // ─── Resolve an event by handle + rkey ──────────────────────────
  router.get('/resolve', async (req: Request, res: Response) => {
    try {
      const agent = await getSessionAgent(req, res, oauthClient);
      if (!agent) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const parsed = resolveEventSchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'handle and rkey query parameters are required' });
      }

      const { handle, rkey } = parsed.data;

      // Resolve handle to DID
      let did: string;
      try {
        did = handle.startsWith('did:') ? handle : await resolveHandleToDid(handle);
      } catch {
        return res.status(404).json({ error: `Could not resolve handle "${handle}"` });
      }

      // Resolve DID to PDS and fetch the event record
      const pdsHost = await resolvePdsEndpoint(did, config.pdsUrl);

      const recordUrl = new URL(`${pdsHost}/xrpc/com.atproto.repo.getRecord`);
      recordUrl.searchParams.set('repo', did);
      recordUrl.searchParams.set('collection', EVENT_COLLECTION);
      recordUrl.searchParams.set('rkey', rkey);

      const recordRes = await fetch(recordUrl.toString());
      if (!recordRes.ok) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const record = await recordRes.json() as { uri: string; cid: string; value: any };
      const v = record.value;

      return res.json({
        uri: record.uri,
        cid: record.cid,
        name: (v.name as string) || 'Untitled Event',
        startsAt: v.startsAt || undefined,
        endsAt: v.endsAt || undefined,
        description: v.description || undefined,
        mode: parseEventMode(v.mode),
        location: extractEventLocation(v.locations),
        status: (v.status as string) || 'scheduled',
        eventUrl: extractEventUrl(v.uris),
      });
    } catch (err) {
      logger.error({ error: err }, 'Failed to resolve event');
      return res.status(500).json({ error: 'Failed to resolve event' });
    }
  });

  return router;
}
