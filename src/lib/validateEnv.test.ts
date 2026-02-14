/**
 * Unit tests for validateEnv.ts
 * Tests environment variable validation at startup
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateEnvironment, EnvValidationError } from './validateEnv';
import * as configModule from '../config';

// Mock the config module
vi.mock('../config', () => ({
  config: {
    encryptionKey: '',
    cookieSecret: '',
    nodeEnv: 'development',
    databaseUrl: '',
    serviceUrl: undefined,
  },
}));

describe('validateEnv.ts', () => {
  beforeEach(() => {
    // Reset config values before each test
    (configModule.config as any).encryptionKey = '';
    (configModule.config as any).cookieSecret = '';
    (configModule.config as any).nodeEnv = 'development';
    (configModule.config as any).databaseUrl = '';
    (configModule.config as any).serviceUrl = undefined;
  });

  describe('validateEnvironment - ENCRYPTION_KEY', () => {
    it('should throw error when ENCRYPTION_KEY is missing', () => {
      (configModule.config as any).encryptionKey = '';
      (configModule.config as any).cookieSecret = 'a'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/ENCRYPTION_KEY is required/);
    });

    it('should throw error when ENCRYPTION_KEY is too short', () => {
      (configModule.config as any).encryptionKey = 'abc123';
      (configModule.config as any).cookieSecret = 'a'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/must be exactly 64 characters/);
    });

    it('should throw error when ENCRYPTION_KEY is not hex', () => {
      (configModule.config as any).encryptionKey = 'g'.repeat(64);
      (configModule.config as any).cookieSecret = 'a'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/must be a valid hexadecimal string/);
    });

    it('should pass when ENCRYPTION_KEY is valid 64-char hex', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).not.toThrow();
    });

    it('should pass when ENCRYPTION_KEY uses mixed case hex', () => {
      (configModule.config as any).encryptionKey = 'AbCdEf0123456789'.repeat(4);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).not.toThrow();
    });
  });

  describe('validateEnvironment - COOKIE_SECRET', () => {
    it('should throw error when COOKIE_SECRET is missing', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = '';
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/COOKIE_SECRET is required/);
    });

    it('should throw error when COOKIE_SECRET is too short', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'short';
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/must be at least 32 characters/);
    });

    it('should throw error when COOKIE_SECRET uses insecure default value', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'open-social-default-secret-change-in-production';
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/insecure default value/);
    });

    it('should throw error when COOKIE_SECRET uses .env.example default', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'generate_a_random_secret_here_at_least_32_chars';
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/insecure default value/);
    });

    it('should pass when COOKIE_SECRET is valid and long enough', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'my-secure-random-cookie-secret-12345678';
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';

      expect(() => validateEnvironment()).not.toThrow();
    });
  });

  describe('validateEnvironment - NODE_ENV', () => {
    it('should require NODE_ENV=production when SERVICE_URL is production HTTPS', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';
      (configModule.config as any).serviceUrl = 'https://api.example.com';
      (configModule.config as any).nodeEnv = 'development';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/NODE_ENV must be set to 'production'/);
    });

    it('should pass when NODE_ENV=production with production SERVICE_URL', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';
      (configModule.config as any).serviceUrl = 'https://api.example.com';
      (configModule.config as any).nodeEnv = 'production';

      expect(() => validateEnvironment()).not.toThrow();
    });

    it('should allow NODE_ENV=development for localhost HTTPS URLs', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';
      (configModule.config as any).serviceUrl = 'https://localhost:3001';
      (configModule.config as any).nodeEnv = 'development';

      expect(() => validateEnvironment()).not.toThrow();
    });

    it('should allow NODE_ENV=development with HTTP URLs', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://localhost/test';
      (configModule.config as any).serviceUrl = 'http://localhost:3001';
      (configModule.config as any).nodeEnv = 'development';

      expect(() => validateEnvironment()).not.toThrow();
    });
  });

  describe('validateEnvironment - DATABASE_URL', () => {
    it('should throw error when DATABASE_URL is missing', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = '';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/DATABASE_URL is required/);
    });

    it('should throw error when DATABASE_URL is not a PostgreSQL URL', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'mysql://localhost/test';

      expect(() => validateEnvironment()).toThrow(EnvValidationError);
      expect(() => validateEnvironment()).toThrow(/must be a valid PostgreSQL connection string/);
    });

    it('should pass with postgresql:// URL', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgresql://user:pass@localhost/db';

      expect(() => validateEnvironment()).not.toThrow();
    });

    it('should pass with postgres:// URL', () => {
      (configModule.config as any).encryptionKey = 'a'.repeat(64);
      (configModule.config as any).cookieSecret = 'b'.repeat(32);
      (configModule.config as any).databaseUrl = 'postgres://user:pass@localhost/db';

      expect(() => validateEnvironment()).not.toThrow();
    });
  });

  describe('validateEnvironment - multiple errors', () => {
    it('should report all validation errors at once', () => {
      (configModule.config as any).encryptionKey = '';
      (configModule.config as any).cookieSecret = '';
      (configModule.config as any).databaseUrl = '';

      try {
        validateEnvironment();
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvValidationError);
        const message = (error as Error).message;
        expect(message).toContain('ENCRYPTION_KEY is required');
        expect(message).toContain('COOKIE_SECRET is required');
        expect(message).toContain('DATABASE_URL is required');
      }
    });
  });

  describe('validateEnvironment - complete valid config', () => {
    it('should pass with all valid required environment variables', () => {
      (configModule.config as any).encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      (configModule.config as any).cookieSecret = 'my-very-secure-random-cookie-secret-value-here';
      (configModule.config as any).databaseUrl = 'postgresql://user:password@localhost:5432/opensocial';
      (configModule.config as any).nodeEnv = 'development';
      (configModule.config as any).serviceUrl = 'http://localhost:3001';

      expect(() => validateEnvironment()).not.toThrow();
    });
  });
});
