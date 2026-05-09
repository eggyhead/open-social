/**
 * Integration tests — auth flow (POST /login → GET /me → POST /logout)
 *
 * These tests use supertest against the real Express app with a test database.
 * The OAuth client is mocked so we don't need a live ATProto PDS.
 *
 * The open-social login endpoint initiates an OAuth redirect rather than
 * accepting credentials directly, so the "full session" flow is simulated by:
 *   1. Mocking the OAuth client's `restore()` to return a fake agent when
 *      the session already contains a DID.
 *   2. Directly seeding the iron-session cookie (via a helper endpoint added
 *      in test mode) so subsequent /me calls act as authenticated.
 *
 * What is tested:
 *   - POST /login with a valid handle returns a redirectUrl (OAuth initiation)
 *   - GET /me without a session cookie → 401
 *   - GET /me with a valid session (mocked OAuth restore) → 200 + user info
 *   - POST /logout clears the session → subsequent GET /me → 401
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { getIronSession } from 'iron-session';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../db';
import { createAuthRouter } from '../routes/auth';

// ── Mock the OAuth client ─────────────────────────────────────────────────────

const FAKE_DID = 'did:plc:integrationtestuser0001';
const FAKE_HANDLE = 'testuser.bsky.social';

const fakeAgent = {
  assertDid: FAKE_DID,
  did: FAKE_DID,
  signOut: vi.fn(async () => {}),
  getProfile: vi.fn(async () => ({
    data: {
      did: FAKE_DID,
      handle: FAKE_HANDLE,
      displayName: 'Test User',
      avatar: undefined,
      description: 'Integration test account',
    },
  })),
};

const mockOAuthClient = {
  authorize: vi.fn(async (input: string) => new URL(`https://bsky.social/oauth/authorize?state=test&input=${encodeURIComponent(input)}`)),
  restore: vi.fn(async (_did: string) => fakeAgent),
  revoke: vi.fn(async () => {}),
  // Minimal shape required by createAuthRouter
  clientMetadata: { client_id: 'https://test.opensocial.local' },
} as any;

// ── Session constants (must match routes/auth.ts sessionOptions) ──────────────

const SESSION_OPTIONS = {
  cookieName: 'sid',
  password: process.env.COOKIE_SECRET || 'test-cookie-secret-for-testing-purposes',
  cookieOptions: { secure: false, sameSite: 'lax' as const },
};

interface Session { did?: string }

// ── Build test app ────────────────────────────────────────────────────────────

function buildTestApp(db: Database) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Mount auth router (same as production)
  app.use('/', createAuthRouter(mockOAuthClient, db));

  // Test-only helper: seed a session so integration tests can call /me as
  // an authenticated user without a live OAuth round-trip.
  app.post('/__test__/seed-session', async (req, res) => {
    const session = await getIronSession<Session>(req, res, SESSION_OPTIONS);
    session.did = req.body.did ?? FAKE_DID;
    await session.save();
    res.json({ ok: true });
  });

  return app;
}

// ── DB setup ──────────────────────────────────────────────────────────────────

async function createTestDb(): Promise<Database> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  return new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 3 }) }),
  }) as Database;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Auth flow — integration', () => {
  let db: Database;
  let app: express.Express;
  let agent: ReturnType<typeof supertest>;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildTestApp(db);
    agent = supertest.agent(app); // persists cookies between requests
  });

  afterAll(async () => {
    await db.destroy();
  });

  // ── Unauthenticated ──────────────────────────────────────────────────────

  it('GET /users/me without a session cookie returns 401', async () => {
    // Fresh agent — no cookie jar
    const res = await supertest(app).get('/users/me').expect(401);
    expect(res.body).toHaveProperty('error');
  });

  // ── Login (OAuth initiation) ─────────────────────────────────────────────

  it('POST /login with a valid handle returns a redirectUrl', async () => {
    const res = await supertest(app)
      .post('/login')
      .set('Content-Type', 'application/json')
      .send({ input: FAKE_HANDLE })
      .expect((r) => {
        // Either 200 with redirectUrl or 302 redirect — both are valid
        if (r.status !== 200 && r.status !== 302) {
          throw new Error(`Expected 200 or 302, got ${r.status}`);
        }
      });

    if (res.status === 200) {
      expect(res.body).toHaveProperty('redirectUrl');
      expect(res.body.redirectUrl).toMatch(/bsky\.social|oauth/i);
    }
    // 302 → Location header points at OAuth provider
    if (res.status === 302) {
      expect(res.headers.location).toMatch(/bsky\.social|oauth/i);
    }
  });

  // ── Authenticated session flow ───────────────────────────────────────────

  it('GET /users/me with a valid session returns 200 with user info', async () => {
    // Seed a session cookie (simulates completed OAuth round-trip)
    await agent.post('/__test__/seed-session').send({ did: FAKE_DID }).expect(200);

    mockOAuthClient.restore.mockResolvedValueOnce(fakeAgent as any);

    const res = await agent.get('/users/me').expect(200);

    // The route tries agent.getProfile() first; our mock returns FAKE_HANDLE.
    // If getProfile falls back (e.g. com.atproto.server.getSession unavailable),
    // handle may resolve to the DID itself — assert did is always present.
    expect(res.body).toHaveProperty('did', FAKE_DID);
    // handle is either the real handle or the DID fallback
    expect(res.body.handle).toBeTruthy();
  });

  // ── Logout + subsequent guard ────────────────────────────────────────────

  it('POST /logout clears the session and subsequent GET /me returns 401', async () => {
    // Re-seed session for this sub-flow
    await agent.post('/__test__/seed-session').send({ did: FAKE_DID }).expect(200);
    mockOAuthClient.restore.mockResolvedValueOnce(fakeAgent as any);

    // Confirm we're authenticated first
    await agent.get('/users/me').expect(200);

    // Now log out
    await agent.post('/logout').expect(200);

    // Session must be gone — next request should 401
    // restore() should NOT be called (no DID in session)
    const afterLogout = await agent.get('/users/me').expect(401);
    expect(afterLogout.body).toHaveProperty('error');
  });
});
