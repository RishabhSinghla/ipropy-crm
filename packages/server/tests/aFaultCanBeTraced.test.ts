/**
 * A server fault says which fault it was.
 *
 * The 500 body was `{error, message}` and nothing else. The real error goes to
 * the log and to Sentry tagged with the request id, and none of that reached
 * the person watching the save fail — so "Could not update Lead Status /
 * Something went wrong on our end" could not be matched to a log line. Three
 * different fields failing that way on production produced three reports and
 * no way to tell whether they were one fault or three.
 *
 * The id identifies a request and nothing else; it is already on every response
 * as x-request-id.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { BadRequestError } from '../src/utils/errors.js';

/** The smallest app that reaches the real error middleware. */
function appThatThrows(err: unknown): express.Express {
  const app = express();
  app.use((req, _res, next) => { (req as express.Request & { id?: string }).id = 'req-abc123'; next(); });
  app.get('/boom', () => { throw err; });
  app.use(errorHandler as express.ErrorRequestHandler);
  return app;
}

describe('an unhandled fault', () => {
  it('returns a reference the log can be searched by', async () => {
    const res = await request(appThatThrows(new Error('a column that is not there'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Something went wrong on our end.');
    expect(res.body.requestId, 'without this a 500 cannot be traced to its log line').toBe('req-abc123');
  });

  it('keeps what broke out of the message the user is shown', async () => {
    const res = await request(appThatThrows(new Error('password=hunter2 in the connection string'))).get('/boom');
    // `detail` is added outside production on purpose, for whoever is running
    // it locally. The user-facing `message` is the generic one either way, and
    // it is the only part the toast prints.
    expect(res.body.message).toBe('Something went wrong on our end.');
    expect(String(res.body.message)).not.toContain('hunter2');
  });
});

describe('a fault that is the caller’s', () => {
  it('keeps its own message, with no reference stapled on', async () => {
    const res = await request(appThatThrows(new BadRequestError('Mobile is required'))).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Mobile is required');
    expect(res.body.requestId, 'a message the user can act on needs no reference').toBeUndefined();
  });
});
