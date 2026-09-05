export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code = 'internal_error',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, 400, 'bad_request', details);
  }
}

/*
  Not a client mistake and not a server bug: a feature is switched off because
  the configuration it needs is missing. The caller may retry after an admin
  has set the value, which is what distinguishes it from 400 and 500.
*/
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable', details?: unknown) {
    super(message, 503, 'service_unavailable', details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 422, 'validation_error', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'forbidden');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'not_found');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) {
    super(message, 409, 'conflict', details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, 429, 'rate_limited');
  }
}

export class IntegrationError extends AppError {
  constructor(provider: string, message: string, details?: unknown) {
    super(`[${provider}] ${message}`, 502, 'integration_error', details);
  }
}
