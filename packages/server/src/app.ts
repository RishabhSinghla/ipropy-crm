import express, { type Express, type Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from './config.js';
import { getServiceStatus } from './core/serviceStatus.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { verifyAccessToken } from './middleware/auth.js';
import { checkConnection } from './db/pool.js';

import { authRouter } from './api/routes/auth.js';
import { passkeyRouter } from './api/routes/passkeys.js';
import { pinAuthRouter } from './api/routes/pinAuth.js';
import { metadataRouter } from './api/routes/metadata.js';
import { recordsRouter } from './api/routes/records.js';
import { viewsRouter } from './api/routes/views.js';
import { dashboardsRouter, reportsRouter } from './api/routes/dashboards.js';
import { adminRouter } from './api/routes/admin.js';
import { commsRouter } from './api/routes/comms.js';
import { outreachRouter } from './api/routes/outreach.js';
import { deviceRouter } from './api/routes/device.js';
import { telephonyRouter } from './api/routes/telephony.js';
import { aiRouter } from './api/routes/ai.js';
import { webhooksRouter } from './api/routes/webhooks.js';
import { miscRouter } from './api/routes/misc.js';
import { captureRouter } from './api/routes/capture.js';
import { mcpRouter } from './api/routes/mcp.js';
import { publicRouter } from './api/routes/public.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet({
    // The API serves uploaded files inline; CSP is enforced by the web app.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(cors({
    origin: config.isProd ? config.appUrl.split(',').map((s) => s.trim()) : true,
    credentials: true,
  }));

  app.use(compression());

  // --- request id -----------------------------------------------------------
  // Sets a traceable id per request (echoed as x-request-id, reused by pino).
  app.use((req, res, next) => {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID().slice(0, 8);
    res.setHeader('x-request-id', requestId);
    (req as Request & { id?: string }).id = requestId;
    next();
  });

  // Meta signs the raw body, so capture it before JSON parsing consumes it.
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // Request logging in every environment; production still gets error-level
  // requests via customLogLevel, so normal traffic stays quiet.
  app.use(pinoHttp({
    logger,
    genReqId: (req) => (req as Request & { id?: string }).id ?? randomUUID().slice(0, 8),
    autoLogging: {
      ignore: (req) => req.url?.startsWith('/api/health') === true,
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'debug';
    },
    customProps: (req) => ({ userId: (req as Request & { user?: { id?: string } }).user?.id }),
  }));

  /**
   * The general API budget is per *signed-in user*, falling back to IP for
   * anonymous traffic.
   *
   * Keying on IP alone is wrong for how this product is used: a sales team
   * works from one office behind one NAT, so thirty people would share a
   * single 600/min bucket — about 20 requests each per minute, which an
   * ordinary session blows through. One busy user would throttle their
   * colleagues.
   *
   * The token is verified rather than merely decoded, so a forged or expired
   * one falls back to the IP bucket instead of minting an unlimited number of
   * fresh per-"user" budgets.
   */
  const apiRateLimitKey = (req: Request): string => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        return `u:${verifyAccessToken(header.slice(7)).sub}`;
      } catch {
        // Invalid or expired — treat as anonymous.
      }
    }
    // Connected apps get a bucket each, keyed by the key's public prefix — the
    // prefix, never the key, because this string ends up in an in-memory store
    // and in nothing that should ever hold a secret. Without this every API
    // key on the deployment shares one `ip:` bucket, so one busy assistant
    // throttles the whole team, and the MCP endpoint's own loopback calls
    // (all from 127.0.0.1) would exhaust it fastest of all.
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey) return `k:${apiKey.slice(0, 8)}`;
    // `ipKeyGenerator`, not the raw `req.ip`. A single IPv6 customer is handed
    // a whole /64, so keying on the exact address gives them a fresh bucket per
    // request simply by picking another address out of their own prefix — the
    // limit stops limiting for precisely the clients most able to rotate.
    // The helper collapses IPv6 to its /64 and leaves IPv4 alone. This is what
    // express-rate-limit 8 flags a custom keyGenerator for, and it was right.
    return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
  };

  // Webhooks are hit by providers, not browsers — they get their own budget.
  app.use('/api/webhooks', rateLimit({
    windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false,
  }));

  // The public property-website API — read-only, unauthenticated, fetched
  // server-to-server by the website's own Next.js server (see
  // api/routes/public.ts), so its traffic is a handful of origins, not
  // end-user browsers directly. Own budget, separate from the general /api one.
  app.use('/api/public', rateLimit({
    windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false,
  }));

  app.use('/api', rateLimit({
    windowMs: 60_000,
    limit: config.security.apiRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/webhooks') || req.path.startsWith('/health'),
    keyGenerator: apiRateLimitKey,
    message: { error: 'rate_limited', message: 'Too many requests. Slow down a moment.' },
  }));

  // --- health ---------------------------------------------------------------
  app.get('/api/health', async (_req, res) => {
    const dbOk = await checkConnection();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'connected' : 'unreachable',
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * A paused account answers nothing but its health check.
   *
   * Mounted above every route on purpose, including the webhooks and the public
   * API: "we have stopped serving you" has to mean all of it, or a suspended
   * customer keeps taking leads through their website and wonders why nobody
   * follows them up. 402 rather than 403 — this is about payment, and the web
   * app shows the message as-is.
   */
  app.use('/api', (req, res, next) => {
    void getServiceStatus()
      .then((status) => {
        if (!status.suspended) {
          next();
          return;
        }
        res.status(402).json({ error: 'service_paused', message: status.message });
      })
      .catch(next);
  });

  // --- routes ---------------------------------------------------------------
  // Webhooks and the public API first: neither goes through requireAuth —
  // webhooks authenticate themselves, the public API is intentionally open.
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/public', publicRouter);
  // The phone companion app authenticates with its own long-lived device token,
  // not a user session, so it sits alongside webhooks rather than behind requireAuth.
  app.use('/api/device', deviceRouter);

  app.use('/api/auth', authRouter);
  // Mounted separately from authRouter: its sign-in half is public, and
  // authRouter's requireAuth is applied per-route rather than at the top.
  app.use('/api/auth/passkeys', passkeyRouter);
  app.use('/api/auth/pin', pinAuthRouter);
  app.use('/api/meta', metadataRouter);
  app.use('/api/views', viewsRouter);
  app.use('/api/dashboards', dashboardsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/comms', commsRouter);
  app.use('/api/outreach', outreachRouter);
  app.use('/api/telephony', telephonyRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/capture', captureRouter);
  // Connected assistants. Mounted before miscRouter's catch-all /api paths.
  app.use('/api/mcp', mcpRouter);
  app.use('/api', miscRouter);
  // Records last: its /:module route would otherwise swallow the paths above.
  app.use('/api/records', recordsRouter);

  // Serve the built web app from the same process when SERVE_WEB=true
  // (containerised single-image deployments). API/Socket paths are left to
  // notFound so a bad /api route never returns index.html.
  if (config.serveWeb) {
    const webDist = resolve(process.cwd(), 'packages/web/dist');
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      res.sendFile(resolve(webDist, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
