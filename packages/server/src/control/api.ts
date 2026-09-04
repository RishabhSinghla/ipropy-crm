/**
 * The operator console's API.
 *
 * Everything the `tenant` command line does, over HTTP, so the same work can be
 * done from a screen. The command line stays the source of truth for anything
 * destructive or slow — this deliberately does not expose `create`, because
 * provisioning takes tens of seconds and belongs on a machine with the repo
 * checked out.
 *
 * Authentication is a single shared operator token, not a user account. That is
 * the honest shape for a one-person internal tool, and it is stated plainly here
 * so nobody mistakes it for a login system: there is no per-person audit trail,
 * and rotating the token signs everyone out. When a second person needs their
 * own access, this is the thing to replace.
 */
import express from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSubscription, suspendLapsed } from './billing.js';
import { formatPrice, PLANS } from './plans.js';
import { approveSignup, listSignups, rejectSignup } from './signups.js';
import { setTenantService } from './service.js';
import * as store from './store.js';
import type { TenantStatus } from './types.js';

/**
 * With no `CONTROL_OPERATOR_TOKEN` set, the console is open — but only outside
 * production, and it says so loudly on every request. The alternative is a
 * developer who cannot see their own local console without inventing a secret,
 * which is how a hardcoded default token ends up in a repository.
 */
export function operatorAuth(): express.RequestHandler {
  const token = config.control.operatorToken;

  return (req, res, next) => {
    if (!token) {
      if (config.isProd) {
        res.status(503).json({ error: 'CONTROL_OPERATOR_TOKEN must be set in production' });
        return;
      }
      res.setHeader('x-operator-auth', 'open-in-development');
      next();
      return;
    }

    const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (provided !== token) {
      res.status(401).json({ error: 'unauthorised' });
      return;
    }
    next();
  };
}

/*
  Route parameters here are plain strings, and Express 5's types say
  `string | string[]` because a named wildcard can span segments. There is no
  wildcard on this router at all, so the narrower type is the accurate one.
  Mirrors `AppRequest` in middleware/errorHandler.ts.
*/
type ControlRequest = express.Request<Record<string, string>>;

const asyncRoute = (
  fn: (req: ControlRequest, res: express.Response, next: express.NextFunction) => Promise<unknown> | unknown,
): express.RequestHandler => (req, res, next) => {
  // Narrowed once, at the boundary, rather than at every handler.
  void Promise.resolve(fn(req as ControlRequest, res, next)).catch(next);
};

export function operatorRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.use(operatorAuth());

  /** Everything the dashboard header shows, in one call. */
  router.get('/overview', asyncRoute(async (_req, res) => {
    const tenants = await store.listTenants();
    const pending = await listSignups('pending');

    const byStatus = tenants.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});

    res.json({
      counts: {
        total: tenants.length,
        active: byStatus.active ?? 0,
        suspended: byStatus.suspended ?? 0,
        failed: byStatus.failed ?? 0,
        pendingSignups: pending.length,
      },
      billingConfigured: Boolean(config.billing.keyId && config.billing.webhookSecret),
      signupsOpen: config.control.signupsOpen,
      openAccess: !config.control.operatorToken,
    });
  }));

  router.get('/tenants', asyncRoute(async (_req, res) => {
    const tenants = await store.listTenants();
    // The subscription is a second table; the console wants one row per customer.
    const rows = await Promise.all(tenants.map(async (tenant) => ({
      ...tenant,
      subscription: await getSubscription(tenant.id),
    })));
    res.json(rows);
  }));

  router.get('/tenants/:slug', asyncRoute(async (req, res) => {
    const tenant = await store.requireBySlug(req.params.slug);
    const { databaseUrl: _secret, ...safe } = tenant;
    res.json({
      ...safe,
      subscription: await getSubscription(tenant.id),
      events: await store.listEvents(tenant.id, 50),
    });
  }));

  /*
    `:action`, not `:action(suspend|resume)`.

    Express 5 replaced path-to-regexp, and an inline pattern on a parameter is
    no longer parsed — it throws while the route is being registered, so the
    whole console fails to start rather than one endpoint misbehaving.

    The check moves into the handler, which is better anyway: the old form
    answered 404 for a bad action, as though the tenant did not exist. Now it
    says what was wrong with the request.
  */
  router.post('/tenants/:slug/:action', asyncRoute(async (req, res) => {
    const action = req.params.action;
    if (action !== 'suspend' && action !== 'resume') {
      res.status(400).json({ error: `Unknown action "${action}" — expected suspend or resume.` });
      return;
    }
    const tenant = await store.requireBySlug(req.params.slug);
    const status: TenantStatus = action === 'suspend' ? 'suspended' : 'active';
    const result = await setTenantService(tenant.id, status, 'from the operator console');
    logger.info({ slug: tenant.slug, status, ...result }, 'status changed from the console');
    // The console shows this: a suspension their database never received has
    // not actually stopped anybody.
    res.json({ slug: tenant.slug, status, reachedTheirDatabase: result.reachedTheirDatabase });
  }));

  router.get('/signups', asyncRoute(async (req, res) => {
    const status = (req.query.status as 'pending' | 'approved' | 'rejected') ?? 'pending';
    res.json(await listSignups(status));
  }));

  /**
   * The one slow call. Provisioning runs migrations and seeds a database, so the
   * console shows a spinner and waits rather than pretending it is instant.
   */
  router.post('/signups/:id/approve', asyncRoute(async (req, res) => {
    const result = await approveSignup(req.params.id);
    res.json({
      slug: result.request.slug,
      adminEmail: result.request.adminEmail,
      // Returned once, never stored. The console must show it immediately.
      adminPassword: result.adminPassword,
    });
  }));

  router.post('/signups/:id/reject', asyncRoute(async (req, res) => {
    await rejectSignup(req.params.id, (req.body as { note?: string }).note);
    res.json({ ok: true });
  }));

  router.get('/plans', (_req, res) => {
    res.json(Object.values(PLANS).map((plan) => ({ ...plan, price: formatPrice(plan) })));
  });

  router.post('/lapse', asyncRoute(async (_req, res) => {
    res.json({ suspended: await suspendLapsed() });
  }));

  // Errors become readable JSON rather than an HTML stack trace in a fetch().
  router.use(((err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    logger.error({ err }, 'operator API error');
    res.status(400).json({ error: message });
  }) as express.ErrorRequestHandler);

  return router;
}
