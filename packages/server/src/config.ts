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
    jwtExpiresIn: str('JWT_EXPIRES_IN', '12h'),
    refreshExpiresIn: str('REFRESH_TOKEN_EXPIRES_IN', '30d'),
    bcryptRounds: num('BCRYPT_ROUNDS', 10),
  },

  seed: {
    adminEmail: str('SEED_ADMIN_EMAIL', 'admin@ipropy.com'),
    adminPassword: str('SEED_ADMIN_PASSWORD', 'Admin@123'),
    demoData: bool('SEED_DEMO_DATA', true),
  },

  ai: {
    enabled: bool('AI_ENABLED', true),
    apiKey: str('ANTHROPIC_API_KEY'),
    model: str('AI_MODEL', 'claude-sonnet-5'),
    fastModel: str('AI_MODEL_FAST', 'claude-haiku-4-5-20251001'),
    maxTokens: num('AI_MAX_TOKENS', 4096),
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
    },
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
    driver: str('STORAGE_DRIVER', 'local') as 'local' | 's3',
    localPath: str('STORAGE_LOCAL_PATH', './storage'),
    s3: {
      bucket: str('S3_BUCKET'),
      region: str('S3_REGION', 'ap-south-1'),
      accessKeyId: str('S3_ACCESS_KEY_ID'),
      secretAccessKey: str('S3_SECRET_ACCESS_KEY'),
      endpoint: str('S3_ENDPOINT'),
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
