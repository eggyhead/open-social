import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock all external dependencies before importing the module under test
vi.mock('../services/atproto', () => ({
  createCommunityAgent: vi.fn(),
}));

vi.mock('../services/webhook', () => ({
  createWebhookService: vi.fn(() => ({
    dispatch: vi.fn(),
  })),
}));

vi.mock('../services/auditLog', () => ({
  createAuditLogService: vi.fn(() => ({
    log: vi.fn(),
  })),
}));

vi.mock('../services/permissions', () => ({
  checkAppVisibility: vi.fn(() => ({ allowed: true })),
  getRequiredRole: vi.fn(() => null),
  getUserRoles: vi.fn(() => ['member']),
  satisfiesRole: vi.fn(() => true),
  seedCollectionPermissions: vi.fn(),
  ROLE_ADMIN: 'admin',
  ROLE_MEMBER: 'member',
}));

vi.mock('../middleware/auth', () => ({
  createVerifyApiKey: vi.fn(() => {
    return (req: any, _res: any, next: any) => {
      req.app_data = {
        app_id: 'app_test',
        name: 'Test App',
        domain: 'test.example.com',
        creator_did: 'did:plc:creator',
        api_key: 'test-key',
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      };
      req.auth_method = 'api_key';
      next();
    };
  }),
}));

vi.mock('../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../lib/errors', () => ({
  logWarning: vi.fn(),
}));

vi.mock('../lib/adminUtils', () => ({
  isAdminInList: vi.fn(() => false),
  normalizeAdmins: vi.fn((admins: any) => admins),
  getOriginalAdminDid: vi.fn(() => 'did:plc:original'),
}));

vi.mock('../lib/pagination', () => ({
  encodeCursor: vi.fn((n: number) => Buffer.from(String(n)).toString('base64')),
  decodeCursor: vi.fn((c: string) => {
    try {
      return parseInt(Buffer.from(c, 'base64').toString('utf-8'), 10) || 0;
    } catch { return 0; }
  }),
}));

// Mock fs.readdirSync and fs.readFileSync for lexicon loading
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readdirSync: vi.fn(() => [
        'community.opensocial.listRecords.json',
        'community.opensocial.createRecord.json',
        'community.opensocial.getCommunity.json',
        'community.opensocial.membership.json',
      ]),
      readFileSync: vi.fn((filePath: string) => {
        if (filePath.includes('listRecords')) {
          return JSON.stringify({
            lexicon: 1,
            id: 'community.opensocial.listRecords',
            defs: { main: { type: 'query' } },
          });
        }
        if (filePath.includes('createRecord')) {
          return JSON.stringify({
            lexicon: 1,
            id: 'community.opensocial.createRecord',
            defs: { main: { type: 'procedure' } },
          });
        }
        if (filePath.includes('getCommunity')) {
          return JSON.stringify({
            lexicon: 1,
            id: 'community.opensocial.getCommunity',
            defs: { main: { type: 'query' } },
          });
        }
        if (filePath.includes('membership')) {
          return JSON.stringify({
            lexicon: 1,
            id: 'community.opensocial.membership',
            defs: { main: { type: 'record' } },
          });
        }
        return '{}';
      }),
    },
  };
});

import { createXrpcRouter, XrpcError } from './server';

// Create a mock db that returns nothing for most queries
function createMockDb(): any {
  const mockChain = {
    selectAll: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue([]),
    executeTakeFirst: vi.fn().mockResolvedValue(undefined),
  };
  return {
    selectFrom: vi.fn(() => mockChain),
    insertInto: vi.fn(() => ({
      values: vi.fn().mockReturnThis(),
      onConflict: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
    })),
    updateTable: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
    })),
    deleteFrom: vi.fn(() => ({
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
    })),
  };
}

describe('XRPC Router', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    const db = createMockDb();
    app = express();
    app.use(express.json());
    app.use('/xrpc', createXrpcRouter(db));
  });

  describe('Routing', () => {
    it('routes GET requests to query handlers', async () => {
      // community.opensocial.listRecords is registered as a query
      // It will fail with CommunityNotFound since mock db returns undefined,
      // but that confirms routing works
      const res = await request(app)
        .get('/xrpc/community.opensocial.listRecords')
        .query({ communityDid: 'did:plc:test', collection: 'test.collection' });

      // Should not be 501 (MethodNotImplemented) — handler is registered
      expect(res.status).not.toBe(501);
    });

    it('routes POST requests to procedure handlers', async () => {
      const res = await request(app)
        .post('/xrpc/community.opensocial.createRecord')
        .send({
          communityDid: 'did:plc:test',
          userDid: 'did:plc:user',
          collection: 'test.collection',
          record: { $type: 'test.collection', text: 'hello' },
        });

      // Should not be 501 (MethodNotImplemented) — handler is registered
      expect(res.status).not.toBe(501);
    });

    it('returns 501 MethodNotImplemented for unknown method IDs', async () => {
      const getRes = await request(app)
        .get('/xrpc/community.opensocial.nonExistentMethod');
      expect(getRes.status).toBe(501);
      expect(getRes.body.error).toBe('MethodNotImplemented');

      const postRes = await request(app)
        .post('/xrpc/community.opensocial.nonExistentMethod')
        .send({});
      expect(postRes.status).toBe(501);
      expect(postRes.body.error).toBe('MethodNotImplemented');
    });

    it('returns 400 InvalidRequest when using wrong HTTP method for a query', async () => {
      // community.opensocial.listRecords is a query (GET), calling via POST should error
      const res = await request(app)
        .post('/xrpc/community.opensocial.listRecords')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
      expect(res.body.message).toContain('use GET');
    });

    it('returns 400 InvalidRequest when using wrong HTTP method for a procedure', async () => {
      // community.opensocial.createRecord is a procedure (POST), calling via GET should error
      const res = await request(app)
        .get('/xrpc/community.opensocial.createRecord');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
      expect(res.body.message).toContain('use POST');
    });
  });

  describe('Error formatting', () => {
    it('formats XRPC errors with error name and message', async () => {
      const res = await request(app)
        .get('/xrpc/community.opensocial.listRecords')
        .query({ communityDid: '', collection: '' });

      // Should get an error response (missing required params)
      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('message');
      expect(typeof res.body.error).toBe('string');
      expect(typeof res.body.message).toBe('string');
    });

    it('returns proper JSON error for handler exceptions', async () => {
      const res = await request(app)
        .get('/xrpc/community.opensocial.getCommunity')
        .query({ did: 'did:plc:test123' });

      // Handler should run and return CommunityNotFound since db returns undefined
      expect(res.body.error).toBe('CommunityNotFound');
      expect(res.status).toBe(404);
    });
  });

  describe('XrpcError class', () => {
    it('creates errors with status, errorName, and message', () => {
      const err = new XrpcError(404, 'CommunityNotFound', 'Community not found');
      expect(err.status).toBe(404);
      expect(err.errorName).toBe('CommunityNotFound');
      expect(err.message).toBe('Community not found');
      expect(err.name).toBe('XrpcError');
    });
  });
});
