import express, { type Express, type Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { verifyAccessToken } from './middleware/auth.js';
import { checkConnection } from './db/pool.js';

import { authRouter } from './api/routes/auth.js';
import { metadataRouter } from './api/routes/metadata.js';
import { recordsRouter } from './api/routes/records.js';
import { viewsRouter } from './api/routes/views.js';
import { dashboardsRouter, reportsRouter } from './api/routes/dashboards.js';
import { adminRouter } from './api/routes/admin.js';
import { commsRouter } from './api/routes/comms.js';
import { telephonyRouter } from './api/routes/telephony.js';
import { aiRouter } from './api/routes/ai.js';
import { webhooksRouter } from './api/routes/webhooks.js';
import { portalRouter } from './api/routes/portal.js';
import { miscRouter } from './api/routes/misc.js';
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
    // Mirrors express-rate-limit's own default, which this replaces.
    return `ip:${req.ip ?? 'unknown'}`;
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

  // --- routes ---------------------------------------------------------------
  // Webhooks and the public API first: neither goes through requireAuth —
  // webhooks authenticate themselves, the public API is intentionally open.
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/public', publicRouter);

  app.use('/api/auth', authRouter);
  app.use('/api/meta', metadataRouter);
  app.use('/api/views', viewsRouter);
  app.use('/api/dashboards', dashboardsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/comms', commsRouter);
  app.use('/api/telephony', telephonyRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/portal', portalRouter);
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
