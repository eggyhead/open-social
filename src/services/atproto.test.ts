/**
 * Unit tests for atproto.ts identity resolution helpers.
 *
 * Focuses on the behaviour we layer on top of `@atproto/identity`:
 *   - resolvePdsEndpoint(): extracts the PDS endpoint and falls back gracefully
 *   - resolveHandleToDid(): performs bidirectional handle <-> DID verification
 *   - ensureServiceUrl(): adds a scheme when missing
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  ensureServiceUrl,
  resolvePdsEndpoint,
  resolveAuthServer,
  resolveHandleToDid,
  setOAuthClient,
  didResolver,
  handleResolver,
} from './atproto';

describe('ensureServiceUrl', () => {
  it('prepends https:// when no scheme is present', () => {
    expect(ensureServiceUrl('pds.example.com')).toBe('https://pds.example.com');
  });

  it('leaves http:// URLs untouched', () => {
    expect(ensureServiceUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('leaves https:// URLs untouched', () => {
    expect(ensureServiceUrl('https://pds.example.com')).toBe('https://pds.example.com');
  });
});

describe('resolvePdsEndpoint', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the #atproto_pds service endpoint from the DID document', async () => {
    vi.spyOn(didResolver, 'resolve').mockResolvedValue({
      id: 'did:plc:abc123',
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: 'https://pds.example.com',
        },
      ],
    } as never);

    const pds = await resolvePdsEndpoint('did:plc:abc123');
    expect(pds).toBe('https://pds.example.com');
  });

  it('supports did:web identities (anything DidResolver returns)', async () => {
    vi.spyOn(didResolver, 'resolve').mockResolvedValue({
      id: 'did:web:example.com',
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: 'https://pds.example.com',
        },
      ],
    } as never);

    const pds = await resolvePdsEndpoint('did:web:example.com');
    expect(pds).toBe('https://pds.example.com');
  });

  it('falls back to the provided fallback URL on resolution failure', async () => {
    vi.spyOn(didResolver, 'resolve').mockRejectedValue(new Error('boom'));

    const pds = await resolvePdsEndpoint('did:plc:abc123', 'pds.fallback.example');
    expect(pds).toBe('https://pds.fallback.example');
  });

  it('falls back when no PDS service is found in the document', async () => {
    vi.spyOn(didResolver, 'resolve').mockResolvedValue({
      id: 'did:plc:abc123',
      service: [],
    } as never);

    const pds = await resolvePdsEndpoint('did:plc:abc123', 'https://pds.fallback.example');
    expect(pds).toBe('https://pds.fallback.example');
  });

  it('throws when resolution fails and no fallback is provided', async () => {
    vi.spyOn(didResolver, 'resolve').mockResolvedValue(null);

    await expect(resolvePdsEndpoint('did:plc:abc123')).rejects.toThrow(/Could not resolve PDS/);
  });
});

describe('resolveHandleToDid', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the DID when the DID document confirms the handle (bidirectional)', async () => {
    vi.spyOn(handleResolver, 'resolve').mockResolvedValue('did:plc:abc123');
    vi.spyOn(didResolver, 'resolve').mockResolvedValue({
      id: 'did:plc:abc123',
      alsoKnownAs: ['at://alice.example.com'],
    } as never);

    const did = await resolveHandleToDid('alice.example.com');
    expect(did).toBe('did:plc:abc123');
  });

  it('strips a leading @ and is case-insensitive', async () => {
    vi.spyOn(handleResolver, 'resolve').mockResolvedValue('did:plc:abc123');
    vi.spyOn(didResolver, 'resolve').mockResolvedValue({
      id: 'did:plc:abc123',
      alsoKnownAs: ['at://alice.example.com'],
    } as never);

    const did = await resolveHandleToDid('@Alice.Example.com');
    expect(did).toBe('did:plc:abc123');
  });

  it('throws if the DID document does not claim the handle (rejects spoofing)', async () => {
    vi.spyOn(handleResolver, 'resolve').mockResolvedValue('did:plc:abc123');
    vi.spyOn(didResolver, 'resolve').mockResolvedValue({
      id: 'did:plc:abc123',
      alsoKnownAs: ['at://someone-else.example.com'],
    } as never);

    await expect(resolveHandleToDid('alice.example.com')).rejects.toThrow(/Handle verification failed/);
  });

  it('throws if the handle cannot be resolved to any DID', async () => {
    vi.spyOn(handleResolver, 'resolve').mockResolvedValue(undefined);

    await expect(resolveHandleToDid('nope.example.com')).rejects.toThrow(/Could not resolve handle/);
  });
});

describe('resolveAuthServer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset to "no client registered" state at the top of each test.
    setOAuthClient(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setOAuthClient(null);
  });

  it('returns the auth server issuer discovered via OAuthResolver for a DID', async () => {
    const resolveSpy = vi.fn().mockResolvedValue({
      metadata: { issuer: 'https://entryway.example.com' },
    });
    setOAuthClient({
      oauthResolver: { resolve: resolveSpy, resolveFromService: vi.fn() },
    } as never);

    const url = await resolveAuthServer('did:plc:abc123');
    expect(url).toBe('https://entryway.example.com');
    expect(resolveSpy).toHaveBeenCalledWith('did:plc:abc123');
  });

  it('uses resolveFromService when given a PDS URL', async () => {
    const resolveFromServiceSpy = vi.fn().mockResolvedValue({
      metadata: { issuer: 'https://entryway.example.com' },
    });
    setOAuthClient({
      oauthResolver: { resolve: vi.fn(), resolveFromService: resolveFromServiceSpy },
    } as never);

    const url = await resolveAuthServer('https://pds.example.com');
    expect(url).toBe('https://entryway.example.com');
    expect(resolveFromServiceSpy).toHaveBeenCalledWith('https://pds.example.com');
  });

  it('falls back to the PDS endpoint when the OAuth resolver fails', async () => {
    const resolveSpy = vi.fn().mockRejectedValue(new Error('boom'));
    setOAuthClient({
      oauthResolver: { resolve: resolveSpy, resolveFromService: vi.fn() },
    } as never);
    vi.spyOn(didResolver, 'resolve').mockResolvedValue({
      id: 'did:plc:abc123',
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: 'https://pds.example.com',
        },
      ],
    } as never);

    const url = await resolveAuthServer('did:plc:abc123', 'pds.fallback.example');
    expect(url).toBe('https://pds.example.com');
  });

  it('falls back to the PDS endpoint when no OAuth client is registered (single-PDS deployment)', async () => {
    vi.spyOn(didResolver, 'resolve').mockResolvedValue({
      id: 'did:plc:abc123',
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: 'https://pds.example.com',
        },
      ],
    } as never);

    const url = await resolveAuthServer('did:plc:abc123');
    expect(url).toBe('https://pds.example.com');
  });

  it('returns the supplied service URL as a fallback when no client is registered', async () => {
    const url = await resolveAuthServer('https://pds.example.com');
    expect(url).toBe('https://pds.example.com');
  });
});
