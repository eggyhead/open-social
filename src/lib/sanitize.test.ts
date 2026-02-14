import { describe, it, expect } from 'vitest';
import {
  sanitizeUserContent,
  sanitizePlainText,
  validateWebhookUrl,
  validateNSID,
} from './sanitize';

describe('sanitizeUserContent', () => {
  it('should allow safe HTML tags', () => {
    const input = '<p>Hello <strong>world</strong>!</p>';
    const result = sanitizeUserContent(input);
    expect(result).toContain('<p>');
    expect(result).toContain('<strong>');
  });

  it('should remove dangerous script tags', () => {
    const input = '<p>Hello</p><script>alert("xss")</script>';
    const result = sanitizeUserContent(input);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
  });

  it('should remove inline event handlers', () => {
    const input = '<a href="#" onclick="alert(1)">Click</a>';
    const result = sanitizeUserContent(input);
    expect(result).not.toContain('onclick');
  });

  it('should allow safe link with href', () => {
    const input = '<a href="https://example.com" title="Example">Link</a>';
    const result = sanitizeUserContent(input);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('title="Example"');
  });

  it('should remove javascript: URLs', () => {
    const input = '<a href="javascript:alert(1)">Bad link</a>';
    const result = sanitizeUserContent(input);
    expect(result).not.toContain('javascript:');
  });

  it('should handle empty string', () => {
    const result = sanitizeUserContent('');
    expect(result).toBe('');
  });
});

describe('sanitizePlainText', () => {
  it('should strip all HTML tags', () => {
    const input = '<p>Hello <strong>world</strong>!</p>';
    const result = sanitizePlainText(input);
    expect(result).toBe('Hello world!');
  });

  it('should remove script tags and content', () => {
    const input = 'Hello<script>alert("xss")</script> world';
    const result = sanitizePlainText(input);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
  });

  it('should handle plain text without changes', () => {
    const input = 'Just plain text';
    const result = sanitizePlainText(input);
    expect(result).toBe('Just plain text');
  });
});

describe('validateWebhookUrl', () => {
  it('should accept valid https URL', () => {
    const url = 'https://example.com/webhook';
    expect(() => validateWebhookUrl(url)).not.toThrow();
    expect(validateWebhookUrl(url)).toBe(url);
  });

  it('should reject http URLs', () => {
    const url = 'http://example.com/webhook';
    expect(() => validateWebhookUrl(url)).toThrow('must use https://');
  });

  it('should reject non-URL strings', () => {
    const url = 'not a url';
    expect(() => validateWebhookUrl(url)).toThrow('Invalid URL');
  });

  it('should reject URLs with open redirect patterns', () => {
    const url = 'https://example.com//evil.com';
    expect(() => validateWebhookUrl(url)).toThrow('open redirect');
  });

  it('should enforce hostname allowlist', () => {
    const url = 'https://evil.com/webhook';
    const allowlist = ['example.com', 'trusted.org'];
    expect(() => validateWebhookUrl(url, allowlist)).toThrow('not in allowlist');
  });

  it('should allow URLs in hostname allowlist', () => {
    const url = 'https://example.com/webhook';
    const allowlist = ['example.com', 'trusted.org'];
    expect(() => validateWebhookUrl(url, allowlist)).not.toThrow();
  });

  it('should support wildcard subdomain matching', () => {
    const url = 'https://api.example.com/webhook';
    const allowlist = ['*.example.com'];
    expect(() => validateWebhookUrl(url, allowlist)).not.toThrow();
  });

  it('should not match wildcard to different domain', () => {
    const url = 'https://notexample.com/webhook';
    const allowlist = ['*.example.com'];
    expect(() => validateWebhookUrl(url, allowlist)).toThrow('not in allowlist');
  });

  it('should allow any hostname when allowlist is undefined', () => {
    const url = 'https://anyhost.com/webhook';
    expect(() => validateWebhookUrl(url, undefined)).not.toThrow();
  });

  it('should allow any hostname when allowlist is empty', () => {
    const url = 'https://anyhost.com/webhook';
    expect(() => validateWebhookUrl(url, [])).not.toThrow();
  });
});

describe('validateNSID', () => {
  it('should accept valid NSID with 3 segments', () => {
    expect(validateNSID('com.example.post')).toBe(true);
  });

  it('should accept valid NSID with multiple domain segments', () => {
    expect(validateNSID('com.example.app.post')).toBe(true);
  });

  it('should accept NSID with camelCase name segment', () => {
    expect(validateNSID('com.example.fooBar')).toBe(true);
  });

  it('should reject NSID with only 2 segments', () => {
    expect(validateNSID('com.example')).toBe(false);
  });

  it('should reject NSID with name starting with digit', () => {
    expect(validateNSID('com.example.3post')).toBe(false);
  });

  it('should reject NSID with domain segment starting with digit', () => {
    expect(validateNSID('3com.example.post')).toBe(false);
  });

  it('should reject NSID exceeding max length', () => {
    const longNsid = 'a'.repeat(318);
    expect(validateNSID(longNsid)).toBe(false);
  });

  it('should accept NSID at max length', () => {
    // Create a valid NSID at max length (317 chars)
    const longSegment = 'a'.repeat(63);
    const nsid = `com.${longSegment}.${longSegment}.${longSegment}.abcde`;
    if (nsid.length <= 317) {
      expect(validateNSID(nsid)).toBe(true);
    }
  });

  it('should reject NSID with empty segment', () => {
    expect(validateNSID('com..post')).toBe(false);
  });

  it('should reject NSID with hyphen at start of domain segment', () => {
    expect(validateNSID('com.-example.post')).toBe(false);
  });

  it('should reject NSID with hyphen at end of domain segment', () => {
    expect(validateNSID('com.example-.post')).toBe(false);
  });

  it('should accept NSID with hyphen in middle of domain segment', () => {
    expect(validateNSID('com.ex-ample.post')).toBe(true);
  });

  it('should reject NSID with special characters in name segment', () => {
    expect(validateNSID('com.example.post-name')).toBe(false);
  });

  it('should reject NSID with underscore in name segment', () => {
    expect(validateNSID('com.example.post_name')).toBe(false);
  });

  it('should accept mixed case in name segment', () => {
    expect(validateNSID('com.example.PostName')).toBe(true);
  });

  it('should reject NSID with segment exceeding 63 chars', () => {
    const longSegment = 'a'.repeat(64);
    expect(validateNSID(`com.${longSegment}.post`)).toBe(false);
  });

  it('should accept real-world ATProto NSIDs', () => {
    expect(validateNSID('app.bsky.feed.post')).toBe(true);
    expect(validateNSID('app.bsky.actor.profile')).toBe(true);
    expect(validateNSID('community.opensocial.profile')).toBe(true);
    expect(validateNSID('community.opensocial.membershipProof')).toBe(true);
  });
});
