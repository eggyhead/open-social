/**
 * CIMD (Client ID Metadata Document) verification.
 *
 * Fetches and caches a client's identity document from their domain,
 * extracting the public key used for HTTP Message Signature verification.
 *
 * Supports both CIMD-style documents (client-metadata.json) and
 * did:web documents with verification relationships.
 *
 * @see https://client.dev/
 * @see https://www.w3.org/TR/cid-1.0/#dfn-verification-relationship
 */

import crypto from 'crypto';
import { logger } from './logger';
import { TtlCache } from './cache';

// Cache CIMD documents for 5 minutes, refetch on verification failure
const CIMD_CACHE_TTL_MS = 5 * 60 * 1000;
const CIMD_CACHE_MAX = 200;

const cimdCache = new TtlCache<CimdDocument>(CIMD_CACHE_TTL_MS, CIMD_CACHE_MAX);

export interface CimdDocument {
  /** The client/app identifier (URL or DID) */
  clientId: string;
  /** JWK-format public key for signature verification */
  publicKeyJwk: JsonWebKey;
  /** When this document was fetched */
  fetchedAt: number;
}

export interface JsonWebKey {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  alg?: string;
  kid?: string;
  use?: string;
}

/**
 * Fetch a CIMD document from the app's domain.
 *
 * Tries two well-known locations:
 * 1. https://{domain}/.well-known/client-metadata.json (CIMD)
 * 2. https://{domain}/.well-known/did.json (did:web)
 */
export async function fetchCimdDocument(domain: string): Promise<CimdDocument | null> {
  // Try CIMD first
  const cimdUrl = `https://${domain}/.well-known/client-metadata.json`;
  try {
    const res = await fetch(cimdUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });

    if (res.ok) {
      const doc = await res.json() as Record<string, any>;
      const jwk = extractPublicKeyFromCimd(doc);
      if (jwk) {
        return {
          clientId: doc.client_id || `https://${domain}`,
          publicKeyJwk: jwk,
          fetchedAt: Date.now(),
        };
      }
    }
  } catch (err) {
    logger.debug({ domain, err }, 'CIMD fetch failed, trying did:web');
  }

  // Fall back to did:web
  const didUrl = `https://${domain}/.well-known/did.json`;
  try {
    const res = await fetch(didUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });

    if (res.ok) {
      const doc = await res.json() as Record<string, any>;
      const jwk = extractPublicKeyFromDidDoc(doc);
      if (jwk) {
        return {
          clientId: doc.id || `did:web:${domain}`,
          publicKeyJwk: jwk,
          fetchedAt: Date.now(),
        };
      }
    }
  } catch (err) {
    logger.debug({ domain, err }, 'did:web fetch also failed');
  }

  return null;
}

/**
 * Get a CIMD document, using cache when available.
 * Pass `forceRefresh: true` to bypass cache (e.g., after verification failure).
 */
export async function getCimdDocument(
  domain: string,
  forceRefresh = false
): Promise<CimdDocument | null> {
  if (!forceRefresh) {
    const cached = cimdCache.get(domain);
    if (cached) return cached;
  }

  const doc = await fetchCimdDocument(domain);
  if (doc) {
    cimdCache.set(domain, doc);
  }
  return doc;
}

/**
 * Clear the CIMD cache for a domain (used after verification failure
 * to force a refetch on next attempt).
 */
export function invalidateCimdCache(domain: string): void {
  cimdCache.invalidate(domain);
}

/** Reset entire cache (for testing). */
export function clearCimdCache(): void {
  cimdCache.clear();
}

// ── Key extraction helpers ──────────────────────────────────────────

/**
 * Extract public key JWK from a CIMD document.
 * Looks for jwks.keys[] with use=sig, or the first key.
 */
function extractPublicKeyFromCimd(doc: any): JsonWebKey | null {
  if (!doc) return null;

  // Direct jwks field
  if (doc.jwks?.keys?.length) {
    const sigKey = doc.jwks.keys.find((k: any) => k.use === 'sig') || doc.jwks.keys[0];
    return sigKey;
  }

  // Single key
  if (doc.public_key_jwk) {
    return doc.public_key_jwk;
  }

  return null;
}

/**
 * Extract public key JWK from a DID document.
 * Looks in verificationMethod[] for JsonWebKey2020 or similar.
 *
 * @see https://www.w3.org/TR/cid-1.0/#dfn-verification-relationship
 */
function extractPublicKeyFromDidDoc(doc: any): JsonWebKey | null {
  if (!doc?.verificationMethod?.length) return null;

  for (const vm of doc.verificationMethod) {
    if (vm.publicKeyJwk) {
      return vm.publicKeyJwk;
    }
  }

  return null;
}

/**
 * Import a JWK into a Node.js KeyObject for cryptographic operations.
 */
export function jwkToKeyObject(jwk: JsonWebKey): crypto.KeyObject {
  return crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
}
