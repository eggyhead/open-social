import { describe, it, expect } from 'vitest';
import { parseSignatureInput, buildSignatureBase } from './httpSig';

describe('parseSignatureInput', () => {
  it('parses a valid signature input with components and params', () => {
    const input = 'sig1=("@method" "@target-uri" "content-digest");created=1733000000;keyid="app_abc";alg="ecdsa-p256-sha256"';
    const result = parseSignatureInput(input);

    expect(result).not.toBeNull();
    expect(result!.components).toEqual(['@method', '@target-uri', 'content-digest']);
    expect(result!.params.created).toBe(1733000000);
    expect(result!.params.keyid).toBe('app_abc');
    expect(result!.params.alg).toBe('ecdsa-p256-sha256');
  });

  it('parses input with only components, no params', () => {
    const input = 'sig1=("@method" "@path")';
    const result = parseSignatureInput(input);

    expect(result).not.toBeNull();
    expect(result!.components).toEqual(['@method', '@path']);
    expect(Object.keys(result!.params)).toHaveLength(0);
  });

  it('returns null for invalid input', () => {
    expect(parseSignatureInput('')).toBeNull();
    expect(parseSignatureInput('garbage')).toBeNull();
  });

  it('handles single component', () => {
    const input = 'sig1=("@method");created=100';
    const result = parseSignatureInput(input);

    expect(result).not.toBeNull();
    expect(result!.components).toEqual(['@method']);
    expect(result!.params.created).toBe(100);
  });
});

describe('buildSignatureBase', () => {
  it('builds correct signature base for method and path', () => {
    const req = {
      method: 'GET',
      protocol: 'https',
      get: (h: string) => {
        if (h === 'host') return 'opensocial.community';
        return '';
      },
      originalUrl: '/api/v1/communities',
      path: '/api/v1/communities',
    } as any;

    const sigInput = {
      components: ['@method', '@target-uri'],
      params: { created: 1733000000 },
    };

    const rawInput = 'sig1=("@method" "@target-uri");created=1733000000';
    const base = buildSignatureBase(req, sigInput, rawInput);

    expect(base).toContain('"@method": GET');
    expect(base).toContain('"@target-uri": https://opensocial.community/api/v1/communities');
    expect(base).toContain('"@signature-params":');
  });

  it('includes regular headers in signature base', () => {
    const req = {
      method: 'POST',
      protocol: 'https',
      get: (h: string) => {
        if (h === 'host') return 'example.com';
        if (h === 'content-digest') return 'sha-256=:abc123:';
        if (h === 'date') return 'Thu, 01 Jan 2026 00:00:00 GMT';
        return '';
      },
      originalUrl: '/api/v1/test',
      path: '/api/v1/test',
    } as any;

    const sigInput = {
      components: ['@method', 'content-digest', 'date'],
      params: {},
    };

    const rawInput = 'sig1=("@method" "content-digest" "date")';
    const base = buildSignatureBase(req, sigInput, rawInput);

    expect(base).toContain('"@method": POST');
    expect(base).toContain('"content-digest": sha-256=:abc123:');
    expect(base).toContain('"date": Thu, 01 Jan 2026 00:00:00 GMT');
  });
});
