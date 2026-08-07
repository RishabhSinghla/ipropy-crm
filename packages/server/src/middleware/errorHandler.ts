import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { reportError } from '../utils/errorReporter.js';
import { config } from '../config.js';

function reqId(req: Request): string | undefined {
  return (req as Request & { id?: string }).id;
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    error: 'not_found',
    message: `No route for ${req.method} ${req.path}`,
  });
}

/** Turn Postgres constraint violations into messages a user can act on. */
function translatePgError(err: { code?: string; detail?: string; constraint?: string; column?: string; table?: string }): { status: number; code: string; message: string } | null {
  switch (err.code) {
    case '23505':
      return { status: 409, code: 'duplicate', message: 'A record with these details already exists.' };
    case '23503':
      return { status: 409, code: 'foreign_key', message: 'This record is referenced elsewhere and cannot be changed or removed.' };
    case '23502':
      return { status: 422, code: 'missing_field', message: `${err.column ?? 'A required field'} cannot be empty.` };
    case '22P02':
      return { status: 400, code: 'invalid_input', message: 'One of the values has the wrong format.' };
    case '42703':
      return { status: 400, code: 'unknown_field', message: 'Unknown field referenced in the request.' };
    case '57014':
      return { status: 504, code: 'query_timeout', message: 'That query took too long. Try narrowing the filters.' };
    default:
      return null;
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;

  if (err instanceof ZodError) {
    res.status(422).json({
      error: 'validation_error',
      message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      details: err.issues,
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, path: req.path, requestId: reqId(req), userId: req.user?.id }, 'request failed');
      reportError(err, { path: req.path, requestId: reqId(req), userId: req.user?.id });
    } else {
      logger.debug({ code: err.code, path: req.path, requestId: reqId(req) }, err.message);
    }
    res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  const pg = translatePgError(err as { code?: string });
  if (pg) {
    logger.warn({ err, path: req.path, requestId: reqId(req) }, 'database constraint violation');
    res.status(pg.status).json({ error: pg.code, message: pg.message });
    return;
  }

  logger.error({ err, path: req.path, requestId: reqId(req), userId: req.user?.id }, 'unhandled error');
  reportError(err, { path: req.path, requestId: reqId(req), userId: req.user?.id });
  res.status(500).json({
    error: 'internal_error',
    message: 'Something went wrong on our end.',
    ...(config.isProd ? {} : { detail: err instanceof Error ? err.message : String(err) }),
  });
}

/** Wrap an async handler so rejections reach the error middleware. */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req as T, res, next).catch(next);
  };
}
