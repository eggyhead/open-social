/**
 * Tests for apps route — F3: cimdUrl + authMethod update via PUT /:appId
 *
 * Covers:
 *   - isCimdUrlHttps / isCimdUrlDomainMatch helper functions
 *   - updateAppSchema accepting cimdUrl and authMethod
 *   - PUT /api/v1/apps/:appId handler: happy path + 4xx error cases
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { getIronSession } from "iron-session";
import {
  isCimdUrlHttps,
  isCimdUrlDomainMatch,
  updateAppSchema,
} from "../validation/schemas";
import { createAppRouter } from "./apps";

// ── Validator unit tests ───────────────────────────────────────────────────────

describe("isCimdUrlHttps", () => {
  it("returns true for an https URL", () => {
    expect(isCimdUrlHttps("https://example.com/.well-known/cimd.json")).toBe(
      true,
    );
  });

  it("returns false for an http URL", () => {
    expect(isCimdUrlHttps("http://example.com/.well-known/cimd.json")).toBe(
      false,
    );
  });

  it("returns false for a bare domain", () => {
    expect(isCimdUrlHttps("example.com")).toBe(false);
  });
});

describe("isCimdUrlDomainMatch", () => {
  it("returns true when hostname exactly matches domain", () => {
    expect(
      isCimdUrlDomainMatch(
        "https://example.com/.well-known/cimd.json",
        "example.com",
      ),
    ).toBe(true);
  });

  it("returns true when hostname is a subdomain of domain", () => {
    expect(
      isCimdUrlDomainMatch(
        "https://api.example.com/.well-known/cimd.json",
        "example.com",
      ),
    ).toBe(true);
  });

  it("returns false when hostname does not match", () => {
    expect(
      isCimdUrlDomainMatch(
        "https://attacker.com/.well-known/cimd.json",
        "example.com",
      ),
    ).toBe(false);
  });

  it("returns false for a partial suffix match that is not a real subdomain", () => {
    // "notexample.com" ends with "example.com" as a substring but is not a subdomain
    expect(
      isCimdUrlDomainMatch("https://notexample.com/cimd.json", "example.com"),
    ).toBe(false);
  });

  it("returns false for a malformed URL", () => {
    expect(isCimdUrlDomainMatch("not-a-url", "example.com")).toBe(false);
  });
});

// ── updateAppSchema unit tests ─────────────────────────────────────────────────

describe("updateAppSchema — cimdUrl and authMethod", () => {
  it("accepts cimdUrl alone (without name/domain)", () => {
    const result = updateAppSchema.safeParse({
      cimdUrl: "https://example.com/.well-known/cimd.json",
    });
    expect(result.success).toBe(true);
  });

  it("accepts authMethod alone", () => {
    const result = updateAppSchema.safeParse({ authMethod: "api_key" });
    expect(result.success).toBe(true);
  });

  it("accepts cimdUrl + authMethod together", () => {
    const result = updateAppSchema.safeParse({
      cimdUrl: "https://example.com/.well-known/cimd.json",
      authMethod: "http_signature",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a cimdUrl that uses http instead of https", () => {
    const result = updateAppSchema.safeParse({
      cimdUrl: "http://example.com/.well-known/cimd.json",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toMatch(/HTTPS/i);
  });

  it("rejects an invalid authMethod value", () => {
    const result = updateAppSchema.safeParse({ authMethod: "magic_token" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty body (no fields)", () => {
    const result = updateAppSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("still accepts name + domain as before", () => {
    const result = updateAppSchema.safeParse({
      name: "My App",
      domain: "example.com",
    });
    expect(result.success).toBe(true);
  });
});

// ── Route handler tests ────────────────────────────────────────────────────────

const FAKE_DID = "did:plc:apptestuser0001";
const FAKE_APP_ID = "app_deadbeef01234567";

const SESSION_OPTIONS = {
  cookieName: "sid",
  password:
    process.env.COOKIE_SECRET || "test-cookie-secret-for-testing-purposes",
  cookieOptions: { secure: false, sameSite: "lax" as const },
};

interface Session {
  did?: string;
}

/** Stub app row returned by DB lookups */
const stubApp = {
  app_id: FAKE_APP_ID,
  name: "Test App",
  domain: "example.com",
  creator_did: FAKE_DID,
  auth_method: "api_key",
  cimd_url: null,
  api_key: "hashed_key",
  status: "active",
  created_at: new Date(),
  updated_at: new Date(),
};

/** Updated stub row returned after the DB write */
const updatedApp = {
  app_id: FAKE_APP_ID,
  name: "Test App",
  domain: "example.com",
  auth_method: "http_signature",
  cimd_url: "https://example.com/.well-known/cimd.json",
  status: "active",
  created_at: new Date(),
  updated_at: new Date(),
};

