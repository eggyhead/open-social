import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchCimdDocument,
  getCimdDocument,
  invalidateCimdCache,
  clearCimdCache,
  jwkToKeyObject,
} from './cimd';
import crypto from 'crypto';

// Generate a test EC key pair for verification
const testKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const testPublicJwk = testKeyPair.publicKey.export({ format: 'jwk' });

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  clearCimdCache();
  mockFetch.mockReset();
});

describe('fetchCimdDocument', () => {
  it('fetches and parses a CIMD document with jwks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        client_id: 'https://myapp.example.com',
        jwks: {
          keys: [{ ...testPublicJwk, use: 'sig' }],
        },
      }),
    });

    const doc = await fetchCimdDocument('myapp.example.com');

    expect(doc).not.toBeNull();
    expect(doc!.clientId).toBe('https://myapp.example.com');
    expect(doc!.publicKeyJwk.kty).toBe('EC');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('client-metadata.json');
  });

  it('fetches from did:web when CIMD fails', async () => {
    // First call (CIMD) fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    // Second call (did:web) succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'did:web:myapp.example.com',
        verificationMethod: [
          {
            id: 'did:web:myapp.example.com#key-1',
            type: 'JsonWebKey2020',
            publicKeyJwk: testPublicJwk,
          },
        ],
      }),
    });

    const doc = await fetchCimdDocument('myapp.example.com');

    expect(doc).not.toBeNull();
    expect(doc!.clientId).toBe('did:web:myapp.example.com');
    expect(doc!.publicKeyJwk.kty).toBe('EC');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null when both CIMD and did:web fail', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const doc = await fetchCimdDocument('unknown.example.com');
    expect(doc).toBeNull();
  });

  it('extracts public_key_jwk from CIMD', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        client_id: 'https://app.test',
        public_key_jwk: testPublicJwk,
      }),
    });

    const doc = await fetchCimdDocument('app.test');
    expect(doc).not.toBeNull();
    expect(doc!.publicKeyJwk.kty).toBe('EC');
  });
});

describe('getCimdDocument (caching)', () => {
  it('caches documents and returns from cache', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        client_id: 'https://cached.test',
        jwks: { keys: [testPublicJwk] },
      }),
    });

    const doc1 = await getCimdDocument('cached.test');
    const doc2 = await getCimdDocument('cached.test');

    expect(doc1).toBe(doc2); // Same reference
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only one fetch
  });

  it('refetches when forceRefresh is true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        client_id: 'https://refresh.test',
        jwks: { keys: [testPublicJwk] },
      }),
    });

    await getCimdDocument('refresh.test');
    await getCimdDocument('refresh.test', true);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('refetches after cache invalidation', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        client_id: 'https://invalidate.test',
        jwks: { keys: [testPublicJwk] },
      }),
    });

    await getCimdDocument('invalidate.test');
    invalidateCimdCache('invalidate.test');
    await getCimdDocument('invalidate.test');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('jwkToKeyObject', () => {
  it('converts an EC JWK to a KeyObject', () => {
    const keyObj = jwkToKeyObject(testPublicJwk as any);
    expect(keyObj.type).toBe('public');
    expect(keyObj.asymmetricKeyType).toBe('ec');
  });

  it('converts an RSA JWK to a KeyObject', () => {
    const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaJwk = rsaKeyPair.publicKey.export({ format: 'jwk' });
    const keyObj = jwkToKeyObject(rsaJwk as any);
    expect(keyObj.type).toBe('public');
    expect(keyObj.asymmetricKeyType).toBe('rsa');
  });
});
