/**
 * HTTP Message Signatures verification.
 *
 * Implements verification of HTTP requests signed per RFC 9421.
 * The signing side is handled by the client app; this module only verifies.
 *
 * Simplified implementation covering the common case:
 * - Signature algorithm: ECDSA P-256 (ES256) or RSA-PSS (PS256)
 * - Covered components: @method, @target-uri, content-digest, date
 *
 * @see https://www.rfc-editor.org/rfc/rfc9421
 */

import crypto from 'crypto';
import type { Request } from 'express';
import { logger } from './logger';

/** Parsed Signature-Input field */
export interface SignatureInput {
  /** Component identifiers that were signed */
  components: string[];
  /** Signature parameters */
  params: Record<string, string | number>;
}

/** Maximum age of a signature before it's considered stale (5 minutes) */
const MAX_SIGNATURE_AGE_SECONDS = 300;

/**
 * Parse the Signature-Input header value.
 *
 * Format: sig1=("@method" "@target-uri" "content-digest" "date");
 *         created=1733000000;keyid="app_abc";alg="ecdsa-p256-sha256"
 */
export function parseSignatureInput(input: string): SignatureInput | null {
  try {
    // Match the component list: ("comp1" "comp2" ...)
    const listMatch = input.match(/\(([^)]*)\)/);
    if (!listMatch) return null;

    const components = listMatch[1]
      .split(/\s+/)
      .map((c) => c.replace(/"/g, ''))
      .filter(Boolean);

    // Parse parameters after the closing paren
    const paramStr = input.slice(input.indexOf(')') + 1);
    const params: Record<string, string | number> = {};

    for (const match of paramStr.matchAll(/;(\w+)=(?:"([^"]*)"|(\d+))/g)) {
      const key = match[1];
      const value = match[2] !== undefined ? match[2] : Number(match[3]);
      params[key] = value;
    }

    return { components, params };
  } catch (err) {
    logger.debug({ err, input }, 'Failed to parse Signature-Input');
    return null;
  }
}

/**
 * Build the signature base string from a request and parsed input.
 *
 * The signature base is the canonicalized representation of the
 * signed components, one per line:
 *   "@method": GET
 *   "@target-uri": https://example.com/api/v1/foo
 *   "content-digest": sha-256=:base64hash:
 *   "@signature-params": ("@method" "@target-uri" ...);created=123;keyid="x"
 */
export function buildSignatureBase(req: Request, sigInput: SignatureInput, rawInputStr: string): string {
  const lines: string[] = [];

  for (const component of sigInput.components) {
    let value: string;

    switch (component) {
      case '@method':
        value = req.method.toUpperCase();
        break;
      case '@target-uri':
        value = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        break;
      case '@path':
        value = req.path;
        break;
      case '@authority':
        value = req.get('host') || '';
        break;
      default:
        // Regular header
        value = req.get(component) || '';
        break;
    }

    lines.push(`"${component}": ${value}`);
  }

  // Append the @signature-params component
  // Extract just the signature parameters portion (everything after sig label)
  const sigParamsValue = rawInputStr.replace(/^\w+=/, '');
  lines.push(`"@signature-params": ${sigParamsValue}`);

  return lines.join('\n');
}

/**
 * Verify an HTTP message signature on a request.
 *
 * Checks:
 * 1. Signature-Input and Signature headers are present
 * 2. Signature is not too old (replay protection)
 * 3. Signature base matches the signed components
 * 4. Cryptographic signature is valid against the provided public key
 *
 * Returns the keyid from the signature params on success, null on failure.
 */
export function verifyRequestSignature(
  req: Request,
  publicKey: crypto.KeyObject
): { valid: boolean; keyId?: string; error?: string } {
  const signatureInputHeader = req.get('signature-input');
  const signatureHeader = req.get('signature');

  if (!signatureInputHeader || !signatureHeader) {
    return { valid: false, error: 'Missing Signature or Signature-Input header' };
  }

  // Parse input
  const sigInput = parseSignatureInput(signatureInputHeader);
  if (!sigInput) {
    return { valid: false, error: 'Malformed Signature-Input header' };
  }

  // Check signature age
  const created = sigInput.params.created;
  if (typeof created === 'number') {
    const age = Math.floor(Date.now() / 1000) - created;
    if (age > MAX_SIGNATURE_AGE_SECONDS) {
      return { valid: false, error: `Signature too old (${age}s)` };
    }
    if (age < -30) {
      return { valid: false, error: 'Signature created in the future' };
    }
  }

  // Build signature base
  const signatureBase = buildSignatureBase(req, sigInput, signatureInputHeader);

  // Extract raw signature bytes (format: sig1=:base64:)
  const sigMatch = signatureHeader.match(/:([A-Za-z0-9+/=]+):/);
  if (!sigMatch) {
    return { valid: false, error: 'Malformed Signature header' };
  }
  const signatureBytes = Buffer.from(sigMatch[1], 'base64');

  // Determine algorithm from params or key
  const algParam = sigInput.params.alg as string | undefined;
  const nodeAlg = mapAlgorithm(algParam, publicKey);

  // Verify
  try {
    const verifier = crypto.createVerify(nodeAlg);
    verifier.update(signatureBase);
    const valid = verifier.verify(publicKey, signatureBytes);

    return {
      valid,
      keyId: sigInput.params.keyid as string | undefined,
      error: valid ? undefined : 'Signature verification failed',
    };
  } catch (err) {
    logger.debug({ err }, 'Signature verification threw');
    return { valid: false, error: 'Signature verification error' };
  }
}

/**
 * Map an HTTP Message Signatures algorithm identifier to a Node.js algorithm.
 */
function mapAlgorithm(alg: string | undefined, key: crypto.KeyObject): string {
  if (alg) {
    const map: Record<string, string> = {
      'ecdsa-p256-sha256': 'SHA256',
      'rsa-pss-sha256': 'SHA256',
      'rsa-v1_5-sha256': 'SHA256',
      'ed25519': 'ed25519',
    };
    if (map[alg]) return map[alg];
  }

  // Infer from key type
  const keyType = key.asymmetricKeyType;
  if (keyType === 'ec') return 'SHA256';
  if (keyType === 'rsa' || keyType === 'rsa-pss') return 'SHA256';
  if (keyType === 'ed25519') return 'ed25519';

  return 'SHA256';
}