/**
 * Build a chainable Kysely mock whose `executeTakeFirst` returns the provided
 * values in sequence (first call → first value, second call → second value, …).
 */
function buildMockDb(executeTakeFirstSequence: Array<any> = []) {
  let callIndex = 0;
  const chain: any = {
    selectFrom: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue([]),
    executeTakeFirst: vi.fn().mockImplementation(async () => {
      return executeTakeFirstSequence[callIndex++] ?? undefined;
    }),
    executeTakeFirstOrThrow: vi.fn().mockResolvedValue({}),
    insertInto: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    updateTable: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    deleteFrom: vi.fn().mockReturnThis(),
  };
  return chain;
}

const fakeAgent = {
  assertDid: FAKE_DID,
  did: FAKE_DID,
  signOut: vi.fn(async () => {}),
  getProfile: vi.fn(async () => ({
    data: { did: FAKE_DID, handle: "testapp.bsky.social" },
  })),
};

const mockOAuthClient = {
  authorize: vi.fn(
    async () => new URL("https://bsky.social/oauth/authorize?state=test"),
  ),
  restore: vi.fn(async () => fakeAgent),
  revoke: vi.fn(async () => {}),
  clientMetadata: { client_id: "https://test.opensocial.local" },
} as any;

function buildTestApp(mockDb: any) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  // Seed session endpoint (simulates completed OAuth round-trip)
  app.post("/__test__/seed-session", async (req, res) => {
    const session = await getIronSession<Session>(req, res, SESSION_OPTIONS);
    session.did = req.body.did ?? FAKE_DID;
    await session.save();
    res.json({ ok: true });
  });

  app.use("/api/v1/apps", createAppRouter(mockOAuthClient, mockDb));
  return app;
}

describe("PUT /api/v1/apps/:appId — cimdUrl update", () => {
  let agent: ReturnType<typeof supertest.agent>;
  let mockDb: any;

  beforeAll(async () => {
    // Shared session agent persists cookies across requests
    agent = supertest.agent(
      buildTestApp(buildMockDb([stubApp, undefined, updatedApp])),
    );
    await agent
      .post("/__test__/seed-session")
      .send({ did: FAKE_DID })
      .expect(200);
    mockOAuthClient.restore.mockResolvedValue(fakeAgent);
  });

  afterAll(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    // Fresh app with no cookie jar — no session cookie will be sent.
    // restore() is never called when session.did is empty, so we don't mock it.
    const app = buildTestApp(buildMockDb([]));

    const res = await supertest(app)
      .put(`/api/v1/apps/${FAKE_APP_ID}`)
      .send({ cimdUrl: "https://example.com/.well-known/cimd.json" })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when cimdUrl uses http instead of https", async () => {
    mockDb = buildMockDb([stubApp, undefined, updatedApp]);
    const testAgent = supertest.agent(buildTestApp(mockDb));
    await testAgent
      .post("/__test__/seed-session")
      .send({ did: FAKE_DID })
      .expect(200);
    // Use mockResolvedValue (not Once) to avoid once-queue bleed between tests
    mockOAuthClient.restore.mockResolvedValue(fakeAgent);

    const res = await testAgent
      .put(`/api/v1/apps/${FAKE_APP_ID}`)
      .send({ cimdUrl: "http://example.com/.well-known/cimd.json" })
      .expect(400);

    expect(res.body.error).toMatch(/Invalid input/i);
  });

  it("returns 400 when cimdUrl domain does not match app domain", async () => {
    mockDb = buildMockDb([stubApp, undefined, updatedApp]);
    const testAgent = supertest.agent(buildTestApp(mockDb));
    await testAgent
      .post("/__test__/seed-session")
      .send({ did: FAKE_DID })
      .expect(200);
    mockOAuthClient.restore.mockResolvedValue(fakeAgent);

    // cimdUrl hostname is attacker.com but the app domain is example.com
    const res = await testAgent
      .put(`/api/v1/apps/${FAKE_APP_ID}`)
      .send({ cimdUrl: "https://attacker.com/.well-known/cimd.json" })
      .expect(400);

    expect(res.body.error).toMatch(/domain/i);
  });

  it("returns 400 when switching to http_signature without any cimdUrl", async () => {
    // App has no existing cimd_url; request sets authMethod=http_signature without cimdUrl
    mockDb = buildMockDb([stubApp, undefined, updatedApp]);
    const testAgent = supertest.agent(buildTestApp(mockDb));
    await testAgent
      .post("/__test__/seed-session")
      .send({ did: FAKE_DID })
      .expect(200);
    mockOAuthClient.restore.mockResolvedValue(fakeAgent);

    const res = await testAgent
      .put(`/api/v1/apps/${FAKE_APP_ID}`)
      .send({ authMethod: "http_signature" })
      .expect(400);

    expect(res.body.error).toMatch(/cimdUrl is required/i);
  });
});
