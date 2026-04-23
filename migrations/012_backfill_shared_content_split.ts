import { Kysely } from 'kysely';
import { BskyAgent } from '@atproto/api';

/**
 * Migration: Backfill existing `community.opensocial.sharedContent` records
 * into the new split collections (`sharedDocument` / `sharedEvent`).
 *
 * For each community:
 *  1. Authenticate with the community's PDS
 *  2. List all `community.opensocial.sharedContent` records
 *  3. For each record, resolve the URL and source from the referenced document/event
 *  4. Create the corresponding `sharedDocument` or `sharedEvent` record
 *
 * Original sharedContent records are left in place for backward compatibility.
 */

const OLD_COLLECTION = 'community.opensocial.sharedContent';
const SHARED_DOCUMENT_COLLECTION = 'community.opensocial.sharedDocument';
const SHARED_EVENT_COLLECTION = 'community.opensocial.sharedEvent';
const DOCUMENT_COLLECTION = 'site.standard.document';
const PUBLICATION_COLLECTION = 'site.standard.publication';
const LEAFLET_BASE = 'https://leaflet.pub/profile';
const SMOKESIGNAL_BASE = 'https://smokesignal.events';

function pdsServiceUrl(pdsHost: string): string {
  if (pdsHost.startsWith('http://') || pdsHost.startsWith('https://')) {
    return pdsHost;
  }
  return `https://${pdsHost}`;
}

async function decryptPassword(stored: string): Promise<string> {
  if (stored.startsWith('enc:') || stored.startsWith('v1:')) {
    try {
      const { decryptIfNeeded } = await import('../src/lib/crypto');
      return decryptIfNeeded(stored);
    } catch {
      return stored;
    }
  }
  return stored;
}

function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const stripped = uri.replace('at://', '');
  const [repo, collection, rkey] = stripped.split('/');
  return { repo, collection, rkey };
}

/**
 * Resolve DID to PDS endpoint via DID document.
 */
