/**
 * Where an unhandled error goes.
 *
 * This file used to hand-roll the reporting: it POSTed a JSON body straight at
 * `config.sentry.dsn`. That was never going to work — a DSN is an address with
 * a key in it, not an endpoint, and Sentry ingests at `/api/<project>/envelope/`
 * with the key in a header. So every report since this was written went to a
 * URL that could not accept it.
 *
 * Two further things it got wrong, worth recording because they are easy to
 * reintroduce. It sent the error's *message* and no stack, which is the half
 * that does not tell you where the problem is. And it throttled to one report
 * every ten seconds globally, so a crash loop reported once and any unrelated
 * error in the same ten seconds was dropped silently.
 *
 * The real SDK handles all of that — batching, retries, stack traces, grouping.
 * This file stays as the single import the rest of the code uses, so no call
 * site needs to know which library is behind it.
 */
export { reportError } from '../core/observability/sentry.js';
