/**
 * Unit tests for the API key auth middleware.
 *
 * Regression coverage for an issue where keys returned by app registration
 * and key rotation were rejected on production: the middleware was selecting
 * the first active app from the database without filtering by which app the
 * supplied key belonged to, so it could only ever validate one app's keys.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Response, NextFunction } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import { createMockDb } from '../test/helpers';
import { hashApiKey } from '../lib/crypto';
import { createVerifyApiKey, type AuthenticatedRequest } from './auth';

function makeApp(overrides: Partial<Record<string, unknown>>) {
  return {
    id: 1,
    app_id: 'app-1',
    name: 'Test App',
    domain: 'test.example',
    creator_did: 'did:plc:test',
    api_key: 'SYSTEM_APP_NO_KEY',
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function mockAppsQuery(db: Kysely<Database>, apps: ReturnType<typeof makeApp>[]) {
  db.selectFrom = vi.fn().mockReturnValue({
    selectAll: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue(apps),
        }),
      }),
    }),
  });
}

// Shared sample raw keys for tests. Format mirrors the real format
// (`osc_` + 64 hex chars) produced by `crypto.randomBytes(32).toString('hex')`.
const SAMPLE_KEY_A = 'osc_' + 'a1b2c3d4e5f6071829304a5b6c7d8e9f'.repeat(2);
const SAMPLE_KEY_B = 'osc_' + 'fedcba9876543210112233445566778899aabbccddeeff00112233445566778'.slice(0, 64);

function makeReqRes(apiKey?: string) {
  const req = {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  } as unknown as AuthenticatedRequest;
  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnValue({ json }),
  } as unknown as Response;
  const next: NextFunction = vi.fn();
  return { req, res, next, json };
}

describe('createVerifyApiKey middleware', () => {
  it('rejects requests without an X-Api-Key header', async () => {
    const db = createMockDb();
    const middleware = createVerifyApiKey(db);
    const { req, res, next, json } = makeReqRes();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'API key or HTTP signature required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('authenticates the correct app when multiple active apps exist', async () => {
    // Regression: previously the middleware grabbed the first active app
    // (executeTakeFirst) and rejected all keys that did not belong to it.
    const db = createMockDb();
    const keyA = SAMPLE_KEY_A;
    const keyB = SAMPLE_KEY_B;
    const appA = makeApp({ app_id: 'app-a', api_key: hashApiKey(keyA) });
    const appB = makeApp({ app_id: 'app-b', api_key: hashApiKey(keyB) });

    mockAppsQuery(db, [appA, appB]);

    const middleware = createVerifyApiKey(db);
    const { req, res, next } = makeReqRes(keyB);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.app_data?.app_id).toBe('app-b');
  });

  it('rejects an unknown key even when active apps exist', async () => {
    const db = createMockDb();
    const realKey = SAMPLE_KEY_A;
    const app = makeApp({ api_key: hashApiKey(realKey) });
    mockAppsQuery(db, [app]);

    const middleware = createVerifyApiKey(db);
    const { req, res, next, json } = makeReqRes('osc_wrong');

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    expect(next).not.toHaveBeenCalled();
  });

  it('sets auth_method to api_key on successful API key auth', async () => {
    const db = createMockDb();
    const realKey = SAMPLE_KEY_A;
    const app = makeApp({ api_key: hashApiKey(realKey) });
    mockAppsQuery(db, [app]);

    const middleware = createVerifyApiKey(db);
    const { req, res, next } = makeReqRes(realKey);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth_method).toBe('api_key');
  });

  it('routes to HTTP signature verification when Signature-Input header is present', async () => {
    const db = createMockDb();
    // Mock the DB query for signature path (uses or() clause)
    db.selectFrom = vi.fn().mockReturnValue({
      selectAll: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
      }),
    });

    const middleware = createVerifyApiKey(db);
    const req = {
      headers: {
        'signature-input': 'sig1=("@method");keyid="unknown-app"',
        'signature': 'sig1=:abc:',
      },
    } as unknown as AuthenticatedRequest;
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as Response;
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    // Should attempt HTTP signature auth and fail because app not found
    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Unknown app' });
  });

  it('safely skips apps with sentinel/non-hash api_key values', async () => {
    // The system app row stores 'SYSTEM_APP_NO_KEY' as a sentinel — it must
    // never authenticate any request, but its presence must not prevent
    // legitimate apps that come after it from authenticating.
    const db = createMockDb();
    const realKey = SAMPLE_KEY_A;
    const systemApp = makeApp({ app_id: 'system', api_key: 'SYSTEM_APP_NO_KEY' });
    const realApp = makeApp({ app_id: 'real', api_key: hashApiKey(realKey) });

    mockAppsQuery(db, [systemApp, realApp]);

    const middleware = createVerifyApiKey(db);
    const { req, res, next } = makeReqRes(realKey);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.app_data?.app_id).toBe('real');
  });

  it('returns clear error when Signature-Input is present but Signature is missing', async () => {
    const db = createMockDb();
    const middleware = createVerifyApiKey(db);
    const req = {
      headers: {
        'signature-input': 'sig1=("@method");keyid="app-1"',
        // no 'signature' header
      },
    } as unknown as AuthenticatedRequest;
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as Response;
    const next: NextFunction = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: 'Signature-Input header present but Signature header is missing. Both are required.',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
