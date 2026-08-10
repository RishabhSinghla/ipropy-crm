/**
 * The control plane's public face — two endpoints, and no more than two.
 *
 * A separate process from the CRM on purpose. The CRM serves one customer and
 * holds one customer's connection string; this holds all of them, and the two
 * should not be one blast radius. It listens on CONTROL_PORT and is the only
 * thing that ever needs a route to the customer list.
 *
 * Run it with `npm run control` (or `node dist/control/server.js`).
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { operatorRouter } from './api.js';
import { CONSOLE_HTML } from './console.js';
import { handleRazorpayEvent, startLapseSweep } from './billing.js';
import { verifyWebhookSignature, type WebhookEvent } from './razorpay.js';
import { submitSignup } from './signups.js';
import { closeControlPool, openControlPool } from './store.js';

export function createControlApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'control-plane' });
  });

  // The console is one static page; helmet's default CSP would block its inline
  // script, and splitting a single-file page into two files to satisfy a policy
  // that protects against injected third-party script is the wrong trade here —
  // nothing on this page is user-authored.
  app.get('/', (_req, res) => {
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
    res.type('html').send(CONSOLE_HTML);
  });

  app.use('/api', operatorRouter());

  /**
   * Razorpay deliveries.
   *
   * `express.raw` rather than `express.json`: the signature is an HMAC of the
   * exact bytes sent, and re-serialising parsed JSON changes them. Parsing
   * happens after the signature is checked, which is also the right order for
   * not handing untrusted JSON to anything.
   */
  app.post(
    '/webhooks/razorpay',
    express.raw({ type: '*/*', limit: '1mb' }),
    (req, res) => {
      const raw = req.body as Buffer;
      const signature = req.get('x-razorpay-signature');

      if (!verifyWebhookSignature(raw, signature)) {
        logger.warn({ ip: req.ip }, 'rejected a Razorpay webhook with a bad signature');
        res.status(401).json({ error: 'bad signature' });
        return;
      }

      let body: WebhookEvent;
      try {
        body = JSON.parse(raw.toString('utf8')) as WebhookEvent;
      } catch {
        res.status(400).json({ error: 'not json' });
        return;
      }

      // Razorpay's own id when it sends one, so its retries deduplicate against
      // the same key rather than being processed twice under different ids.
      const eventId = req.get('x-razorpay-event-id')
        ?? `${body.event}:${body.payload?.subscription?.entity?.id ?? 'none'}`;

      // Answer immediately and do the work after. Razorpay retries on anything
      // that is not a prompt 2xx, and a slow database would turn one event into
      // a queue of duplicates — which claimEvent would absorb, but there is no
      // reason to invite it.
      res.json({ ok: true });

      void handleRazorpayEvent(body, eventId)
        .then((result) => logger.info({ event: body.event, ...result }, 'razorpay webhook'))
        .catch((err: unknown) => logger.error({ err, event: body.event }, 'failed to handle a razorpay webhook'));
    },
  );

  /**
   * Public sign-up — queues a request, provisions nothing.
   *
   * Rate-limited hard and off by default. Every approval creates a database
   * that costs money, so the form is a lead, not a purchase.
   */
  app.post(
    '/signup',
    rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false }),
    express.json({ limit: '16kb' }),
    (req, res) => {
      if (!config.control.signupsOpen) {
        res.status(404).json({ error: 'sign-up is not open yet' });
        return;
      }

      const body = req.body as Record<string, string>;
      void submitSignup({
        slug: String(body.slug ?? ''),
        name: String(body.name ?? ''),
        adminEmail: String(body.email ?? ''),
        templateKey: body.template,
        planKey: body.plan,
        phone: body.phone,
        sourceIp: req.ip,
      })
        .then(() => {
          // Deliberately says nothing about what happens next beyond the truth:
          // a human looks at it.
          res.status(202).json({ status: 'queued', message: 'Thanks — we will be in touch shortly.' });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Could not accept that.';
          res.status(400).json({ error: message });
        });
    },
  );

  return app;
}

/* c8 ignore start — process wiring, exercised by running it */
const isEntrypoint = process.argv[1]?.includes('control/server');
if (isEntrypoint) {
  const app = createControlApp();
  openControlPool()
    .then(() => {
      app.listen(config.control.port, () => {
        logger.info({ port: config.control.port }, 'control plane listening');
        logger.info(`   webhooks: http://localhost:${config.control.port}/webhooks/razorpay`);
        logger.info(`   console:  http://localhost:${config.control.port}/`);
        logger.info(`   sign-up:  ${config.control.signupsOpen ? 'open' : 'closed (CONTROL_SIGNUPS_OPEN)'}`);
        // The gateway never tells us a *trial* ended, so somebody has to watch
        // the clock. Started here rather than in createControlApp so the tests
        // that build the app do not leave timers running.
        startLapseSweep();
        logger.info('   billing:  watching for customers whose paid time runs out');
      });
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'control plane failed to start');
      void closeControlPool();
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
