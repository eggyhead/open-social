import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db';
import type { AuthenticatedRequest } from './auth';

// Default rate limit: 1000 requests per minute per app
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_REQUESTS = 1000;

export function createRateLimiter(db: Kysely<Database>) {
  return rateLimit({
    windowMs: DEFAULT_WINDOW_MS,
    max: async (req: Request) => {
      const authReq = req as AuthenticatedRequest;
      if (authReq.app_data) {
        try {
          const appLimit = await db
            .selectFrom('rate_limits')
            .select('max_requests')
            .where('app_id', '=', authReq.app_data.app_id)
            .executeTakeFirst();

          if (appLimit) {
            return appLimit.max_requests;
          }
        } catch {
          // Table may not exist yet, use default
        }
      }
      return DEFAULT_MAX_REQUESTS;
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const authReq = req as AuthenticatedRequest;
      if (authReq.app_data?.app_id) {
        return authReq.app_data.app_id;
      }
      return ipKeyGenerator(req.ip ?? 'unknown');
    },
    handler: (req: Request, res: Response) => {
      res.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: Math.ceil(DEFAULT_WINDOW_MS / 1000),
      });
    },
  });
}

// Stricter rate limit for auth endpoints
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: 'Too many authentication attempts',
      message: 'Please try again later.',
      retryAfter: 900,
    });
  },
});

// Rate limiter for expensive search operations
export const searchRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 searches per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.app_data?.app_id) {
      return `search:${authReq.app_data.app_id}`;
    }
    return `search:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: 'Too many search requests',
      message: 'Search rate limit exceeded. Please try again later.',
      retryAfter: 60,
    });
  },
});

// Rate limiter for member listing operations
export const memberListRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 member list requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.app_data?.app_id) {
      return `members:${authReq.app_data.app_id}`;
    }
    return `members:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: 'Too many member listing requests',
      message: 'Member listing rate limit exceeded. Please try again later.',
      retryAfter: 60,
    });
  },
});

// Rate limiter for audit log queries (admin operation, more restrictive)
export const auditLogRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 audit log queries per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.app_data?.app_id) {
      return `audit:${authReq.app_data.app_id}`;
    }
    return `audit:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: 'Too many audit log requests',
      message: 'Audit log rate limit exceeded. Please try again later.',
      retryAfter: 60,
    });
  },
});

