import sanitizeHtml from 'sanitize-html';

/**
 * Sanitizes HTML content to prevent XSS attacks.
 * Allows only safe HTML tags and attributes.
 */
export function sanitizeUserContent(content: string): string {
  return sanitizeHtml(content, {
    allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li', 'code', 'pre'],
    allowedAttributes: {
      'a': ['href', 'title'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      'a': ['http', 'https', 'mailto'],
    },
    disallowedTagsMode: 'discard',
    selfClosing: ['br'],
  });
}

/**
 * Sanitizes plain text content by stripping all HTML.
 * Use this for fields that should contain only plain text.
 */
export function sanitizePlainText(content: string): string {
  return sanitizeHtml(content, {
    allowedTags: [],
    allowedAttributes: {},
  });
}

/**
 * Validates and sanitizes webhook URLs.
 * Returns the sanitized URL if valid, or throws an error.
 */
export function validateWebhookUrl(url: string, allowedHostnames?: string[]): string {
  try {
    const parsed = new URL(url);

    // Only allow https:// scheme
    if (parsed.protocol !== 'https:') {
      throw new Error('Webhook URL must use https:// protocol');
    }

    // Check hostname allowlist if provided
    if (allowedHostnames && allowedHostnames.length > 0) {
      const hostname = parsed.hostname.toLowerCase();
      const isAllowed = allowedHostnames.some(allowed => {
        // Support wildcard subdomains (e.g., *.example.com)
        if (allowed.startsWith('*.')) {
          const domain = allowed.slice(2).toLowerCase();
          // Check if hostname ends with the domain (after the wildcard)
          return hostname === domain || hostname.endsWith('.' + domain);
        }
        return hostname === allowed.toLowerCase();
      });

      if (!isAllowed) {
        throw new Error(`Webhook hostname not in allowlist. Allowed: ${allowedHostnames.join(', ')}`);
      }
    }

    // Check for open redirect patterns
    if (parsed.pathname.includes('//')) {
      throw new Error('Invalid URL: path contains potential open redirect pattern');
    }

    return url;
  } catch (error: any) {
    if (error instanceof TypeError) {
      throw new Error('Invalid URL format');
    }
    throw error;
  }
}

/**
 * Validates ATProto NSID (Namespaced Identifier) format for collection names.
 * NSID format: reverse domain name + name segment (e.g., com.example.fooBar)
 *
 * Rules:
 * - Must have at least 3 segments (a.b.c)
 * - Max length: 317 characters
 * - Domain authority: lowercase letters, digits, hyphens (not at start/end)
 * - Name segment: letters and digits only, no leading digit
 */
export function validateNSID(nsid: string): boolean {
  // Max length check
  if (nsid.length > 317) {
    return false;
  }

  // Must have at least 3 segments
  const segments = nsid.split('.');
  if (segments.length < 3) {
    return false;
  }

  // Validate domain authority segments (all but last)
  const domainSegments = segments.slice(0, -1);
  for (let i = 0; i < domainSegments.length; i++) {
    const segment = domainSegments[i];

    // Length check: 1-63 characters
    if (segment.length < 1 || segment.length > 63) {
      return false;
    }

    // First segment (TLD) cannot start with digit
    if (i === 0 && /^\d/.test(segment)) {
      return false;
    }

    // Must match: lowercase letters, digits, hyphens (not at start/end)
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(segment.toLowerCase())) {
      return false;
    }
  }

  // Validate name segment (last segment)
  const nameSegment = segments[segments.length - 1];

  // Length check: 1-63 characters
  if (nameSegment.length < 1 || nameSegment.length > 63) {
    return false;
  }

  // Must not start with digit
  if (/^\d/.test(nameSegment)) {
    return false;
  }

  // Must match: letters and digits only (case-sensitive)
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(nameSegment)) {
    return false;
  }

  return true;
}