async function resolvePds(did: string): Promise<string | null> {
  try {
    let url: string;
    if (did.startsWith('did:plc:')) {
      url = `https://plc.directory/${did}`;
    } else if (did.startsWith('did:web:')) {
      const host = did.replace('did:web:', '');
      url = `https://${host}/.well-known/did.json`;
    } else {
      return null;
    }

    const res = await fetch(url);
    if (!res.ok) return null;
    const doc = await res.json() as any;

    const pdsService = doc.service?.find(
      (s: any) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
    );
    return pdsService?.serviceEndpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a single record from a PDS via unauthenticated XRPC.
 */
async function fetchRecord(
  pdsUrl: string,
  repo: string,
  collection: string,
  rkey: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.getRecord`);
    url.searchParams.set('repo', repo);
    url.searchParams.set('collection', collection);
    url.searchParams.set('rkey', rkey);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the best web URL for a site.standard.document record.
 */
async function resolveDocumentUrl(
  docValue: Record<string, unknown>,
  authorPds: string,
  repo: string,
  rkey: string,
): Promise<string> {
  const path = docValue.path as string | undefined;

  // Try to resolve publication base URL from the document's `site` field
  if (docValue.site && typeof docValue.site === 'string') {
    try {
      const siteParsed = parseAtUri(docValue.site);
      const pub = await fetchRecord(authorPds, siteParsed.repo, PUBLICATION_COLLECTION, siteParsed.rkey);
      const pubUrl = pub?.url as string | undefined;
      if (pubUrl && path) {
        const base = pubUrl.endsWith('/') ? pubUrl.slice(0, -1) : pubUrl;
        const segment = path.startsWith('/') ? path : `/${path}`;
        return `${base}${segment}`;
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Leaflet reader fallback
  return `${LEAFLET_BASE}/${repo}/${rkey}`;
}

/**
 * Detect source platform from the document's publication or collection.
 */
function detectDocumentSource(docValue: Record<string, unknown>, collection: string): string {
  // site.standard.document with a site field → check publication domain
  if (collection === DOCUMENT_COLLECTION && docValue.site && typeof docValue.site === 'string') {
    const siteUri = docValue.site as string;
    // WhiteWind uses a different collection, so site.standard → leaflet for now
    return 'leaflet';
  }
  if (collection === DOCUMENT_COLLECTION) {
    return 'leaflet';
  }
  return 'unknown';
}

/**
 * Extract the best URL from a community.lexicon.calendar.event's uris array.
 */
function extractEventUrl(uris: unknown[], did: string, rkey: string): string {
  if (!uris || uris.length === 0) {
    return `${SMOKESIGNAL_BASE}/${did}/${rkey}`;
  }

  // Priority 1: URI named with "Event" (OpenMeet, etc.)
  const eventPage = uris.find(
    (u: any) =>
      typeof u?.uri === 'string' &&
      u.uri.startsWith('http') &&
      typeof u?.name === 'string' &&
      /event/i.test(u.name) &&
      !/image/i.test(u.name),
  );
  if (eventPage) return (eventPage as any).uri;

  // Priority 2: First non-image http URI
  const fallback = uris.find(
    (u: any) =>
      typeof u?.uri === 'string' &&
      u.uri.startsWith('http') &&
      !/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(u.uri),
  );
  if (fallback) return (fallback as any).uri;

  // Smoke Signal fallback
  return `${SMOKESIGNAL_BASE}/${did}/${rkey}`;
}

/**
 * Detect source platform from event URIs.
 */
function detectEventSource(uris: unknown[]): string {
  if (!uris || uris.length === 0) return 'smokesignal';

  for (const u of uris) {
    if (typeof (u as any)?.uri !== 'string') continue;
    const uri = (u as any).uri as string;
    if (uri.includes('openmeet')) return 'openmeet';
    if (uri.includes('smokesignal')) return 'smokesignal';
  }

  return 'smokesignal';
}

export async function up(db: Kysely<any>): Promise<void> {
  const communities = await db
    .selectFrom('communities')
    .select(['did', 'handle', 'pds_host', 'app_password'])
    .execute();

  if (communities.length === 0) return;

  let migratedDocs = 0;
  let migratedEvents = 0;
  let skipped = 0;

  for (const community of communities) {
    try {
      const password = await decryptPassword(community.app_password);
      const agent = new BskyAgent({ service: pdsServiceUrl(community.pds_host) });
      await agent.login({
        identifier: community.handle,
        password,
      });

      // List all existing sharedContent records
      let cursor: string | undefined;
      const records: Array<{ uri: string; value: any }> = [];
      do {
        const response = await agent.api.com.atproto.repo.listRecords({
          repo: community.did,
          collection: OLD_COLLECTION,
          limit: 100,
          cursor,
        });
        records.push(...response.data.records.map((r: any) => ({ uri: r.uri, value: r.value })));
        cursor = response.data.cursor;
      } while (cursor);

      if (records.length === 0) continue;

      // Check for already-migrated records in new collections to avoid duplicates
      const existingDocUris = new Set<string>();
      const existingEventUris = new Set<string>();

      for (const col of [SHARED_DOCUMENT_COLLECTION, SHARED_EVENT_COLLECTION]) {
        let c2: string | undefined;
        const targetSet = col === SHARED_DOCUMENT_COLLECTION ? existingDocUris : existingEventUris;
        do {
          const resp = await agent.api.com.atproto.repo.listRecords({
            repo: community.did,
            collection: col,
            limit: 100,
            cursor: c2,
          });
          for (const r of resp.data.records) {
            targetSet.add((r.value as any).documentUri);
          }
          c2 = resp.data.cursor;
        } while (c2);
      }

      for (const record of records) {
        const v = record.value;
        const documentUri = v.documentUri as string;
        if (!documentUri) {
          skipped++;
          continue;
        }

        const parsed = parseAtUri(documentUri);
        const isEvent = v.type === 'event';
        const targetCollection = isEvent ? SHARED_EVENT_COLLECTION : SHARED_DOCUMENT_COLLECTION;
        const existingSet = isEvent ? existingEventUris : existingDocUris;

        // Skip if already migrated
        if (existingSet.has(documentUri)) {
          skipped++;
          continue;
        }

        try {
          // Resolve author PDS
          const authorPds = await resolvePds(parsed.repo);

          if (isEvent) {
            // Fetch event record for URL and source detection
            let url: string;
            let source: string;
            let author = parsed.repo;

            if (authorPds) {
              const eventDoc = await fetchRecord(authorPds, parsed.repo, parsed.collection, parsed.rkey);
              if (eventDoc) {
                url = extractEventUrl(eventDoc.uris as unknown[], parsed.repo, parsed.rkey);
                source = detectEventSource(eventDoc.uris as unknown[]);
              } else {
                url = `${SMOKESIGNAL_BASE}/${parsed.repo}/${parsed.rkey}`;
                source = 'unknown';
              }
            } else {
              url = `${SMOKESIGNAL_BASE}/${parsed.repo}/${parsed.rkey}`;
              source = 'unknown';
            }

            await agent.api.com.atproto.repo.createRecord({
              repo: community.did,
              collection: SHARED_EVENT_COLLECTION,
              record: {
                $type: SHARED_EVENT_COLLECTION,
                documentUri,
                documentCid: v.documentCid,
                sharedBy: v.sharedBy,
                title: v.title || 'Untitled Event',
                url,
                source,
                author,
                ...(v.path ? { path: v.path } : {}),
                ...(v.startsAt ? { startsAt: v.startsAt } : {}),
                ...(v.endsAt ? { endsAt: v.endsAt } : {}),
                ...(v.location ? { location: v.location } : {}),
                ...(v.mode ? { mode: v.mode } : {}),
                sharedAt: v.sharedAt || new Date().toISOString(),
              },
            });
            migratedEvents++;
          } else {
            // Document: resolve URL from publication chain
            let url: string;
            let source: string;
            let author = parsed.repo;

            if (authorPds) {
              const doc = await fetchRecord(authorPds, parsed.repo, parsed.collection, parsed.rkey);
              if (doc) {
                url = await resolveDocumentUrl(doc, authorPds, parsed.repo, parsed.rkey);
                source = detectDocumentSource(doc, parsed.collection);
              } else {
                url = `${LEAFLET_BASE}/${parsed.repo}/${parsed.rkey}`;
                source = 'unknown';
              }
            } else {
              url = `${LEAFLET_BASE}/${parsed.repo}/${parsed.rkey}`;
              source = 'unknown';
            }

            await agent.api.com.atproto.repo.createRecord({
              repo: community.did,
              collection: SHARED_DOCUMENT_COLLECTION,
              record: {
                $type: SHARED_DOCUMENT_COLLECTION,
                documentUri,
                documentCid: v.documentCid,
                sharedBy: v.sharedBy,
                title: v.title || 'Untitled',
                url,
                source,
                author,
                ...(v.path ? { path: v.path } : {}),
                sharedAt: v.sharedAt || new Date().toISOString(),
              },
            });
            migratedDocs++;
          }
        } catch (err) {
          console.warn(`Skipping record ${record.uri}: ${err}`);
          skipped++;
        }
      }
    } catch (err) {
      console.warn(`Skipping community ${community.did}: ${err}`);
    }
  }

  console.log(
    `Migration complete: ${migratedDocs} documents, ${migratedEvents} events migrated, ${skipped} skipped`,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  // Delete all records in the new collections for every community.
  // The original sharedContent records are untouched.
  const communities = await db
    .selectFrom('communities')
    .select(['did', 'handle', 'pds_host', 'app_password'])
    .execute();

  for (const community of communities) {
    try {
      const password = await decryptPassword(community.app_password);
      const agent = new BskyAgent({ service: pdsServiceUrl(community.pds_host) });
      await agent.login({
        identifier: community.handle,
        password,
      });

      for (const collection of [SHARED_DOCUMENT_COLLECTION, SHARED_EVENT_COLLECTION]) {
        let cursor: string | undefined;
        do {
          const response = await agent.api.com.atproto.repo.listRecords({
            repo: community.did,
            collection,
            limit: 100,
            cursor,
          });

          for (const record of response.data.records) {
            const rkey = record.uri.split('/').pop()!;
            await agent.api.com.atproto.repo.deleteRecord({
              repo: community.did,
              collection,
              rkey,
            });
          }

          cursor = response.data.cursor;
        } while (cursor);
      }
    } catch (err) {
      console.warn(`Skipping community ${community.did} during rollback: ${err}`);
    }
  }
}
