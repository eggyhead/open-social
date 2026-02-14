/**
 * Unit tests for errors.ts
 * Tests error handling utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AppError,
  logError,
  logWarning,
  createErrorResponse,
  getErrorMessage,
} from './errors';
import { logger } from './logger';

// Mock the logger
vi.mock('./logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('errors.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('AppError', () => {
    it('should create an error with message', () => {
      const error = new AppError('Test error');

      expect(error.message).toBe('Test error');
      expect(error.name).toBe('AppError');
      expect(error).toBeInstanceOf(Error);
    });

    it('should create an error with context', () => {
      const error = new AppError('Test error', { userId: '123', action: 'login' });

      expect(error.message).toBe('Test error');
      expect(error.context).toEqual({ userId: '123', action: 'login' });
    });

    it('should create an error with status code', () => {
      const error = new AppError('Not found', { resource: 'user' }, 404);

      expect(error.message).toBe('Not found');
      expect(error.statusCode).toBe(404);
      expect(error.context).toEqual({ resource: 'user' });
    });

    it('should have a stack trace', () => {
      const error = new AppError('Test error');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('AppError');
    });
  });

  describe('logError', () => {
    it('should log an error with default message', () => {
      const error = new Error('Test error');
      logError(error);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            name: 'Error',
            message: 'Test error',
            stack: expect.any(String),
          }),
        }),
        'Test error'
      );
    });

    it('should log an error with custom message', () => {
      const error = new Error('Test error');
      logError(error, {}, 'Custom message');

      expect(logger.error).toHaveBeenCalledWith(
        expect.anything(),
        'Custom message'
      );
    });

    it('should log an error with additional context', () => {
      const error = new Error('Test error');
      logError(error, { userId: '123', operation: 'update' });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: '123',
          operation: 'update',
          error: expect.objectContaining({
            message: 'Test error',
          }),
        }),
        'Test error'
      );
    });

    it('should handle non-Error objects', () => {
      logError('String error', { context: 'test' });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'test',
          error: 'String error',
        }),
        'Unknown error'
      );
    });

    it('should handle null errors', () => {
      logError(null);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: null,
        }),
        'Unknown error'
      );
    });
  });

  describe('logWarning', () => {
    it('should log a warning message', () => {
      logWarning('Test warning');

      expect(logger.warn).toHaveBeenCalledWith({}, 'Test warning');
    });

    it('should log a warning with context', () => {
      logWarning('Test warning', { userId: '456', action: 'retry' });

      expect(logger.warn).toHaveBeenCalledWith(
        { userId: '456', action: 'retry' },
        'Test warning'
      );
    });
  });

  describe('createErrorResponse', () => {
    it('should create a basic error response', () => {
      const response = createErrorResponse('Something went wrong');

      expect(response).toEqual({
        error: 'Something went wrong',
      });
    });

    it('should include request ID when provided', () => {
      const response = createErrorResponse('Something went wrong', 'req-123');

      expect(response).toEqual({
        error: 'Something went wrong',
        requestId: 'req-123',
      });
    });

    it('should include details when provided', () => {
      const details = { field: 'email', reason: 'invalid format' };
      const response = createErrorResponse('Validation failed', undefined, details);

      expect(response).toEqual({
        error: 'Validation failed',
        details: { field: 'email', reason: 'invalid format' },
      });
    });

    it('should include both request ID and details', () => {
      const details = { code: 'AUTH_FAILED' };
      const response = createErrorResponse('Unauthorized', 'req-456', details);

      expect(response).toEqual({
        error: 'Unauthorized',
        requestId: 'req-456',
        details: { code: 'AUTH_FAILED' },
      });
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error object', () => {
      const error = new Error('Test error message');
      const message = getErrorMessage(error);

      expect(message).toBe('Test error message');
    });

    it('should return string directly', () => {
      const message = getErrorMessage('String error');

      expect(message).toBe('String error');
    });

    it('should use fallback for null', () => {
      const message = getErrorMessage(null);

      expect(message).toBe('An unexpected error occurred');
    });

    it('should use fallback for undefined', () => {
      const message = getErrorMessage(undefined);

      expect(message).toBe('An unexpected error occurred');
    });

    it('should use custom fallback', () => {
      const message = getErrorMessage(null, 'Custom fallback');

      expect(message).toBe('Custom fallback');
    });

    it('should use fallback for object without message', () => {
      const message = getErrorMessage({ code: 'ERR_UNKNOWN' });

      expect(message).toBe('An unexpected error occurred');
    });

    it('should extract message from object with message property', () => {
      const error = { message: 'Object error message' };
      const message = getErrorMessage(error);

      expect(message).toBe('Object error message');
    });
  });
});
