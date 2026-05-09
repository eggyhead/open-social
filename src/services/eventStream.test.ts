import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEventStreamService } from './eventStream';

// Minimal mock DB helpers
function createMockResult(rows: any[] = [], returning?: any) {
  const chainable: any = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue(rows),
    executeTakeFirst: vi.fn().mockResolvedValue(rows[0] ?? undefined),
    executeTakeFirstOrThrow: vi.fn().mockResolvedValue(returning ?? rows[0]),
  };
  return chainable;
}

function createMockDb() {
  const mockInsert = createMockResult([], { id: 42 });
  const mockSelect = createMockResult([]);
  const mockDelete = createMockResult();
  (mockDelete as any).executeTakeFirst = vi.fn().mockResolvedValue({ numDeletedRows: BigInt(0) });
  // For atomic consume: deleteFrom().where().where().returning().executeTakeFirst()
  (mockDelete as any).returning = vi.fn().mockReturnValue({
    executeTakeFirst: vi.fn().mockResolvedValue(undefined),
  });

  return {
    insertInto: vi.fn().mockReturnValue(mockInsert),
    selectFrom: vi.fn().mockReturnValue(mockSelect),
    deleteFrom: vi.fn().mockReturnValue(mockDelete),
    _mockInsert: mockInsert,
    _mockSelect: mockSelect,
    _mockDelete: mockDelete,
  } as any;
}

describe('EventStreamService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: ReturnType<typeof createEventStreamService>;

  beforeEach(() => {
    db = createMockDb();
    service = createEventStreamService(db);
  });

  describe('createStreamToken', () => {
    it('inserts a token into stream_tokens', async () => {
      const token = await service.createStreamToken(1, 'did:plc:test');

      expect(db.insertInto).toHaveBeenCalledWith('stream_tokens');
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('generates unique tokens', async () => {
      const t1 = await service.createStreamToken(1);
      const t2 = await service.createStreamToken(1);
      expect(t1).not.toBe(t2);
    });

    it('accepts optional communityDid', async () => {
      await service.createStreamToken(1);
      const call = db._mockInsert.values.mock.calls[0][0];
      expect(call.community_did).toBeNull();
    });
  });

  describe('consumeStreamToken', () => {
    it('returns null for non-existent token', async () => {
      const result = await service.consumeStreamToken('nonexistent');
      expect(result).toBeNull();
    });

    it('returns token record atomically via DELETE...RETURNING', async () => {
      const validToken = {
        id: 1,
        token: 'valid',
        app_id: 5,
        community_did: 'did:plc:abc',
        expires_at: new Date(Date.now() + 60000),
        created_at: new Date(),
      };

      // Mock the atomic delete-returning chain
      db._mockDelete.returning = vi.fn().mockReturnValue({
        executeTakeFirst: vi.fn().mockResolvedValue(validToken),
      });

      const result = await service.consumeStreamToken('valid');

      expect(result).toEqual(validToken);
      expect(db.deleteFrom).toHaveBeenCalledWith('stream_tokens');
    });

    it('returns null when no matching non-expired token exists', async () => {
      // Default mock returns undefined (no matching row)
      const result = await service.consumeStreamToken('expired-or-missing');
      expect(result).toBeNull();
    });
  });

  describe('logEvent', () => {
    it('inserts an event and returns its ID', async () => {
      const id = await service.logEvent('member.joined', 'did:plc:test', { userDid: 'did:plc:user' });

      expect(db.insertInto).toHaveBeenCalledWith('event_log');
      expect(id).toBe(42);
    });
  });

  describe('getEventsSince', () => {
    it('queries events after cursor', async () => {
      const events = [
        { id: 5, event_type: 'member.joined', community_did: 'did:plc:test', payload: {}, created_at: new Date() },
      ];
      db._mockSelect.execute.mockResolvedValueOnce(events);

      const result = await service.getEventsSince(4);
      expect(db.selectFrom).toHaveBeenCalledWith('event_log');
      expect(result).toEqual(events);
    });
  });

  describe('pruneOldEvents', () => {
    it('deletes old events and returns count', async () => {
      db._mockDelete.executeTakeFirst.mockResolvedValueOnce({ numDeletedRows: BigInt(5) });

      const deleted = await service.pruneOldEvents();
      expect(db.deleteFrom).toHaveBeenCalledWith('event_log');
      expect(deleted).toBe(5);
    });
  });

  describe('pruneExpiredTokens', () => {
    it('deletes expired tokens and returns count', async () => {
      db._mockDelete.executeTakeFirst.mockResolvedValueOnce({ numDeletedRows: BigInt(3) });

      const deleted = await service.pruneExpiredTokens();
      expect(db.deleteFrom).toHaveBeenCalledWith('stream_tokens');
      expect(deleted).toBe(3);
    });
  });
});
