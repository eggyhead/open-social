import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { parseSignatureInput, buildSignatureBase, verifyRequestSignature } from './httpSig';

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

// ── End-to-end verifyRequestSignature tests ─────────────────────────

function makeSignedRequest(
  keyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject },
  options: {
    method?: string;
    path?: string;
    alg?: string;
    createdOverride?: number;
    signFn?: (data: string, privateKey: crypto.KeyObject) => Buffer;
  } = {}
) {
  const method = options.method || 'GET';
  const path = options.path || '/api/v1/test';
  const created = options.createdOverride ?? Math.floor(Date.now() / 1000);
  const alg = options.alg || 'ecdsa-p256-sha256';

  const sigInputValue = `sig1=("@method" "@path");created=${created};keyid="testapp";alg="${alg}"`;
  const sigInput = parseSignatureInput(sigInputValue)!;

  // Build signature base
  const req = {
    method,
    protocol: 'https',
    get: (h: string) => {
      if (h === 'host') return 'example.com';
      if (h === 'signature-input') return sigInputValue;
      if (h === 'signature') return 'placeholder';
      return '';
    },
    originalUrl: path,
    path,
    headers: {} as Record<string, string>,
  } as any;

  const base = buildSignatureBase(req, sigInput, sigInputValue);

  // Sign
  let signature: Buffer;
  if (options.signFn) {
    signature = options.signFn(base, keyPair.privateKey);
  } else {
    const signer = crypto.createSign('SHA256');
    signer.update(base);
    signature = signer.sign(keyPair.privateKey);
  }

  const sigB64 = signature.toString('base64');

  // Build final mock request with proper headers
  req.get = (h: string) => {
    if (h === 'host') return 'example.com';
    if (h === 'signature-input') return sigInputValue;
    if (h === 'signature') return `sig1=:${sigB64}:`;
    return '';
  };
  req.headers = {
    'signature-input': sigInputValue,
    'signature': `sig1=:${sigB64}:`,
  };

  return { req, publicKey: keyPair.publicKey };
}

describe('verifyRequestSignature (end-to-end)', () => {
  it('verifies a valid ECDSA P-256 signature', () => {
    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { req, publicKey } = makeSignedRequest(keyPair);
    const result = verifyRequestSignature(req, publicKey);
    expect(result.valid).toBe(true);
    expect(result.keyId).toBe('testapp');
  });

  it('rejects an invalid signature (wrong key)', () => {
    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const wrongKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { req } = makeSignedRequest(keyPair);
    const result = verifyRequestSignature(req, wrongKeyPair.publicKey);
    expect(result.valid).toBe(false);
  });

  it('rejects a stale signature (replay protection)', () => {
    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const staleCreated = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const { req, publicKey } = makeSignedRequest(keyPair, { createdOverride: staleCreated });
    const result = verifyRequestSignature(req, publicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too old');
  });

  it('rejects a future signature', () => {
    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const futureCreated = Math.floor(Date.now() / 1000) + 120; // 2 minutes ahead
    const { req, publicKey } = makeSignedRequest(keyPair, { createdOverride: futureCreated });
    const result = verifyRequestSignature(req, publicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('future');
  });

  it('verifies a valid RSA-PSS signature', () => {
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const { req, publicKey } = makeSignedRequest(keyPair, {
      alg: 'rsa-pss-sha256',
      signFn: (data, privateKey) => {
        return crypto.sign('sha256', Buffer.from(data), {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        });
      },
    });
    const result = verifyRequestSignature(req, publicKey);
    expect(result.valid).toBe(true);
  });

  it('verifies a valid Ed25519 signature', () => {
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const { req, publicKey } = makeSignedRequest(keyPair, {
      alg: 'ed25519',
      signFn: (data, privateKey) => {
        return Buffer.from(crypto.sign(null, Buffer.from(data), privateKey));
      },
    });
    const result = verifyRequestSignature(req, publicKey);
    expect(result.valid).toBe(true);
  });

  it('rejects when Signature header is missing', () => {
    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const req = {
      method: 'GET',
      get: (h: string) => {
        if (h === 'signature-input') return 'sig1=("@method");created=100';
        return undefined;
      },
    } as any;
    const result = verifyRequestSignature(req, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing');
  });
});
