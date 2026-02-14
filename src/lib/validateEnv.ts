/**
 * Environment variable validation at startup.
 * Ensures all required security-sensitive variables are set correctly.
 */

import { config } from '../config';

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates that ENCRYPTION_KEY is set and has the correct format.
 * Must be a 64-character hex string (32 bytes).
 */
function validateEncryptionKey(): void {
  const key = config.encryptionKey;

  if (!key) {
    throw new EnvValidationError(
      'ENCRYPTION_KEY is required. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (key.length !== 64) {
    throw new EnvValidationError(
      `ENCRYPTION_KEY must be exactly 64 characters (32 bytes hex). Current length: ${key.length}. ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new EnvValidationError(
      'ENCRYPTION_KEY must be a valid hexadecimal string (0-9, a-f, A-F). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
}

/**
 * Validates that COOKIE_SECRET is set and not using the insecure default.
 */
function validateCookieSecret(): void {
  const secret = config.cookieSecret;

  if (!secret) {
    throw new EnvValidationError(
      'COOKIE_SECRET is required. Generate a random secret with at least 32 characters.'
    );
  }

  const insecureDefaults = [
    'open-social-default-secret-change-in-production',
    'generate_a_random_secret_here_at_least_32_chars',
  ];

  if (insecureDefaults.includes(secret)) {
    throw new EnvValidationError(
      `COOKIE_SECRET is set to an insecure default value. Generate a secure random secret with at least 32 characters.`
    );
  }

  if (secret.length < 32) {
    throw new EnvValidationError(
      `COOKIE_SECRET must be at least 32 characters long. Current length: ${secret.length}`
    );
  }
}

/**
 * Validates NODE_ENV in production environments.
 * In production, NODE_ENV must be explicitly set to 'production'.
 */
function validateNodeEnv(): void {
  const nodeEnv = config.nodeEnv;

  // If SERVICE_URL is set and looks like a production URL (https, not localhost),
  // NODE_ENV must be 'production'
  const serviceUrl = config.serviceUrl;
  if (serviceUrl && serviceUrl.startsWith('https://') && !serviceUrl.includes('localhost')) {
    if (nodeEnv !== 'production') {
      throw new EnvValidationError(
        `NODE_ENV must be set to 'production' when SERVICE_URL is a production HTTPS URL. Current: '${nodeEnv}'`
      );
    }
  }
}

/**
 * Validates that DATABASE_URL is set.
 */
function validateDatabaseUrl(): void {
  const dbUrl = config.databaseUrl;

  if (!dbUrl) {
    throw new EnvValidationError(
      'DATABASE_URL is required. Set it to your PostgreSQL connection string.'
    );
  }

  // Basic validation that it looks like a connection string
  if (!dbUrl.includes('postgresql://') && !dbUrl.includes('postgres://')) {
    throw new EnvValidationError(
      'DATABASE_URL must be a valid PostgreSQL connection string (postgresql:// or postgres://)'
    );
  }
}

/**
 * Validates all required environment variables at startup.
 * Throws EnvValidationError if any validation fails.
 *
 * This should be called before starting the server to fail fast
 * if configuration is invalid.
 */
export function validateEnvironment(): void {
  const errors: string[] = [];

  try {
    validateEncryptionKey();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      errors.push(err.message);
    } else {
      throw err;
    }
  }

  try {
    validateCookieSecret();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      errors.push(err.message);
    } else {
      throw err;
    }
  }

  try {
    validateNodeEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      errors.push(err.message);
    } else {
      throw err;
    }
  }

  try {
    validateDatabaseUrl();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      errors.push(err.message);
    } else {
      throw err;
    }
  }

  if (errors.length > 0) {
    throw new EnvValidationError(
      'Environment validation failed:\n\n' + errors.map((err, i) => `${i + 1}. ${err}`).join('\n\n')
    );
  }
}
