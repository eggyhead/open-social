import { logger } from './logger';

export interface RetryOptions {
  /**
   * Maximum number of retry attempts
   * @default 3
   */
  maxRetries?: number;

  /**
   * Initial delay in milliseconds before the first retry
   * @default 1000
   */
  initialDelay?: number;

  /**
   * Maximum delay in milliseconds between retries
   * @default 10000
   */
  maxDelay?: number;

  /**
   * Multiplier for exponential backoff
   * @default 2
   */
  backoffMultiplier?: number;

  /**
   * Function to determine if an error should trigger a retry
   * @default () => true
   */
  shouldRetry?: (error: any, attempt: number) => boolean;

  /**
   * Optional context for logging
   */
  context?: Record<string, any>;
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - The function to retry
 * @param options - Retry options
 * @returns The result of the function if successful
 * @throws The last error if all retries fail
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffMultiplier = 2,
    shouldRetry = () => true,
    context = {},
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if we've exhausted all attempts
      if (attempt === maxRetries) {
        logger.error({
          ...context,
          error,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
        }, 'All retry attempts failed');
        break;
      }

      // Check if we should retry this error
      if (!shouldRetry(error, attempt + 1)) {
        logger.warn({
          ...context,
          error,
          attempt: attempt + 1,
        }, 'Error not retryable, aborting');
        break;
      }

      // Log retry attempt
      logger.warn({
        ...context,
        error: error instanceof Error ? error.message : String(error),
        attempt: attempt + 1,
        nextRetryIn: delay,
      }, 'Retrying after error');

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));

      // Calculate next delay with exponential backoff
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

/**
 * Check if an error is a transient network error that should be retried
 */
export function isTransientError(error: any): boolean {
  if (!error) return false;

  const message = error.message?.toLowerCase() || '';
  const code = error.code?.toLowerCase() || '';

  // Network errors
  if (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    code === 'etimedout' ||
    code === 'econnrefused' ||
    code === 'econnreset'
  ) {
    return true;
  }

  // HTTP errors that are typically transient
  if (error.status) {
    // 429 Too Many Requests
    // 502 Bad Gateway
    // 503 Service Unavailable
    // 504 Gateway Timeout
    return [429, 502, 503, 504].includes(error.status);
  }

  return false;
}
