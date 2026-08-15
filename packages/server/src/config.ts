import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load the repo-root .env so one file configures the whole monorepo.
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(process.cwd(), '../../.env') });

function str(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}
function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export const config = {
  env: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: num('PORT', 4000),
  appUrl: str('APP_URL', 'http://localhost:5173'),
  apiUrl: str('API_URL', 'http://localhost:4000'),
  logLevel: str('LOG_LEVEL', 'info'),
  serveWeb: bool('SERVE_WEB', false),

  sentry: {
    dsn: str('SENTRY_DSN'),
  },

  db: {
    url: str('DATABASE_URL', 'postgres://ipropy:ipropy@localhost:5432/ipropy'),
    poolMax: num('DATABASE_POOL_MAX', 20),
  },

  auth: {
    jwtSecret: str('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
    // A database dump alone must not make a four-digit device PIN brute-forceable.
    // Defaults to the already-required JWT secret; deployments may separate it.
    pinPepper: str('PIN_PEPPER') || str('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
    jwtExpiresIn: str('JWT_EXPIRES_IN', '12h'),
    refreshExpiresIn: str('REFRESH_TOKEN_EXPIRES_IN', '30d'),
    bcryptRounds: num('BCRYPT_ROUNDS', 10),
  },

  security: {
    /**
     * Requests per minute on /api, counted per signed-in user (see
     * apiRateLimitKey in app.ts) rather than per IP. Configurable because the
     * right ceiling depends on the deployment — and because the e2e suite
     * drives a whole app's worth of traffic from one session in under a
     * minute, which is not a shape any real user produces.
     */
    apiRateLimit: num('API_RATE_LIMIT', 600),

    /**
     * Sign-in attempts per 15 minutes, per IP. The brute-force guard.
     *
     * Configurable for the same reason as above, and one that bit: the limiter
     * is created once at module scope in api/routes/auth.ts, so every
     * `createApp()` in a process shares one budget. The integration suite makes
     * about seventeen logins across its files from a single IP, which left
     * three of headroom — the next test file to sign in would have broken the
     * run with a 401 that looks nothing like a rate limit. Raised in
     * tests/integration/setup.ts; the default is what production uses.
     */
    loginRateLimit: num('LOGIN_RATE_LIMIT', 20),
  },

  /**
   * The SaaS control plane — the list of paying customers and their databases.
   *
   * Empty in every normal deployment: a server serving one customer has no
   * business holding the others' connection strings. Only the operator's
   * machine and the provisioning job set these. See SAAS.md.
   */
  control: {
    /**
     * Defaults to a local database next to the dev one, so `npm run control`
     * runs with no setup — the same bargain `DATABASE_URL` already makes. There
     * is no default in production: a control plane that silently pointed at
     * localhost would come up empty and look like every customer had vanished.
     */
    databaseUrl: str(
      'CONTROL_DATABASE_URL',
      str('NODE_ENV', 'development') === 'production'
        ? ''
        : 'postgres://ipropy:ipropy@localhost:5432/ipropy_control',
    ),
    neonApiKey: str('NEON_API_KEY'),
    neonRegion: str('NEON_REGION', 'aws-ap-southeast-1'),
    /** The webhook + sign-up listener. Its own process, not the CRM's. */
    port: num('CONTROL_PORT', 4100),
    /** Public sign-up only queues a request; nothing is provisioned without approval. */
    signupsOpen: bool('CONTROL_SIGNUPS_OPEN', false),
    /**
     * One shared secret for the operator console. Unset means the console is
     * open — allowed outside production only, so a developer can see their own
     * local console without a hardcoded default token existing anywhere.
     */
    operatorToken: str('CONTROL_OPERATOR_TOKEN'),
  },

  /**
   * Razorpay. Absent in dev and in every customer's deployment — only the
   * control plane ever charges anybody. Everything degrades the way the AI
   * providers do: unconfigured means "cannot charge", not "crash".
   */
  billing: {
    keyId: str('RAZORPAY_KEY_ID'),
    keySecret: str('RAZORPAY_KEY_SECRET'),
    webhookSecret: str('RAZORPAY_WEBHOOK_SECRET'),
    /** `starter=plan_abc,growth=plan_def` — created once with `tenant -- billing-setup`. */
    planIds: str('RAZORPAY_PLAN_IDS'),
  },

  seed: {
    adminEmail: str('SEED_ADMIN_EMAIL', 'admin@ipropy.com'),
    adminPassword: str('SEED_ADMIN_PASSWORD', 'Admin@123'),
    demoData: bool('SEED_DEMO_DATA', true),
    // Which starting data model a *fresh* database gets. Changing this against
    // a database that has already been seeded does not switch trades — see
    // db/seed/templates/index.ts.
    template: str('SEED_TEMPLATE', 'real-estate'),
  },

  ai: {
    enabled: bool('AI_ENABLED', true),
    /**
     * Blank means "auto": pick whichever provider actually has a key, in the
     * priority order in core/settings/integrations.ts. Set explicitly to pin
     * one. Anything other than `anthropic` is spoken to over the OpenAI
     * chat-completions shape. OpenCode's model picker filters out models that
     * use its other transports, so every model shown by the CRM is callable.
     */
    provider: str('AI_PROVIDER') as '' | 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'opencode' | 'openai' | 'ollama',
    apiKey: str('ANTHROPIC_API_KEY'),
    model: str('AI_MODEL', 'claude-sonnet-5'),
    fastModel: str('AI_MODEL_FAST', 'claude-haiku-4-5-20251001'),
    maxTokens: num('AI_MAX_TOKENS', 4096),

    // Free / low-cost alternatives. Only one needs to be filled in.
    gemini: {
      apiKey: str('GEMINI_API_KEY'),
      // Aliases, not pinned versions. `gemini-2.5-flash` was the default here
      // and Google retired it for new keys, which returned a 404 that looked
      // exactly like a bad key. `-latest` follows whatever the current flash is.
      model: str('GEMINI_MODEL', 'gemini-flash-latest'),
      fastModel: str('GEMINI_MODEL_FAST', 'gemini-flash-lite-latest'),
    },
    groq: {
      apiKey: str('GROQ_API_KEY'),
      model: str('GROQ_MODEL', 'llama-3.3-70b-versatile'),
      fastModel: str('GROQ_MODEL_FAST', 'llama-3.1-8b-instant'),
    },
    openrouter: {
      apiKey: str('OPENROUTER_API_KEY'),
      // OpenRouter's auto-router: individual `:free` model ids rotate out
      // without notice, this one keeps working.
      model: str('OPENROUTER_MODEL', 'openrouter/free'),
      fastModel: str('OPENROUTER_MODEL_FAST', 'openrouter/free'),
    },
    /** OpenCode Zen — free models plus one API key across several providers. */
    opencode: {
      apiKey: str('OPENCODE_API_KEY'),
      model: str('OPENCODE_MODEL', 'nemotron-3-ultra-free'),
      fastModel: str('OPENCODE_MODEL_FAST', 'deepseek-v4-flash-free'),
    },
    /** Any other OpenAI-compatible endpoint, incl. a local Ollama or vLLM. */
    openaiCompatible: {
      apiKey: str('OPENAI_API_KEY'),
      baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      model: str('OPENAI_MODEL', 'gpt-4o-mini'),
      fastModel: str('OPENAI_MODEL_FAST', 'gpt-4o-mini'),
    },
    ollama: {
      baseUrl: str('OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
      model: str('OLLAMA_MODEL', 'llama3.1'),
      fastModel: str('OLLAMA_MODEL_FAST', 'llama3.1'),
    },
  },

  push: {
    /**
     * VAPID keypair. Left blank the server generates one on first use and
     * stores it — rotating it invalidates every subscription already issued,
     * so it must be stable, not per-process.
     */
    publicKey: str('VAPID_PUBLIC_KEY'),
    privateKey: str('VAPID_PRIVATE_KEY'),
    /** Contact the push service can reach you on if a subscription misbehaves. */
    subject: str('VAPID_SUBJECT', 'mailto:admin@ipropy.com'),
  },

  stt: {
    provider: str('STT_PROVIDER', 'openai') as 'none' | 'openai',
    apiKey: str('STT_API_KEY'),
    baseUrl: str('STT_BASE_URL', 'https://api.openai.com/v1'),
    model: str('STT_MODEL', 'whisper-1'),
  },

  whatsapp: {
    provider: str('WHATSAPP_PROVIDER', 'meta'),
    phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
    businessAccountId: str('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    accessToken: str('WHATSAPP_ACCESS_TOKEN'),
    verifyToken: str('WHATSAPP_VERIFY_TOKEN', 'ipropy-verify-token'),
    appSecret: str('WHATSAPP_APP_SECRET'),
    apiVersion: str('WHATSAPP_API_VERSION', 'v21.0'),
  },

  telephony: {
    provider: str('TELEPHONY_PROVIDER', 'none'),
    twilio: {
      accountSid: str('TWILIO_ACCOUNT_SID'),
      authToken: str('TWILIO_AUTH_TOKEN'),
      callerId: str('TWILIO_CALLER_ID'),
      appSid: str('TWILIO_APP_SID'),
    },
    exotel: {
      sid: str('EXOTEL_SID'),
      apiKey: str('EXOTEL_API_KEY'),
      apiToken: str('EXOTEL_API_TOKEN'),
      subdomain: str('EXOTEL_SUBDOMAIN', 'api.exotel.com'),
      callerId: str('EXOTEL_CALLER_ID'),
    },
  },

  email: {
    host: str('SMTP_HOST'),
    port: num('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: str('SMTP_USER'),
    password: str('SMTP_PASSWORD'),
    from: str('SMTP_FROM', 'iPropy CRM <no-reply@ipropy.com>'),
    imap: {
      host: str('IMAP_HOST'),
      port: num('IMAP_PORT', 993),
      user: str('IMAP_USER'),
      password: str('IMAP_PASSWORD'),
      pollMinutes: num('EMAIL_IMAP_POLL_MINUTES', 5),
    },
  },

  // Where the slow work happens. The CRM posts to n8n when a shoot is finished
  // and n8n posts back when it is done; neither call is required for the CRM to
  // function, which is the whole point of keeping them apart.
  automation: {
    n8nWebhookUrl: str('N8N_WEBHOOK_URL'),
    n8nCallbackSecret: str('N8N_CALLBACK_SECRET'),
  },

  leadSources: {
    facebook: {
      appId: str('FACEBOOK_APP_ID'),
      appSecret: str('FACEBOOK_APP_SECRET'),
      pageAccessToken: str('FACEBOOK_PAGE_ACCESS_TOKEN'),
      verifyToken: str('FACEBOOK_VERIFY_TOKEN', 'ipropy-fb-verify'),
    },
    googleAdsWebhookKey: str('GOOGLE_ADS_WEBHOOK_KEY'),
    webformPublicKey: str('WEBFORM_PUBLIC_KEY', 'ipropy-public-webform'),
  },

  storage: {
    driver: str('STORAGE_DRIVER', 'local') as 'local' | 's3' | 'onedrive',
    localPath: str('STORAGE_LOCAL_PATH', './storage'),
    s3: {
      bucket: str('S3_BUCKET'),
      region: str('S3_REGION', 'ap-south-1'),
      accessKeyId: str('S3_ACCESS_KEY_ID'),
      secretAccessKey: str('S3_SECRET_ACCESS_KEY'),
      endpoint: str('S3_ENDPOINT'),
    },
    onedrive: {
      tenantId: str('ONEDRIVE_TENANT_ID'),
      clientId: str('ONEDRIVE_CLIENT_ID'),
      clientSecret: str('ONEDRIVE_CLIENT_SECRET'),
      driveId: str('ONEDRIVE_DRIVE_ID'),
      driveUser: str('ONEDRIVE_DRIVE_USER'),
      rootFolder: str('ONEDRIVE_ROOT_FOLDER', 'iPropy Properties'),
    },
  },

  scheduler: {
    enabled: bool('ENABLE_SCHEDULER', true),
    tickSeconds: num('SCHEDULER_TICK_SECONDS', 60),
  },

  defaults: {
    timezone: str('DEFAULT_TIMEZONE', 'Asia/Kolkata'),
    currency: str('DEFAULT_CURRENCY', 'INR'),
    locale: str('DEFAULT_LOCALE', 'en-IN'),
  },
};

const INSECURE_JWT_SECRETS = new Set([
  'dev-only-insecure-secret-change-me',
  'change-me-to-a-long-random-string',
]);

/**
 * Fail-fast checks for production boot. Kept separate so both the API server
 * and the scheduler worker refuse to start with a risky configuration.
 */
export function validateProductionConfig(): string[] {
  const problems: string[] = [];
  if (INSECURE_JWT_SECRETS.has(config.auth.jwtSecret)) {
    problems.push('JWT_SECRET is still a known development default — generate a strong secret with `npm run secrets:generate`');
  }
  if (config.seed.demoData) {
    problems.push('SEED_DEMO_DATA must be false in production (it would create demo users)');
  }
  if (config.whatsapp.provider === 'meta' && config.whatsapp.accessToken && !config.whatsapp.appSecret) {
    problems.push('WHATSAPP_APP_SECRET is required in production to verify Meta webhook signatures');
  }
  return problems;
}

export type Config = typeof config;
