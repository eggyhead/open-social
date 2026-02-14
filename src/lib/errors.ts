import { logger } from './logger';

/**
 * Base application error with additional context
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, any>,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Log an error with full context
 *
 * @param error - The error to log
 * @param context - Additional context to include in the log
 * @param message - Optional custom message (defaults to error message)
 */
export function logError(
  error: any,
  context: Record<string, any> = {},
  message?: string
): void {
  const errorMessage = message || error?.message || 'Unknown error';

  const logContext = {
    ...context,
    error: error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : error,
  };

  logger.error(logContext, errorMessage);
}

/**
 * Log a warning with context
 *
 * @param message - Warning message
 * @param context - Additional context to include in the log
 */
export function logWarning(
  message: string,
  context: Record<string, any> = {}
): void {
  logger.warn(context, message);
}

/**
 * Create a standardized error response object
 *
 * @param message - Error message
 * @param requestId - Optional request/correlation ID
 * @param details - Optional additional details
 */
export function createErrorResponse(
  message: string,
  requestId?: string,
  details?: any
): { error: string; requestId?: string; details?: any } {
  const response: any = { error: message };

  if (requestId) {
    response.requestId = requestId;
  }

  if (details) {
    response.details = details;
  }

  return response;
}

/**
 * Extract a user-friendly error message from an error object
 *
 * @param error - The error to extract message from
 * @param fallback - Fallback message if extraction fails
 */
export function getErrorMessage(error: any, fallback = 'An unexpected error occurred'): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error?.message) {
    return error.message;
  }

  return fallback;
}
