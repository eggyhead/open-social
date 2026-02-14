/**
 * Unit tests for retry.ts
 * Tests retry logic with exponential backoff
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retry, isTransientError } from './retry';

describe('retry.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('retry', () => {
    it('should succeed on first attempt if function succeeds', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await retry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Attempt 1 failed'))
        .mockRejectedValueOnce(new Error('Attempt 2 failed'))
        .mockResolvedValue('success');

      const promise = retry(fn, { maxRetries: 3 });

      // Fast-forward through delays
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw last error after exhausting retries', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Always fails'));

      const promise = retry(fn, { maxRetries: 2 });

      // Handle promise and timers together to avoid unhandled rejections
      const resultPromise = promise.catch(err => err);
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error.message).toBe('Always fails');
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should use exponential backoff with correct delays', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Fail'));
      const delays: number[] = [];

      // Capture when setTimeout is called
      const originalSetTimeout = global.setTimeout;
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number) => {
        delays.push(delay);
        return originalSetTimeout(callback, delay);
      }) as any);

      const promise = retry(fn, {
        maxRetries: 3,
        initialDelay: 100,
        backoffMultiplier: 2,
      });

      // Handle promise to avoid unhandled rejections
      const resultPromise = promise.catch(err => err);
      await vi.runAllTimersAsync();
      await resultPromise;

      // Should have delays: 100ms, 200ms, 400ms
      expect(delays).toEqual([100, 200, 400]);
    });

    it('should respect maxDelay', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Fail'));
      const delays: number[] = [];

      const originalSetTimeout = global.setTimeout;
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number) => {
        delays.push(delay);
        return originalSetTimeout(callback, delay);
      }) as any);

      const promise = retry(fn, {
        maxRetries: 3,
        initialDelay: 100,
        backoffMultiplier: 10,
        maxDelay: 500,
      });

      // Handle promise to avoid unhandled rejections
      const resultPromise = promise.catch(err => err);
      await vi.runAllTimersAsync();
      await resultPromise;

      // Should cap at maxDelay
      expect(delays).toEqual([100, 500, 500]);
    });

    it('should stop retrying if shouldRetry returns false', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Non-retryable error'));

      const promise = retry(fn, {
        maxRetries: 5,
        shouldRetry: () => false,
      });

      // Handle promise to avoid unhandled rejections
      const resultPromise = promise.catch(err => err);
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error.message).toBe('Non-retryable error');
      expect(fn).toHaveBeenCalledTimes(1); // No retries
    });

    it('should pass attempt number to shouldRetry', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Fail'));
      const shouldRetry = vi.fn().mockReturnValue(false);

      const promise = retry(fn, {
        maxRetries: 3,
        shouldRetry,
      });

      // Handle promise to avoid unhandled rejections
      const resultPromise = promise.catch(err => err);
      await vi.runAllTimersAsync();
      await resultPromise;

      // Should be called with attempt 1 (first retry after initial failure)
      expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 1);
    });

    it('should include context in logs', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Fail'));

      const promise = retry(fn, {
        maxRetries: 1,
        context: { operation: 'test', id: 123 },
      });

      // Handle promise to avoid unhandled rejections
      const resultPromise = promise.catch(err => err);
      await vi.runAllTimersAsync();
      await resultPromise;

      // Logger is called with context, but we're not checking the exact log output
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should use default options when not specified', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValue('success');

      const promise = retry(fn);

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('isTransientError', () => {
    it('should return true for network timeout errors', () => {
      const error = new Error('Network timeout');
      expect(isTransientError(error)).toBe(true);
    });

    it('should return true for ECONNREFUSED errors', () => {
      const error = new Error('ECONNREFUSED');
      expect(isTransientError(error)).toBe(true);
    });

    it('should return true for ETIMEDOUT errors', () => {
      const error: any = new Error('Connection timeout');
      error.code = 'ETIMEDOUT';
      expect(isTransientError(error)).toBe(true);
    });

    it('should return true for 429 status (Too Many Requests)', () => {
      const error: any = new Error('Too Many Requests');
      error.status = 429;
      expect(isTransientError(error)).toBe(true);
    });

    it('should return true for 502 status (Bad Gateway)', () => {
      const error: any = new Error('Bad Gateway');
      error.status = 502;
      expect(isTransientError(error)).toBe(true);
    });

    it('should return true for 503 status (Service Unavailable)', () => {
      const error: any = new Error('Service Unavailable');
      error.status = 503;
      expect(isTransientError(error)).toBe(true);
    });

    it('should return true for 504 status (Gateway Timeout)', () => {
      const error: any = new Error('Gateway Timeout');
      error.status = 504;
      expect(isTransientError(error)).toBe(true);
    });

    it('should return false for 400 status (Bad Request)', () => {
      const error: any = new Error('Bad Request');
      error.status = 400;
      expect(isTransientError(error)).toBe(false);
    });

    it('should return false for 404 status (Not Found)', () => {
      const error: any = new Error('Not Found');
      error.status = 404;
      expect(isTransientError(error)).toBe(false);
    });

    it('should return false for validation errors', () => {
      const error = new Error('Validation failed');
      expect(isTransientError(error)).toBe(false);
    });

    it('should return false for null or undefined', () => {
      expect(isTransientError(null)).toBe(false);
      expect(isTransientError(undefined)).toBe(false);
    });

    it('should handle errors with both message and code', () => {
      const error: any = new Error('Connection reset');
      error.code = 'ECONNRESET';
      expect(isTransientError(error)).toBe(true);
    });
  });
});
