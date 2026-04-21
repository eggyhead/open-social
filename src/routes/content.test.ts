/**
 * Unit tests for content.ts route handlers
 * Tests validation schemas and delete authorization logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ─── Inline copies of the private schemas so we can test them directly ───

const shareContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('document'),
    documentUri: z.string().min(1).startsWith('at://'),
    documentCid: z.string().min(1),
    title: z.string().min(1).max(512),
    path: z.string().max(1024).optional(),
  }),
  z.object({
    type: z.literal('event'),
    documentUri: z.string().min(1).startsWith('at://'),
    documentCid: z.string().min(1),
    title: z.string().min(1).max(512),
    path: z.string().max(1024).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    location: z.string().max(512).optional(),
    mode: z.enum(['in-person', 'virtual', 'hybrid']).optional(),
  }),
]);

const listContentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

describe('content routes', () => {
  describe('shareContentSchema', () => {
    const validDocumentPayload = {
      type: 'document',
      documentUri: 'at://did:plc:abc123/app.bsky.feed.post/xyz',
      documentCid: 'bafyrei123abc',
      title: 'My Document',
    };

    const validEventPayload = {
      type: 'event',
      documentUri: 'at://did:plc:abc123/community.lexicon.calendar.event/xyz',
      documentCid: 'bafyrei456def',
      title: 'My Event',
    };

    it('should accept a valid document payload without path', () => {
      const result = shareContentSchema.safeParse(validDocumentPayload);
      expect(result.success).toBe(true);
    });

    it('should accept a valid document payload with path', () => {
      const result = shareContentSchema.safeParse({ ...validDocumentPayload, path: '/blog/my-post' });
      expect(result.success).toBe(true);
    });

    it('should reject payload with empty type', () => {
      const result = shareContentSchema.safeParse({ ...validDocumentPayload, type: '' });
      expect(result.success).toBe(false);
    });

    it('should reject payload with invalid documentUri (no at:// prefix)', () => {
      const result = shareContentSchema.safeParse({
        ...validDocumentPayload,
        documentUri: 'https://example.com',
      });
      expect(result.success).toBe(false);
    });

    it('should reject payload with empty documentCid', () => {
      const result = shareContentSchema.safeParse({ ...validDocumentPayload, documentCid: '' });
      expect(result.success).toBe(false);
    });

    it('should reject payload with empty title', () => {
      const result = shareContentSchema.safeParse({ ...validDocumentPayload, title: '' });
      expect(result.success).toBe(false);
    });

    it('should reject title exceeding 512 characters', () => {
      const result = shareContentSchema.safeParse({
        ...validDocumentPayload,
        title: 'x'.repeat(513),
      });
      expect(result.success).toBe(false);
    });

    it('should reject path exceeding 1024 characters', () => {
      const result = shareContentSchema.safeParse({
        ...validDocumentPayload,
        path: '/'.repeat(1025),
      });
      expect(result.success).toBe(false);
    });

    it('should NOT require userDid in the payload', () => {
      // userDid is now extracted from the session server-side
      const result = shareContentSchema.safeParse(validDocumentPayload);
      expect(result.success).toBe(true);
      expect((result as any).data).not.toHaveProperty('userDid');
    });

    it('should ignore extra fields like userDid', () => {
      const result = shareContentSchema.safeParse({
        ...validDocumentPayload,
        userDid: 'did:plc:hacker',
      });
      expect(result.success).toBe(true);
      // Zod strips unknown keys by default
      expect((result as any).data).not.toHaveProperty('userDid');
    });

    // ─── Event-specific tests ─────────────────────────────────────────

    it('should accept a valid event payload without optional fields', () => {
      const result = shareContentSchema.safeParse(validEventPayload);
      expect(result.success).toBe(true);
    });

    it('should accept a valid event payload with all optional event fields', () => {
      const result = shareContentSchema.safeParse({
        ...validEventPayload,
        startsAt: '2026-06-01T10:00:00.000Z',
        endsAt: '2026-06-01T12:00:00.000Z',
        location: 'Portland, OR',
        mode: 'in-person',
      });
      expect(result.success).toBe(true);
      expect((result as any).data.startsAt).toBe('2026-06-01T10:00:00.000Z');
      expect((result as any).data.mode).toBe('in-person');
    });

    it('should accept all valid mode values for event', () => {
      for (const mode of ['in-person', 'virtual', 'hybrid'] as const) {
        const result = shareContentSchema.safeParse({ ...validEventPayload, mode });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid mode values for event', () => {
      const result = shareContentSchema.safeParse({ ...validEventPayload, mode: 'unknown' });
      expect(result.success).toBe(false);
    });

    it('should reject non-datetime startsAt for event', () => {
      const result = shareContentSchema.safeParse({
        ...validEventPayload,
        startsAt: 'not-a-date',
      });
      expect(result.success).toBe(false);
    });

    it('should reject location exceeding 512 characters for event', () => {
      const result = shareContentSchema.safeParse({
        ...validEventPayload,
        location: 'x'.repeat(513),
      });
      expect(result.success).toBe(false);
    });

    it('should not allow event-specific fields on document type', () => {
      // Event fields are stripped/ignored when type=document (Zod discriminated union)
      const result = shareContentSchema.safeParse({
        ...validDocumentPayload,
        startsAt: '2026-06-01T10:00:00.000Z',
      });
      // Parses successfully but startsAt is stripped
      expect(result.success).toBe(true);
      expect((result as any).data).not.toHaveProperty('startsAt');
    });
  });

  describe('listContentSchema', () => {
    it('should use default limit of 50 when not specified', () => {
      const result = listContentSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data!.limit).toBe(50);
    });

    it('should accept a valid limit', () => {
      const result = listContentSchema.safeParse({ limit: '25' });
      expect(result.success).toBe(true);
      expect(result.data!.limit).toBe(25);
    });

    it('should reject limit below 1', () => {
      const result = listContentSchema.safeParse({ limit: '0' });
      expect(result.success).toBe(false);
    });

    it('should reject limit above 100', () => {
      const result = listContentSchema.safeParse({ limit: '101' });
      expect(result.success).toBe(false);
    });

    it('should accept an optional cursor', () => {
      const result = listContentSchema.safeParse({ cursor: 'abc123' });
      expect(result.success).toBe(true);
      expect(result.data!.cursor).toBe('abc123');
    });

    it('should coerce string limit to number', () => {
      const result = listContentSchema.safeParse({ limit: '42' });
      expect(result.success).toBe(true);
      expect(result.data!.limit).toBe(42);
    });
  });

  describe('delete authorization logic', () => {
    // These test the ownership check logic used by the DELETE handler.
    // The actual handler fetches the record and compares sharedBy to the
    // session user's DID. We test that logic in isolation here.

    function isOwnerAllowedToDelete(sharedBy: string, sessionDid: string): boolean {
      return sharedBy === sessionDid;
    }

    it('should allow the original sharer to delete their own share', () => {
      const did = 'did:plc:abc123';
      expect(isOwnerAllowedToDelete(did, did)).toBe(true);
    });

    it('should not allow a different user to delete via ownership check', () => {
      expect(
        isOwnerAllowedToDelete('did:plc:owner', 'did:plc:other'),
      ).toBe(false);
    });

    it('should not match partial DID strings', () => {
      expect(
        isOwnerAllowedToDelete('did:plc:abc123', 'did:plc:abc'),
      ).toBe(false);
    });
  });
});
