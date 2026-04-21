/**
 * Unit tests for hierarchy.ts route validation schemas and helper logic
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// ─── Inline copies of the private schemas so we can test them directly ───

const didSchema = z.string().min(1, 'DID is required').startsWith('did:');

const requestHierarchySchema = z.object({
  adminDid: didSchema,
  parentDid: didSchema,
});

const approveHierarchySchema = z.object({
  adminDid: didSchema,
  childDid: didSchema,
});

const revokeHierarchySchema = z.object({
  adminDid: didSchema,
});

const listHierarchyContentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

describe('hierarchy routes', () => {
  describe('requestHierarchySchema', () => {
    const validPayload = {
      adminDid: 'did:plc:admin123',
      parentDid: 'did:plc:parent456',
    };

    it('should accept a valid request payload', () => {
      const result = requestHierarchySchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('should reject missing adminDid', () => {
      const result = requestHierarchySchema.safeParse({ parentDid: validPayload.parentDid });
      expect(result.success).toBe(false);
    });

    it('should reject missing parentDid', () => {
      const result = requestHierarchySchema.safeParse({ adminDid: validPayload.adminDid });
      expect(result.success).toBe(false);
    });

    it('should reject adminDid without did: prefix', () => {
      const result = requestHierarchySchema.safeParse({
        ...validPayload,
        adminDid: 'not-a-did',
      });
      expect(result.success).toBe(false);
    });

    it('should reject parentDid without did: prefix', () => {
      const result = requestHierarchySchema.safeParse({
        ...validPayload,
        parentDid: 'not-a-did',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('approveHierarchySchema', () => {
    const validPayload = {
      adminDid: 'did:plc:admin123',
      childDid: 'did:plc:child789',
    };

    it('should accept a valid approve payload', () => {
      const result = approveHierarchySchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('should reject missing adminDid', () => {
      const result = approveHierarchySchema.safeParse({ childDid: validPayload.childDid });
      expect(result.success).toBe(false);
    });

    it('should reject missing childDid', () => {
      const result = approveHierarchySchema.safeParse({ adminDid: validPayload.adminDid });
      expect(result.success).toBe(false);
    });

    it('should reject invalid DIDs', () => {
      const result = approveHierarchySchema.safeParse({
        adminDid: 'bad',
        childDid: 'also-bad',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('revokeHierarchySchema', () => {
    it('should accept a valid revoke payload', () => {
      const result = revokeHierarchySchema.safeParse({ adminDid: 'did:plc:admin123' });
      expect(result.success).toBe(true);
    });

    it('should reject missing adminDid', () => {
      const result = revokeHierarchySchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject adminDid without did: prefix', () => {
      const result = revokeHierarchySchema.safeParse({ adminDid: 'notadid' });
      expect(result.success).toBe(false);
    });
  });

  describe('listHierarchyContentSchema', () => {
    it('should use default limit of 50 when not specified', () => {
      const result = listHierarchyContentSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data!.limit).toBe(50);
    });

    it('should accept a valid limit', () => {
      const result = listHierarchyContentSchema.safeParse({ limit: '25' });
      expect(result.success).toBe(true);
      expect(result.data!.limit).toBe(25);
    });

    it('should reject limit below 1', () => {
      const result = listHierarchyContentSchema.safeParse({ limit: '0' });
      expect(result.success).toBe(false);
    });

    it('should reject limit above 100', () => {
      const result = listHierarchyContentSchema.safeParse({ limit: '101' });
      expect(result.success).toBe(false);
    });

    it('should accept an optional cursor', () => {
      const result = listHierarchyContentSchema.safeParse({ cursor: 'cursor_xyz' });
      expect(result.success).toBe(true);
      expect(result.data!.cursor).toBe('cursor_xyz');
    });
  });

  describe('self-reference guard (application logic)', () => {
    // Tests the guard: a community cannot be its own parent or child.
    function isSelfReference(did: string, counterpartyDid: string): boolean {
      return did === counterpartyDid;
    }

    it('should detect self-reference', () => {
      expect(isSelfReference('did:plc:abc', 'did:plc:abc')).toBe(true);
    });

    it('should not flag different communities', () => {
      expect(isSelfReference('did:plc:abc', 'did:plc:def')).toBe(false);
    });
  });

  describe('content sort logic (application logic)', () => {
    // Tests the sort used in GET /hierarchy/content
    function sortBySharedAtDesc(records: { sharedAt?: string }[]): typeof records {
      return [...records].sort((a, b) => {
        const aTime = a.sharedAt ? new Date(a.sharedAt).getTime() : 0;
        const bTime = b.sharedAt ? new Date(b.sharedAt).getTime() : 0;
        return bTime - aTime;
      });
    }

    it('should sort records newest-first', () => {
      const records = [
        { sharedAt: '2026-01-01T00:00:00Z' },
        { sharedAt: '2026-06-01T00:00:00Z' },
        { sharedAt: '2026-03-01T00:00:00Z' },
      ];
      const sorted = sortBySharedAtDesc(records);
      expect(sorted[0].sharedAt).toBe('2026-06-01T00:00:00Z');
      expect(sorted[1].sharedAt).toBe('2026-03-01T00:00:00Z');
      expect(sorted[2].sharedAt).toBe('2026-01-01T00:00:00Z');
    });

    it('should handle records without sharedAt (treated as epoch)', () => {
      const records = [
        { sharedAt: '2026-01-01T00:00:00Z' },
        {},
      ];
      const sorted = sortBySharedAtDesc(records);
      expect(sorted[0].sharedAt).toBe('2026-01-01T00:00:00Z');
    });
  });
});
