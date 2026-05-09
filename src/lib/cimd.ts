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
 * Validate that a URL is safe to fetch (SSRF protection).
 * - Must be https
 * - Must not target localhost, private IPs, or link-local addresses
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();
    // Block localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
    // Block private IP ranges
    if (/^10\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    // Block link-local
    if (/^169\.254\./.test(hostname)) return false;
    if (hostname.startsWith('fe80:')) return false;
    // Block 0.0.0.0
    if (hostname === '0.0.0.0') return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a CIMD document from the app's domain or a custom URL.
 *
 * When `cimdUrl` is provided, validates it for SSRF safety then fetches directly.
 * Otherwise tries two well-known locations:
 * 1. https://{domain}/.well-known/client-metadata.json (CIMD)
 * 2. https://{domain}/.well-known/did.json (did:web)
 */
export async function fetchCimdDocument(
  domain: string,
  cimdUrl?: string | null,
): Promise<CimdDocument | null> {
  const urlsToTry: Array<{ url: string; type: 'cimd' | 'did' }> = [];

  if (cimdUrl) {
    if (!isSafeUrl(cimdUrl)) {
      logger.warn({ domain, cimdUrl }, 'Rejecting unsafe CIMD URL');
      return null;
    }
    const isDid = cimdUrl.includes('did.json');
    urlsToTry.push({ url: cimdUrl, type: isDid ? 'did' : 'cimd' });
  }

  // Well-known fallbacks are always https://{domain}/...
  urlsToTry.push(
    { url: `https://${domain}/.well-known/client-metadata.json`, type: 'cimd' },
    { url: `https://${domain}/.well-known/did.json`, type: 'did' },
  );

  for (const { url, type } of urlsToTry) {
    if (!isSafeUrl(url)) continue;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) continue;

      const doc = await res.json() as Record<string, any>;
      const jwk = type === 'cimd'
        ? extractPublicKeyFromCimd(doc)
        : extractPublicKeyFromDidDoc(doc);

      if (jwk) {
        return {
          clientId: type === 'cimd'
            ? (doc.client_id || `https://${domain}`)
            : (doc.id || `did:web:${domain}`),
          publicKeyJwk: jwk,
          fetchedAt: Date.now(),
        };
      }
    } catch (err) {
      logger.debug({ domain, url, err }, `${type} fetch failed`);
    }
  }

  return null;
}

/**
 * Get a CIMD document, using cache when available.
 * Pass `forceRefresh: true` to bypass cache (e.g., after verification failure).
 */
export async function getCimdDocument(
  domain: string,
  forceRefresh = false,
  cimdUrl?: string | null,
): Promise<CimdDocument | null> {
  if (!forceRefresh) {
    const cached = cimdCache.get(domain);
    if (cached) return cached;
  }

  const doc = await fetchCimdDocument(domain, cimdUrl);
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
 *
 * Only returns keys that are referenced by an `authentication` or
 * `assertionMethod` verification relationship, per the W3C CID spec.
 * Falls back to the first verificationMethod only if no relationships
 * are declared (simple DID documents).
 *
 * @see https://www.w3.org/TR/cid-1.0/#dfn-verification-relationship
 */
function extractPublicKeyFromDidDoc(doc: any): JsonWebKey | null {
  if (!doc?.verificationMethod?.length) return null;

  // Build a set of method IDs referenced by authentication or assertionMethod
  const allowedIds = new Set<string>();
  for (const rel of ['authentication', 'assertionMethod']) {
    const refs = doc[rel];
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (typeof ref === 'string') {
          allowedIds.add(ref);
        } else if (ref?.id) {
          allowedIds.add(ref.id);
        }
      }
    }
  }

  // If relationships exist, only use keys referenced by them
  if (allowedIds.size > 0) {
    for (const vm of doc.verificationMethod) {
      if (vm.publicKeyJwk && allowedIds.has(vm.id)) {
        return vm.publicKeyJwk;
      }
    }
    return null;
  }

  // Fallback for simple documents with no explicit relationships
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
