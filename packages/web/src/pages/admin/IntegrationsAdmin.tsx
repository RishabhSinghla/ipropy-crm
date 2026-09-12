import { type JSX, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  ArrowRight, Bell, Check, CheckCircle2, ChevronDown, Copy, Download, ExternalLink, Globe, HardDrive, Loader2, Mail, MessageCircle, Mic, Plug, Settings2, Sparkles, Webhook, Wand2, XCircle,
} from 'lucide-react';
import { api, type IntegrationSummary } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, EmptyState, Modal, Skeleton, Spinner, Tabs, Toggle } from '../../components/ui';
import { copyText } from '../../lib/nativeActions';

const API_BASE = window.location.origin;

const WEBHOOK_ENDPOINTS = [
  { label: 'WhatsApp (Meta Cloud API)', path: '/api/webhooks/whatsapp', icon: MessageCircle, note: 'Set as the callback URL in your Meta app. The verify token is set below, under WhatsApp.' },
  { label: 'Facebook Lead Ads', path: '/api/webhooks/leads/facebook', icon: Globe, note: 'Subscribe your page to the leadgen field.' },
  { label: 'Google Ads lead form', path: '/api/webhooks/leads/google', icon: Globe, note: 'Paste as the webhook URL; the key must match what you set below, under Google Ads.' },
  { label: '99acres', path: '/api/webhooks/leads/portal/99acres', icon: Globe, note: 'Give this URL to your portal account manager.' },
  { label: 'MagicBricks', path: '/api/webhooks/leads/portal/magicbricks', icon: Globe },
  { label: 'Housing.com', path: '/api/webhooks/leads/portal/housing', icon: Globe },
  { label: 'NoBroker', path: '/api/webhooks/leads/portal/nobroker', icon: Globe },
  { label: 'Generic lead capture', path: '/api/webhooks/leads/generic', icon: Webhook, note: 'POST JSON with an X-Webform-Key header matching the webhook key set below, under Generic Web Form Capture.' },
];

interface FieldDef {
  key: string;
  label: string;
  source: 'config' | 'credentials';
  secret?: boolean;
  placeholder?: string;
  /** Load real choices from the provider, while still allowing a custom id. */
  model?: boolean;
}

const PROVIDER_FIELDS: Record<string, FieldDef[]> = {
  /*
    Firebase, which is only ever used to reach a phone that has the app closed.

    One field, because Google hands you one file. Project Settings → Service
    accounts → Generate new private key downloads a JSON file; its whole
    contents go in here. Nothing else about Firebase is used — no analytics, no
    database, no hosting — and the key never leaves this server.

    Without it the bell inside the CRM and browser push both still work. What
    is missing is the notification that arrives while the app is shut, which is
    the one that actually matters to somebody driving between site visits.
  */
  fcm: [
    {
      key: 'serviceAccount',
      label: 'Service account JSON',
      source: 'credentials',
      secret: true,
      placeholder: '{ "type": "service_account", "project_id": … }',
    },
  ],
  meta_whatsapp: [
    { key: 'phoneNumberId', label: 'Phone Number ID', source: 'credentials' },
    { key: 'businessAccountId', label: 'Business Account ID', source: 'credentials' },
    { key: 'accessToken', label: 'Access Token', source: 'credentials', secret: true },
    { key: 'appSecret', label: 'App Secret', source: 'credentials', secret: true },
    { key: 'verifyToken', label: 'Webhook Verify Token', source: 'config', placeholder: 'ipropy-verify-token' },
    { key: 'apiVersion', label: 'API Version', source: 'config', placeholder: 'v21.0' },
  ],
  smtp: [
    { key: 'host', label: 'SMTP Host', source: 'config', placeholder: 'smtp.yourdomain.com' },
    { key: 'port', label: 'Port', source: 'config', placeholder: '587' },
    { key: 'secure', label: 'Use TLS — "true" or "false"', source: 'config', placeholder: 'false' },
    { key: 'user', label: 'Username', source: 'credentials' },
    { key: 'password', label: 'Password', source: 'credentials', secret: true },
    { key: 'from', label: 'From address', source: 'config', placeholder: 'iPropy CRM <no-reply@yourdomain.com>' },
  ],
  imap: [
    { key: 'host', label: 'IMAP Host', source: 'config' },
    { key: 'port', label: 'Port', source: 'config', placeholder: '993' },
    { key: 'user', label: 'Username', source: 'credentials' },
    { key: 'password', label: 'Password', source: 'credentials', secret: true },
  ],
  anthropic: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'claude-sonnet-5', model: true },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'claude-haiku-4-5-20251001', model: true },
    { key: 'maxTokens', label: 'Max tokens', source: 'config', placeholder: '4096' },
  ],
  ai_gemini: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'gemini-flash-latest', model: true },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'gemini-flash-lite-latest', model: true },
  ],
  ai_groq: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'openai/gpt-oss-120b', model: true },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'llama-3.1-8b-instant', model: true },
  ],
  ai_openrouter: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'openrouter/free', model: true },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'openrouter/free', model: true },
  ],
  ai_openai: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'baseUrl', label: 'Base URL', source: 'config', placeholder: 'https://api.openai.com/v1' },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'gpt-4o-mini', model: true },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'gpt-4o-mini', model: true },
  ],
  /*
    The Model field is back, and the comment that removed it was wrong.

    It said every AI job names its model in Admin → Settings → AI models and
    that this was a second copy nothing read. The opposite is true for
    transcription: when this card holds a key, `resolveStt` sends **this row's**
    model and the box in AI models is never consulted. So the visible setting
    did nothing and the one in use could not be seen, let alone changed.

    That is how production ended up transcribing on `whisper-large-v3-turbo` —
    three times faster and measurably worse on exactly this desk's audio, Hindi
    and English in one sentence — with no way to say otherwise from the UI. The
    field carries `model: true`, so it offers whatever the provider actually
    serves: the same list the Test button counts.
  */
  stt: [
    { key: 'apiKey', label: 'API Key (OpenAI-compatible Whisper)', source: 'credentials', secret: true },
    { key: 'baseUrl', label: 'Base URL', source: 'config', placeholder: 'https://api.groq.com/openai/v1' },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'whisper-large-v3', model: true },
  ],
  // Not marked secret, and that is correct rather than an oversight: a DSN sits
  // in the JavaScript of every site that uses one and can only write events.
  // Hiding it behind a password field would imply a risk that is not there.
  sentry: [
    { key: 'dsn', label: 'DSN', source: 'config', placeholder: 'https://…@o0.ingest.sentry.io/0' },
    { key: 'environment', label: 'Environment name', source: 'config', placeholder: 'production' },
  ],
  facebook_leads: [
    { key: 'appId', label: 'App ID', source: 'config' },
    { key: 'appSecret', label: 'App Secret', source: 'credentials', secret: true },
    { key: 'pageAccessToken', label: 'Page Access Token', source: 'credentials', secret: true },
    { key: 'verifyToken', label: 'Webhook Verify Token', source: 'config', placeholder: 'ipropy-fb-verify' },
  ],
  google_ads: [
    { key: 'webhookKey', label: 'Webhook Key', source: 'credentials', secret: true },
  ],
  s3: [
    { key: 'driver', label: 'Where files are saved — type "s3" to use the cloud, "local" for this server', source: 'config', placeholder: 'local' },
    { key: 'bucket', label: 'Bucket name', source: 'config', placeholder: 'ipropy-files' },
    { key: 'region', label: 'Region — "auto" for Cloudflare R2', source: 'config', placeholder: 'auto' },
    { key: 'endpoint', label: 'Endpoint address (required for Cloudflare R2)', source: 'config', placeholder: 'https://<account-id>.r2.cloudflarestorage.com' },
    { key: 'accessKeyId', label: 'Access Key ID', source: 'credentials' },
    { key: 'secretAccessKey', label: 'Secret Access Key', source: 'credentials', secret: true },
  ],
  onedrive: [
    { key: 'tenantId', label: 'Microsoft Entra Tenant ID', source: 'config', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    { key: 'clientId', label: 'Application (Client) ID', source: 'config', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    { key: 'clientSecret', label: 'Client Secret', source: 'credentials', secret: true },
    { key: 'driveUser', label: 'OneDrive owner email', source: 'config', placeholder: 'photos@yourcompany.com' },
    { key: 'driveId', label: 'Drive ID (optional instead of email)', source: 'config' },
    { key: 'rootFolder', label: 'Root folder', source: 'config', placeholder: 'iPropy Properties' },
  ],
  webform: [
    { key: 'key', label: 'Public Webhook Key', source: 'config', placeholder: 'ipropy-public-webform' },
  ],
};

const TESTABLE = new Set([
  'meta_whatsapp', 'smtp', 'imap', 'facebook_leads',
  'anthropic', 'ai_gemini', 'ai_groq', 'ai_openrouter', 'ai_openai',
  'stt', 'onedrive', 'sentry', 'fcm',
]);

/**
 * Where to get a key, shown on the card. Only the AI providers have these
 * because they are the ones an operator is expected to sign up for themselves
 * — the rest are configured by whoever already owns the account.
 */
const PROVIDER_HINTS: Record<string, { text: string; href?: string; linkLabel?: string; free?: boolean }> = {
  anthropic: {
    text: 'Best quality, paid. Billing required.',
    href: 'https://console.anthropic.com/settings/keys',
    linkLabel: 'Get a key',
  },
  ai_gemini: {
    free: true,
    text: 'Free tier, no card needed — the most generous free option (1M-token context). Note Google may train on free-tier prompts.',
    href: 'https://aistudio.google.com/apikey',
    linkLabel: 'Get a free key',
  },
  ai_groq: {
    free: true,
    text: 'Free tier, no card needed. Fastest responses of the free options.',
    href: 'https://console.groq.com/keys',
    linkLabel: 'Get a free key',
  },
  ai_openrouter: {
    free: true,
    text: 'Free tier, no card needed. Keep the model as openrouter/free — individual “:free” model ids get retired without notice.',
    href: 'https://openrouter.ai/keys',
    linkLabel: 'Get a free key',
  },
  ai_openai: {
    text: 'Any OpenAI-compatible endpoint — OpenAI, Together, Fireworks, vLLM.',
    href: 'https://platform.openai.com/api-keys',
    linkLabel: 'Get a key',
  },
};

// ---------------------------------------------------------------------------
// Guided setup
//
// The card view below asks for "Phone Number ID" and "Webhook Verify Token" —
// fine if you already know what those are, useless if you don't, which is most
// people running a property desk. This layer sits on top of exactly the same
// save/test endpoints and turns each provider into a short, ordered set of
// plain-English steps: fetch this one value from that one screen, paste it
// here, copy this URL over there. Nothing is invented that we can generate
// ourselves — verify tokens and webhook keys are produced for the user rather
// than demanded from them.
// ---------------------------------------------------------------------------

interface GuideStep {
  title: string;
  /** Plain-English instruction. No jargon that isn't defined on the step itself. */
  help: string;
  /** A value to collect — must be a key in that provider's PROVIDER_FIELDS. */
  field?: string;
  /** A webhook path to hand over, copy-button included. */
  copyPath?: string;
  /** Where to find the value being asked for. */
  href?: string;
  linkLabel?: string;
  /** Fill this field with a generated secret instead of asking for one. */
  generate?: boolean;
}

interface Guide {
  /** What connecting this actually gets you, in the user's terms. */
  outcome: string;
  minutes: number;
  steps: GuideStep[];
}

const GUIDES: Record<string, Guide> = {
  meta_whatsapp: {
    outcome: 'Send and receive WhatsApp messages from the Inbox, and run broadcasts.',
    minutes: 10,
    steps: [
      {
        title: 'Open your WhatsApp account on Meta',
        help: 'Sign in to Meta for Developers, open your app, and go to WhatsApp → API Setup. Everything below is on that one screen.',
        href: 'https://developers.facebook.com/apps',
        linkLabel: 'Open Meta for Developers',
      },
      { title: 'Copy the Phone Number ID', help: 'On the API Setup screen, under "From", copy the long number labelled Phone number ID.', field: 'phoneNumberId' },
      { title: 'Copy the Business Account ID', help: 'Just below it, labelled WhatsApp Business Account ID.', field: 'businessAccountId' },
      { title: 'Create a permanent access token', help: 'Business Settings → Users → System Users → Add, give it the whatsapp_business_messaging permission, then Generate token. The temporary token on the API Setup screen expires in 24 hours — do not use that one.', field: 'accessToken' },
      { title: 'Copy the App Secret', help: 'App Settings → Basic → App Secret → Show. This lets us verify that messages really came from Meta.', field: 'appSecret' },
      { title: 'We made you a verify token', help: 'Meta asks for a password of your choosing when you set up the webhook. Here is one — you will paste it into Meta in the next step.', field: 'verifyToken', generate: true },
      { title: 'Point Meta at us', help: 'WhatsApp → Configuration → Edit. Paste the URL below as the Callback URL and the verify token above as the Verify Token, then tick the "messages" field.', copyPath: '/api/webhooks/whatsapp' },
    ],
  },
  smtp: {
    outcome: 'Send email from the CRM using your own address, so replies come back to you.',
    minutes: 4,
    steps: [
      { title: 'Find your mail provider\'s SMTP details', help: 'Google Workspace: smtp.gmail.com, port 587. Microsoft 365: smtp.office365.com, port 587. Otherwise ask whoever set up your email.' },
      { title: 'SMTP host', help: 'The server address from the step above.', field: 'host' },
      { title: 'Port', help: '587 for almost everyone. Use 465 only if your provider says so.', field: 'port' },
      { title: 'Username', help: 'Usually the full email address you are sending from.', field: 'user' },
      { title: 'Password', help: 'For Gmail and Microsoft 365 this must be an app password, not your normal one — your account password will be rejected.', field: 'password', href: 'https://myaccount.google.com/apppasswords', linkLabel: 'Create a Gmail app password' },
      { title: 'What should recipients see?', help: 'The name and address your email appears to come from, e.g. iPropy Realty <sales@yourdomain.com>.', field: 'from' },
    ],
  },
  imap: {
    outcome: 'Replies to your emails appear against the right lead automatically.',
    minutes: 3,
    steps: [
      { title: 'Find your provider\'s IMAP details', help: 'Google Workspace: imap.gmail.com, port 993. Microsoft 365: outlook.office365.com, port 993.' },
      { title: 'IMAP host', help: 'The server address from the step above.', field: 'host' },
      { title: 'Port', help: '993 for almost everyone.', field: 'port' },
      { title: 'Username', help: 'The full email address of the inbox to read.', field: 'user' },
      { title: 'Password', help: 'An app password again, not the account password.', field: 'password' },
    ],
  },
  ai_gemini: {
    outcome: 'Lead scoring, reply drafting and the Ask AI assistant start using a real model instead of the built-in rules.',
    minutes: 2,
    steps: [
      { title: 'Get a free key from Google AI Studio', help: 'Sign in with a Google account and press "Create API key". No card is needed. Note that Google may use free-tier prompts to improve their models.', href: 'https://aistudio.google.com/apikey', linkLabel: 'Get a free key' },
      { title: 'Paste the key', help: 'It starts with "AIza". Nothing else is needed — we pick sensible models for you.', field: 'apiKey' },
    ],
  },
  ai_groq: {
    outcome: 'The fastest of the free AI options — good when replies need to feel instant.',
    minutes: 2,
    steps: [
      { title: 'Get a free key from Groq', help: 'Sign in and press "Create API Key". No card is needed.', href: 'https://console.groq.com/keys', linkLabel: 'Get a free key' },
      { title: 'Paste the key', help: 'It starts with "gsk_".', field: 'apiKey' },
    ],
  },
  ai_openrouter: {
    outcome: 'One key, many models. Free tier available.',
    minutes: 2,
    steps: [
      { title: 'Get a key from OpenRouter', help: 'Sign in and create a key.', href: 'https://openrouter.ai/keys', linkLabel: 'Get a key' },
      { title: 'Paste the key', help: 'It starts with "sk-or-".', field: 'apiKey' },
    ],
  },
  anthropic: {
    outcome: 'The highest-quality AI answers. Paid — billing must be set up on the Anthropic console first.',
    minutes: 2,
    steps: [
      { title: 'Create a key', help: 'Sign in to the Anthropic console, add billing, then create an API key.', href: 'https://console.anthropic.com/settings/keys', linkLabel: 'Get a key' },
      { title: 'Paste the key', help: 'It starts with "sk-ant-".', field: 'apiKey' },
    ],
  },
  ai_openai: {
    outcome: 'Use OpenAI, or any service that speaks the same format (Together, Fireworks, a self-hosted model).',
    minutes: 3,
    steps: [
      { title: 'Create a key', help: 'On the OpenAI platform, or on whichever compatible service you use.', href: 'https://platform.openai.com/api-keys', linkLabel: 'Get an OpenAI key' },
      { title: 'Paste the key', help: 'It starts with "sk-".', field: 'apiKey' },
      { title: 'Where does it live?', help: 'Leave blank for OpenAI itself. For another service, paste the base URL they give you.', field: 'baseUrl' },
    ],
  },
  sentry: {
    outcome: 'Hear about a crash the moment it happens, instead of when somebody remembers to mention it.',
    minutes: 3,
    steps: [
      { title: 'Create a Sentry project', help: 'Pick Node.js. The free plan covers far more than a team of five will ever produce.', href: 'https://sentry.io/organizations/new/', linkLabel: 'Open Sentry' },
      { title: 'Copy the DSN it shows you', help: 'It looks like an address with a long code in it. It is not a password — it can only send errors in, never read anything out.', field: 'dsn' },
      { title: 'Name this environment', help: 'Use "production" for the live CRM. It keeps real crashes separate from anything tested locally.', field: 'environment' },
    ],
  },
  stt: {
    outcome: 'Turn property voice notes and call recordings into searchable text automatically.',
    minutes: 2,
    steps: [
      { title: 'Choose a Whisper provider', help: 'Groq is the low-cost, fast recommendation. The same Groq key can be used here and on the Groq AI card.', href: 'https://console.groq.com/keys', linkLabel: 'Open Groq keys' },
      { title: 'Paste the API key', help: 'Use your Groq or OpenAI-compatible speech key.', field: 'apiKey' },
      { title: 'Set the speech API address', help: 'For Groq use https://api.groq.com/openai/v1. For OpenAI use https://api.openai.com/v1.', field: 'baseUrl' },
      // Sent people to the wrong screen: the box under Settings → AI models is
      // the fallback for when this card has no key, and this card's own model
      // is what transcribes whenever it does.
      { title: 'Pick the model', help: 'Both Groq Whisper models are free. whisper-large-v3 is the accurate one and the right choice for Hindi and English mixed together; whisper-large-v3-turbo is faster and noticeably rougher on the same audio.', field: 'model' },
    ],
  },
  facebook_leads: {
    outcome: 'Leads from your Facebook and Instagram lead-ad forms arrive in the CRM the moment someone submits.',
    minutes: 8,
    steps: [
      { title: 'Open your app on Meta', help: 'Meta for Developers → your app → Settings → Basic.', href: 'https://developers.facebook.com/apps', linkLabel: 'Open Meta for Developers' },
      { title: 'Copy the App ID', help: 'At the top of Settings → Basic.', field: 'appId' },
      { title: 'Copy the App Secret', help: 'Just below it — press Show.', field: 'appSecret' },
      { title: 'Create a page access token', help: 'Graph API Explorer → pick your Page → request the leads_retrieval and pages_show_list permissions → Generate. Then extend it to a long-lived token.', field: 'pageAccessToken' },
      { title: 'We made you a verify token', help: 'Meta asks for a password of your choosing. Here is one — paste it into Meta in the next step.', field: 'verifyToken', generate: true },
      { title: 'Point Meta at us', help: 'Webhooks → Page → Subscribe to the "leadgen" field, using this callback URL and the verify token above.', copyPath: '/api/webhooks/leads/facebook' },
    ],
  },
  google_ads: {
    outcome: 'Leads from Google lead-form extensions arrive in the CRM automatically.',
    minutes: 4,
    steps: [
      { title: 'We made you a key', help: 'This is the password Google will send with each lead so we know it is really them.', field: 'webhookKey', generate: true },
      { title: 'Paste both into Google Ads', help: 'Your lead form asset → Lead delivery option → Webhook. Use the URL below and the key above.', copyPath: '/api/webhooks/leads/google' },
    ],
  },
  webform: {
    outcome: 'A form on your own website posts straight into the CRM.',
    minutes: 3,
    steps: [
      { title: 'We made you a key', help: 'Your website sends this with each submission so strangers cannot post fake leads.', field: 'key', generate: true },
      { title: 'Post to this URL', help: 'Send the form as JSON with a header X-Webform-Key set to the key above. Give both to whoever maintains your website.', copyPath: '/api/webhooks/leads/generic' },
    ],
  },
  s3: {
    outcome: 'Photos and videos are kept in your own cloud storage instead of on this server. Without this, every update to the CRM deletes every photo anyone has uploaded.',
    minutes: 6,
    steps: [
      {
        title: 'Open your bucket',
        help: 'Cloudflare dashboard, then R2, then your bucket. If you have not made one, Create bucket and give it any name. R2 is free up to 10GB, which is thousands of property photos.',
      },
      {
        title: 'Copy the bucket name',
        help: 'Exactly as it appears in Cloudflare, lower case.',
        field: 'bucket',
      },
      {
        title: 'Copy the endpoint address',
        help: 'On the bucket page, under Settings, it is the S3 API address and looks like https://<a long id>.r2.cloudflarestorage.com — the part ending in .com, with no bucket name after it. This step is the one people miss, and without it nothing saves.',
        field: 'endpoint',
      },
      {
        title: 'Region',
        help: 'Type auto. Cloudflare ignores this, but the connection refuses to start without something in the box.',
        field: 'region',
      },
      {
        title: 'Create an API token',
        help: 'R2, then Manage API tokens, then Create token. Give it Object Read & Write on this bucket. Cloudflare shows an Access Key ID and a Secret — copy the Access Key ID here.',
        field: 'accessKeyId',
      },
      {
        title: 'And the secret',
        help: 'Shown once, on the same screen. If you have already closed it, make a new token; you cannot get this one back.',
        field: 'secretAccessKey',
      },
      {
        title: 'Turn it on',
        help: 'Type s3 in this box. Until you do, the CRM keeps saving to this server no matter what you filled in above. Leaving it as local is only right if you never update the CRM.',
        field: 'driver',
      },
    ],
  },
  onedrive: {
    outcome: 'Keep every property original and every generated version in your company OneDrive, in a predictable folder tree.',
    minutes: 8,
    steps: [
      { title: 'Register iPropy in Microsoft Entra', help: 'Open App registrations, create an application, then copy the Directory (tenant) ID.', href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', linkLabel: 'Open Microsoft Entra' },
      { title: 'Tenant ID', help: 'The Directory (tenant) ID from the app overview.', field: 'tenantId' },
      { title: 'Application ID', help: 'The Application (client) ID from the same overview.', field: 'clientId' },
      { title: 'Create a client secret', help: 'Certificates & secrets → New client secret. Copy its Value now; Microsoft only shows it once.', field: 'clientSecret' },
      { title: 'Allow file access', help: 'API permissions → Microsoft Graph → Application permissions → Files.ReadWrite.All, then press Grant admin consent. This lets the background worker upload without an employee staying signed in.' },
      { title: 'Choose the company drive', help: 'Enter the Microsoft 365 email address whose OneDrive should hold property media.', field: 'driveUser' },
      { title: 'Name the root folder', help: 'All house folders are created inside this folder.', field: 'rootFolder' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Honest status
//
// "Active" used to be the only word a card had, and an active provider
// failing its test read as healthy. Every card on this page now derives one
// of four states from the same figures, so the attention strip, the job cards
// and the settings cards can never disagree with each other.
// ---------------------------------------------------------------------------

type IntegrationHealth = 'working' | 'attention' | 'off' | 'unconfigured';

/** Config the seed migrations pre-fill so the cards are ready to use. Its presence does not mean a human has set anything up. */
const PRESEEDED_CONFIG: Record<string, string[]> = {
  ai_gemini: ['model', 'fastModel'],
  ai_groq: ['model', 'fastModel'],
  ai_openrouter: ['model', 'fastModel'],
  ai_openai: ['model', 'fastModel'],
  onedrive: ['rootFolder'],
};

/** Failing outright — a test or delivery attempt went wrong — as opposed to merely unfinished. */
function isBroken(summary: IntegrationSummary): boolean {
  return Boolean(summary.lastError) || summary.status === 'error';
}

/** Somebody has actually entered something, ignoring the pre-seeded defaults. */
function hasSavedDetails(summary: IntegrationSummary): boolean {
  const preseeded = PRESEEDED_CONFIG[summary.provider] ?? [];
  const configSaved = Object.entries(summary.config).some(([key, value]) => value.trim() !== '' && !preseeded.includes(key));
  const credentialSaved = Object.values(summary.credentialFields).some((field) => field.set);
  return configSaved || credentialSaved;
}

function healthOf(summary: IntegrationSummary): IntegrationHealth {
  if (isBroken(summary)) return 'attention';
  if (summary.isActive) return hasSavedDetails(summary) ? 'working' : 'attention'; // switched on with nothing saved cannot work
  return hasSavedDetails(summary) ? 'off' : 'unconfigured';
}

/** Card faces speak to the owner, not to the database: plain names, no provider ids. */
const PLAIN_NAMES: Record<string, string> = {
  meta_whatsapp: 'WhatsApp Business',
  smtp: 'your own email address',
  imap: 'reading replies',
  facebook_leads: 'Facebook Lead Ads',
  google_ads: 'Google Ads lead forms',
  webform: 'your website form',
  ai_gemini: 'Google Gemini',
  ai_groq: 'Groq',
  ai_openrouter: 'OpenRouter',
  ai_openai: 'OpenAI',
  anthropic: 'Claude',
  stt: 'speech to text',
  onedrive: 'OneDrive',
  s3: 'S3 storage',
  sentry: 'Sentry',
  web_push: 'browser push',
  fcm: 'alerts to the phone app',
};

/** The coloured badge every connector carries: honest, and three words at most. */
function StatusBadge({ summary }: { summary: IntegrationSummary }): JSX.Element {
  const health = healthOf(summary);
  if (health === 'working') return <Badge color="#22c55e">Working</Badge>;
  if (health === 'attention') return <Badge color={isBroken(summary) ? '#ef4444' : '#f59e0b'}>Needs attention</Badge>;
  if (health === 'off') return <Badge>Switched off</Badge>;
  return <Badge>Not set up</Badge>;
}

/**
 * The connectors, grouped by the job the owner wants done — never by provider
 * id or technology. Jobs with several providers collapse into one card: the
 * face shows the option that matters right now (working first, then the one
 * failing, then the recommended default) and the rest sit behind a "More …
 * options" expander. Nothing is removed; it is only not all visible at once.
 */
interface JobDef {
  id: string;
  title: string;
  /** What this does for you, one sentence. */
  blurb: string;
  icon: typeof MessageCircle;
  providers: string[];
  /** Fronts the card while nothing is set up yet. */
  recommended?: string;
  /** Appears in the attention strip while entirely unconfigured. */
  wanted?: boolean;
  /** The words the action buttons use: "Set up calls", "Fix calls". */
  short: string;
  /** Plain sentence for the strip and the card when set up but failing. */
  trouble: string;
  /** Plain sentence for the strip when nothing is set up at all. */
  missing?: string;
  /** Label of the expander holding the remaining options. */
  moreLabel?: string;
}

const JOBS: JobDef[] = [
  {
    id: 'whatsapp',
    title: 'WhatsApp',
    blurb: 'Two-way chat in the Inbox, plus templates and broadcasts.',
    icon: MessageCircle,
    providers: ['meta_whatsapp'],
    wanted: true,
    short: 'WhatsApp',
    trouble: 'WhatsApp is set up but failing its connection test, so messages will not send or arrive.',
    missing: 'WhatsApp is not set up, so you cannot message customers from the CRM.',
  },
  /*
    "Phone calls" is not a goal this marketplace can set up any more.

    It offered Exotel and Twilio — dialling from the browser with the recording
    saved against the lead. Both are removed (migration 141); a rep rings from
    the handset in their hand and the call comes back through the paired
    Android app, which is set up on the phone rather than here.
  */
  {
    id: 'leads',
    title: 'Lead capture',
    blurb: 'Leads from Facebook, Google and your own website arrive by themselves.',
    icon: Globe,
    providers: ['facebook_leads', 'google_ads', 'webform'],
    recommended: 'webform',
    wanted: true,
    short: 'lead capture',
    trouble: 'Lead capture is set up but failing, so new enquiries are not arriving.',
    missing: 'Lead capture is not set up, so enquiries from ads and your website have to be typed in by hand.',
    moreLabel: 'More lead sources',
  },
  {
    id: 'email',
    title: 'Email',
    blurb: 'Send from your own address, and replies land on the right lead.',
    icon: Mail,
    providers: ['smtp', 'imap'],
    recommended: 'smtp',
    wanted: true,
    short: 'email',
    trouble: 'Email is set up but failing its test, so the CRM cannot send from your own address.',
    missing: 'Email is not set up, so the CRM cannot send from your own address.',
    moreLabel: 'More email options',
  },
  {
    id: 'ai',
    title: 'Turn on AI',
    blurb: 'Lead scoring, reply drafting and the assistant. Free options available.',
    icon: Sparkles,
    providers: ['ai_gemini', 'ai_groq', 'ai_openrouter', 'ai_openai', 'anthropic'],
    recommended: 'ai_gemini',
    wanted: true,
    short: 'AI',
    trouble: 'AI is set up but failing its test, so the CRM is falling back to basic rules.',
    missing: 'AI is not switched on, so lead scoring and reply drafting use the built-in rules.',
    moreLabel: 'More AI options',
  },
  {
    id: 'transcription',
    title: 'Voice transcription',
    blurb: 'Voice notes and call recordings become text the CRM can read.',
    icon: Mic,
    providers: ['stt'],
    short: 'transcription',
    trouble: 'Speech to text is set up but failing, so recordings stay as audio.',
  },
  {
    id: 'storage',
    title: 'File storage',
    blurb: 'Your photos and documents live in your own cloud, safe from server updates.',
    icon: HardDrive,
    providers: ['onedrive', 's3'],
    recommended: 'onedrive',
    wanted: true,
    short: 'file storage',
    trouble: 'File storage is set up but failing its test, so new photos may not be saved.',
    missing: 'Cloud file storage is not set up, so photos live only on this server and are lost when the CRM is updated.',
    moreLabel: 'More storage options',
  },
  {
    /*
      Only ever about reaching a phone whose app is shut.

      The bell inside the CRM and browser push both work without any of this —
      they are the CRM talking to a page that is open. A rep driving between
      site visits has the app closed, and on both platforms the only way to
      reach a closed app is through the operating system's own channel:
      Firebase on Android, and Firebase forwarding to Apple on iPhone.
    */
    id: 'app-alerts',
    title: 'Alerts on the phone app',
    blurb: 'Follow-ups and new leads reach a rep even with the app closed.',
    icon: Bell,
    providers: ['fcm'],
    recommended: 'fcm',
    wanted: true,
    short: 'phone alerts',
    missing: 'The phone app cannot be alerted while it is closed, so a follow-up is only seen next time somebody opens it.',
    trouble: 'Phone alerts are set up but failing, so a rep may not hear about a lead until they open the app.',
  },
  {
    id: 'errors',
    title: 'Error alerts',
    blurb: 'Errors reach your Sentry dashboard with customer details removed.',
    icon: Webhook,
    providers: ['sentry'],
    short: 'error alerts',
    trouble: 'Error reporting is set up but failing, so a crash may go unnoticed.',
  },
];

interface AttentionItem {
  /** Stable key: the job id, or the provider for anything outside a job. */
  key: string;
  sentence: string;
  provider: string;
  action: string;
  mode: 'setup' | 'manage';
}

/**
 * The "Needs your attention" list, judged per job rather than per provider:
 * the owner thinks in jobs, and a job with one working option is not broken
 * no matter what state its other options are in — those surface as badges on
 * their own rows instead. A provider deliberately switched off raises no
 * alarm either: that was a decision, not an accident. Providers outside every
 * job (error reporting, web push) still earn a line when they fail.
 */
function buildAttentionItems(summaries: IntegrationSummary[]): AttentionItem[] {
  const find = (provider: string): IntegrationSummary | undefined => summaries.find((s) => s.provider === provider);
  const inJobs = new Set(JOBS.flatMap((job) => job.providers));
  const trouble: AttentionItem[] = [];
  const missing: AttentionItem[] = [];

  for (const job of JOBS) {
    const rows = job.providers.map(find).filter((s): s is IntegrationSummary => Boolean(s));
    if (!rows.length) continue;
    if (rows.some((s) => healthOf(s) === 'working')) continue;
    const failing = rows.find((s) => healthOf(s) === 'attention');
    if (failing) {
      trouble.push({
        key: job.id,
        sentence: job.trouble,
        provider: failing.provider,
        action: `Fix ${job.short}`,
        mode: GUIDES[failing.provider] ? 'setup' : 'manage',
      });
    } else if (job.wanted && job.missing && !rows.some(hasSavedDetails)) {
      const target = (job.recommended ? find(job.recommended) : undefined) ?? rows[0];
      missing.push({
        key: job.id,
        sentence: job.missing,
        provider: target.provider,
        action: `Set up ${job.short}`,
        mode: GUIDES[target.provider] ? 'setup' : 'manage',
      });
    }
  }

  for (const summary of summaries) {
    if (inJobs.has(summary.provider) || healthOf(summary) !== 'attention') continue;
    const guided = Boolean(GUIDES[summary.provider]);
    trouble.push({
      key: summary.provider,
      sentence: `${summary.label} is set up but failing its test.`,
      provider: summary.provider,
      action: guided ? 'Fix' : 'Manage',
      mode: guided ? 'setup' : 'manage',
    });
  }

  return [...trouble, ...missing];
}

/** A token the user would otherwise have to invent. Long enough to be unguessable. */
function generateSecret(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `ipropy-${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 28)}`;
}

function ConnectWizard({
  summary, onClose,
}: { summary: IntegrationSummary; onClose: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const guide = GUIDES[summary.provider];
  const fields = PROVIDER_FIELDS[summary.provider] ?? [];
  const fieldMap = new Map(fields.map((f) => [f.key, f]));

  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of fields) {
      initial[f.key] = f.source === 'config' ? (summary.config[f.key] ?? '') : '';
    }
    // Anything we can produce ourselves is produced up front, so the step that
    // shows it is a "copy this" rather than a "think of something".
    for (const s of guide?.steps ?? []) {
      if (s.generate && s.field && !initial[s.field]) initial[s.field] = generateSecret();
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (!guide) {
    return (
      <Modal open onClose={onClose} title={`Connect ${summary.label}`} size="md">
        <p className="text-sm text-muted">
          This provider has no guided setup yet — use the detailed settings instead.
        </p>
      </Modal>
    );
  }

  const current = guide.steps[step];
  const isLast = step === guide.steps.length - 1;
  const field = current.field ? fieldMap.get(current.field) : undefined;
  const savedPreview = field?.secret ? summary.credentialFields[field.key] : undefined;

  const copy = (text: string): void => {
    void copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const configPatch: Record<string, string> = {};
      const credentialsPatch: Record<string, string> = {};
      for (const f of fields) {
        const v = values[f.key] ?? '';
        if (f.source === 'config') configPatch[f.key] = v;
        else if (v) credentialsPatch[f.key] = v; // blank = leave what's saved
      }
      await api.saveIntegration(summary.provider, { config: configPatch, credentials: credentialsPatch, isActive: true });

      // Test straight away. "Saved" is not the same as "working", and finding
      // out at the point of setup beats finding out when a lead goes missing.
      if (TESTABLE.has(summary.provider)) {
        const test = await api.testIntegration(summary.provider);
        setResult(test);
        if (test.ok) toast.success(`${summary.label} connected`);
      } else {
        setResult({ ok: true, message: 'Saved and switched on.' });
        toast.success(`${summary.label} connected`);
      }
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Connect ${summary.label}`}
      size="md"
      footer={(
        <>
          <span className="mr-auto text-2xs text-muted">
            Step {step + 1} of {guide.steps.length}
          </span>
          {step > 0 && (
            <button className="btn-secondary" disabled={busy} onClick={() => { setStep(step - 1); setResult(null); }}>
              Back
            </button>
          )}
          {isLast ? (
            <button className="btn-primary" disabled={busy} onClick={() => void finish()}>
              {busy && <Spinner className="h-3.5 w-3.5" />}
              {result?.ok ? 'Done' : 'Connect'}
            </button>
          ) : (
            <button className="btn-primary" onClick={() => setStep(step + 1)}>
              Next <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs dark:border-brand-900 dark:bg-brand-950/40">
          <p className="font-medium text-brand-800 dark:text-brand-200">{guide.outcome}</p>
          <p className="mt-0.5 text-brand-700/80 dark:text-brand-300/80">
            About {guide.minutes} minutes. You can stop and come back — nothing is lost until you press Connect.
          </p>
        </div>

        <div className="flex gap-1">
          {guide.steps.map((s, i) => (
            <span
              key={s.title}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                i <= step ? 'bg-brand-500' : 'bg-slate-200 dark:bg-slate-700',
              )}
            />
          ))}
        </div>

        <div>
          <h3 className="text-sm font-semibold">{current.title}</h3>
          <p className="mt-1 text-sm text-muted">{current.help}</p>

          {current.href && (
            <a
              href={current.href}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              {current.linkLabel ?? 'Open'} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}

          {current.copyPath && (
            <div className="mt-3">
              <label className="label">Copy this URL</label>
              <div className="flex items-stretch gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 font-mono text-2xs dark:border-slate-700 dark:bg-slate-800">
                  {API_BASE}{current.copyPath}
                </code>
                <button className="btn-secondary btn-sm shrink-0" onClick={() => copy(`${API_BASE}${current.copyPath}`)}>
                  {copied ? <Check className="h-3.5 w-3.5 text-positive" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {field && (
            <div className="mt-3">
              <label className="label" htmlFor={`wiz_${field.key}`}>{field.label}</label>
              <div className="flex items-stretch gap-2">
                <input
                  id={`wiz_${field.key}`}
                  type={field.secret && !current.generate ? 'password' : 'text'}
                  className="input min-w-0 flex-1"
                  value={values[field.key] ?? ''}
                  autoFocus
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={savedPreview?.set ? `Saved (${savedPreview.preview}) — leave blank to keep` : field.placeholder}
                />
                {current.generate && (
                  <button
                    className="btn-secondary btn-sm shrink-0"
                    onClick={() => copy(values[field.key] ?? '')}
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-positive" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
              {current.generate && (
                <button
                  className="mt-1.5 text-2xs text-brand-600 hover:underline dark:text-brand-400"
                  onClick={() => setValues((prev) => ({ ...prev, [field.key]: generateSecret() }))}
                >
                  Generate a different one
                </button>
              )}
            </div>
          )}
        </div>

        {result && (
          <div className={cn(
            'flex items-start gap-1.5 rounded-lg border p-2.5 text-xs',
            result.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400',
          )}>
            {result.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>
              {result.message}
              {!result.ok && ' — go back and check the values, or use the detailed settings.'}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** One alternative option under a collapsed job card. */
function ProviderRow({ summary, onSetup, onManage }: {
  summary: IntegrationSummary;
  onSetup: (provider: string) => void;
  onManage: (provider: string) => void;
}): JSX.Element {
  const health = healthOf(summary);
  const hint = PROVIDER_HINTS[summary.provider];
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{summary.label}</span>
        {hint && health !== 'working' && <span className="block text-2xs text-muted">{hint.text}</span>}
      </span>
      <StatusBadge summary={summary} />
      {health === 'working' || health === 'off' ? (
        <button className="btn-secondary btn-sm shrink-0" onClick={() => onManage(summary.provider)}>Manage</button>
      ) : (
        <button className="btn-primary btn-sm shrink-0" onClick={() => onSetup(summary.provider)}>
          {health === 'attention' ? 'Fix' : 'Set up'}
        </button>
      )}
    </div>
  );
}

/** One job card: what the job does for you, an honest status, one action. */
function JobCard({ job, summaries, onSetup, onManage }: {
  job: JobDef;
  summaries: IntegrationSummary[];
  onSetup: (provider: string) => void;
  onManage: (provider: string) => void;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const rows = job.providers
    .map((provider) => summaries.find((s) => s.provider === provider))
    .filter((s): s is IntegrationSummary => Boolean(s));
  if (!rows.length) return null;

  // The face answers the question the owner is actually asking: is this job
  // fine? A working option leads; otherwise the one closest to working does;
  // with nothing set up at all, the recommended option fronts the card.
  const face = rows.find((s) => healthOf(s) === 'working')
    ?? rows.find((s) => healthOf(s) === 'attention')
    ?? rows.find((s) => healthOf(s) === 'off')
    ?? rows.find((s) => s.provider === job.recommended)
    ?? rows[0];
  const health = healthOf(face);
  const others = rows.filter((s) => s.provider !== face.provider);

  return (
    <div className="card flex flex-col p-4">
      <div className="flex items-start gap-2.5">
        <job.icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <p className="min-w-0 flex-1 text-sm font-semibold">{job.title}</p>
        <StatusBadge summary={face} />
      </div>
      <p className="mt-2 text-xs text-muted">{job.blurb}</p>
      {health === 'working' && (
        <p className="mt-1 text-xs text-positive">Running on {PLAIN_NAMES[face.provider] ?? face.label}.</p>
      )}
      {health === 'attention' && <p className="mt-1 text-xs text-negative">{job.trouble}</p>}
      {health === 'off' && <p className="mt-1 text-xs text-muted">Set up, but its switch is off.</p>}

      <div className="mt-3 flex items-center gap-2">
        {health === 'working' || health === 'off' ? (
          <button className="btn-secondary btn-sm" onClick={() => onManage(face.provider)}>Manage</button>
        ) : (
          <button className="btn-primary btn-sm" onClick={() => onSetup(face.provider)}>
            {health === 'attention' ? `Fix ${job.short}` : `Set up ${job.short}`}
          </button>
        )}
        {others.length > 0 && (
          <button className="btn-ghost btn-sm ml-auto shrink-0" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Fewer options' : job.moreLabel}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
          </button>
        )}
      </div>

      {expanded && others.length > 0 && (
        <div className="mt-3 space-y-2.5 border-t border-slate-100 pt-3 dark:border-slate-800">
          {others.map((summary) => (
            <ProviderRow key={summary.provider} summary={summary} onSetup={onSetup} onManage={onManage} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The strip at the top of the page: one plain sentence and one button per line. */
function AttentionStrip({ items, onAction }: {
  items: AttentionItem[];
  onAction: (item: AttentionItem) => void;
}): JSX.Element {
  return (
    <div className="card p-4">
      <Badge color="#f59e0b">Needs your attention</Badge>
      <div className="mt-1">
        {items.map((item, index) => (
          <div
            key={item.key}
            className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5', index > 0 && 'border-t border-slate-100 dark:border-slate-800')}
          >
            <p className="min-w-0 flex-1 text-sm">{item.sentence}</p>
            <button
              className={cn('btn-sm shrink-0', item.mode === 'manage' ? 'btn-secondary' : 'btn-primary')}
              onClick={() => onAction(item)}
            >
              {item.action}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProviderCard({ summary }: { summary: IntegrationSummary }): JSX.Element {
  const queryClient = useQueryClient();
  const fields = PROVIDER_FIELDS[summary.provider] ?? [];
  const hint = PROVIDER_HINTS[summary.provider];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.source === 'config' ? (summary.config[f.key] ?? '') : ''])),
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const hasModelFields = fields.some((field) => field.model);
  const modelCatalogue = useQuery({
    queryKey: ['integration-models', summary.provider],
    queryFn: () => api.integrationModels(summary.provider),
    enabled: hasModelFields,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const setField = (key: string, v: string): void => setValues((prev) => ({ ...prev, [key]: v }));

  const save = async (): Promise<void> => {
    setSaving(true);
    setTestResult(null);
    try {
      const configPatch: Record<string, string> = {};
      const credentialsPatch: Record<string, string> = {};
      for (const f of fields) {
        const v = values[f.key] ?? '';
        if (f.source === 'config') configPatch[f.key] = v;
        else if (v) credentialsPatch[f.key] = v; // blank credential = leave unchanged
      }
      await api.saveIntegration(summary.provider, { config: configPatch, credentials: credentialsPatch });
      // "Saved" means stored — that is all. The Test button is what proves the
      // provider accepts them, and the line below says when the values were
      // written so a save can never be mistaken for a test that passed.
      setSavedAt(new Date());
      toast.success(`${summary.label} saved`);
      // Clear typed secrets from the form — they're persisted now, and we never
      // want a plaintext secret sitting in component state longer than needed.
      setValues((prev) => {
        const next = { ...prev };
        for (const f of fields) if (f.secret) next[f.key] = '';
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      if (hasModelFields) {
        await queryClient.invalidateQueries({ queryKey: ['integration-models', summary.provider] });
      }
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testIntegration(summary.provider);
      setTestResult(result);
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const toggleActive = async (next: boolean): Promise<void> => {
    try {
      await api.saveIntegration(summary.provider, { isActive: next });
      toast.success(next ? `${summary.label} enabled` : `${summary.label} disabled`);
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      toast.error('Could not update', (err as Error).message);
    }
  };

  const syncNow = async (): Promise<void> => {
    setSyncing(true);
    setTestResult(null);
    try {
      const result = await api.syncImapInbound(50);
      setTestResult({
        ok: result.errors.length === 0,
        message: result.errors[0]
          ?? `Imported ${result.imported} of ${result.checked} messages${result.matched ? `, linked to records` : ''}.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', summary.isActive ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700')} />
        <p className="text-sm font-medium">{summary.label}</p>
        <StatusBadge summary={summary} />
        {summary.lastSyncAt && (
          <span className="text-2xs text-muted">verified {relativeTime(summary.lastSyncAt)}</span>
        )}
        <Toggle checked={summary.isActive} onChange={(next) => void toggleActive(next)} className="ml-auto" />
      </div>

      {hint && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs text-muted dark:border-slate-800 dark:bg-slate-800/30">
          {hint.free && <Badge color="#22c55e">Free tier</Badge>}
          <span className="min-w-0 flex-1">{hint.text}</span>
          {hint.href && (
            <a
              href={hint.href}
              target="_blank"
              rel="noreferrer noopener"
              className="shrink-0 font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              {hint.linkLabel ?? 'Open'} →
            </a>
          )}
        </div>
      )}

      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {fields.map((f) => {
          const preview = f.secret ? summary.credentialFields[f.key] : undefined;
          const listId = `models_${summary.provider}_${f.key}`;
          return (
            <div key={f.key} className={fields.length === 1 ? 'sm:col-span-2' : ''}>
              <label className="label">{f.label}</label>
              <input
                type={f.secret ? 'password' : 'text'}
                className="input"
                list={f.model ? listId : undefined}
                value={values[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={preview?.set ? `Saved (${preview.preview}) — leave blank to keep` : f.placeholder}
              />
              {f.model && (
                <>
                  <datalist id={listId}>
                    {(modelCatalogue.data?.models ?? []).map((model) => (
                      <option
                        key={model.id}
                        value={model.id}
                        label={`${model.label}${model.free ? ' · free' : ''}${model.vision ? ' · vision' : ''}`}
                      />
                    ))}
                  </datalist>
                  <p className="mt-1 text-2xs text-muted">
                    {modelCatalogue.isFetching
                      ? 'Loading current models…'
                      : modelCatalogue.data?.live
                        ? `${modelCatalogue.data.models.length} live models loaded — choose one or type a custom model ID.`
                        : modelCatalogue.data?.warning ?? 'Choose a suggested model or type a custom model ID.'}
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>

      {summary.lastError && !testResult && (
        <div className="mx-4 mb-3 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {summary.lastError}
        </div>
      )}
      {testResult && (
        <div className={cn(
          'mx-4 mb-3 flex items-start gap-1.5 rounded-lg border p-2.5 text-xs',
          testResult.ok
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
            : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400',
        )}>
          {testResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {testResult.message}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <button className="btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving && <Spinner className="h-3 w-3" />} Save
        </button>
        {savedAt && !saving && (
          <span className="text-2xs text-muted">
            Values stored · {savedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        {TESTABLE.has(summary.provider) && (
          <button className="btn-secondary btn-sm" disabled={testing} onClick={() => void test()}>
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />} Test connection
          </button>
        )}
        {summary.provider === 'imap' && (
          <button className="btn-secondary btn-sm" disabled={syncing} onClick={() => void syncNow()}>
            {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Sync now
          </button>
        )}
      </div>
    </div>
  );
}

export default function IntegrationsAdmin(): JSX.Element {
  const [tab, setTab] = useState('connect');
  const [copied, setCopied] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<IntegrationSummary | null>(null);
  const [manageProvider, setManageProvider] = useState<string | null>(null);

  const { data: integrations, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.integrations(),
  });

  const { data: webforms } = useQuery({
    queryKey: ['webforms'],
    queryFn: () => api.webforms(),
    enabled: tab === 'webforms',
  });

  const { data: inbox } = useQuery({
    queryKey: ['lead-inbox'],
    queryFn: () => api.leadInbox(),
    enabled: tab === 'inbox',
  });

  const summaries = integrations ?? [];

  // Resolved from the query on every render rather than stashed, so a save or
  // a test inside the modal updates the card in place instead of showing a
  // stale snapshot.
  const managing = manageProvider ? summaries.find((s) => s.provider === manageProvider) : null;

  const openSetup = (provider: string): void => {
    const summary = summaries.find((s) => s.provider === provider);
    if (!summary) return;
    // Guided steps where they exist; the detailed settings where they don't.
    if (GUIDES[provider]) setConnecting(summary); else setManageProvider(provider);
  };
  const openManage = (provider: string): void => setManageProvider(provider);

  const copy = (text: string): void => {
    void copyText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  const KIND_LABELS: Record<string, string> = {
    messaging: 'WhatsApp', telephony: 'Telephony', lead_source: 'Lead sources', email: 'Email', ai: 'AI', storage: 'Storage',
  };

  const attention = buildAttentionItems(summaries);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted">
          Pick what you want to do and follow the steps. Nothing needs editing in
          a config file, and nothing needs a redeploy.
        </p>
      </div>

      {/* The page's first screenful answers one question: is anything wrong,
          and what do I do about it? */}
      {!isLoading && integrations && (
        attention.length > 0 ? (
          <div className="mb-4">
            <AttentionStrip
              items={attention}
              onAction={(item) => (item.mode === 'manage' ? openManage(item.provider) : openSetup(item.provider))}
            />
          </div>
        ) : (
          <p className="mb-4 flex items-center gap-1.5 text-sm text-muted">
            <CheckCircle2 className="h-4 w-4 text-positive" />
            Everything is connected.
          </p>
        )
      )}

      <Tabs
        tabs={[
          { key: 'connect', label: 'Connect', icon: <Wand2 className="h-3.5 w-3.5" /> },
          { key: 'providers', label: 'All settings', icon: <Settings2 className="h-3.5 w-3.5" /> },
          { key: 'webhooks', label: 'Webhook URLs', icon: <Webhook className="h-3.5 w-3.5" /> },
          { key: 'webforms', label: 'Web forms', icon: <Globe className="h-3.5 w-3.5" /> },
          { key: 'inbox', label: 'Lead inbox', icon: <Sparkles className="h-3.5 w-3.5" /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'connect' && (
        isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-3 md:grid-cols-2">
              {JOBS.map((job) => (
                <JobCard key={job.id} job={job} summaries={summaries} onSetup={openSetup} onManage={openManage} />
              ))}
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900 text-muted">
              <p className="mb-1.5 font-medium text-slate-700 dark:text-slate-300">If something will not connect</p>
              <p>
                Every integration degrades gracefully — without it, messages and calls are still logged
                in the CRM, so nothing is lost while you sort it out. The guided steps cover the common
                path; "All settings" has every field if your provider needs something unusual. Secrets
                are encrypted before they are stored and are never sent back to the browser.
              </p>
            </div>
          </div>
        )
      )}

      {connecting && (
        <ConnectWizard summary={connecting} onClose={() => setConnecting(null)} />
      )}

      {managing && (
        <Modal open onClose={() => setManageProvider(null)} title={managing.label} size="lg">
          <ProviderCard summary={managing} />
        </Modal>
      )}

      {tab === 'providers' && (
        isLoading ? (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : (
          <div className="space-y-6">
            {['messaging', 'telephony', 'email', 'ai', 'lead_source', 'storage'].map((kind) => {
              const list = (integrations ?? []).filter((i) => i.kind === kind && PROVIDER_FIELDS[i.provider]);
              if (!list.length) return null;
              return (
                <div key={kind}>
                  <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                    {KIND_LABELS[kind] ?? kind.replace(/_/g, ' ')}
                  </p>
                  <div className="space-y-3">
                    {list.map((summary) => <ProviderCard key={summary.provider} summary={summary} />)}
                  </div>
                </div>
              );
            })}

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900 text-muted">
              <p className="mb-1.5 font-medium text-slate-700 dark:text-slate-300">How this works</p>
              <p>
                Every integration degrades gracefully — without credentials, messages and calls are still
                logged in the CRM so workflows stay testable. Saving credentials here activates the
                provider automatically; use the toggle to switch one off without clearing what you entered.
                Secrets are encrypted before they're stored and are never sent back to the browser — the
                fields above show only a masked preview of what's already saved.
              </p>
            </div>
          </div>
        )
      )}

      {tab === 'webhooks' && (
        <div className="card overflow-hidden">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {WEBHOOK_ENDPOINTS.map((endpoint) => {
              const url = `${API_BASE}${endpoint.path}`;
              return (
                <li key={endpoint.path} className="p-3">
                  <div className="flex items-center gap-2.5">
                    <endpoint.icon className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="text-sm font-medium">{endpoint.label}</span>
                    <button
                      onClick={() => copy(url)}
                      className="btn-ghost btn-sm ml-auto shrink-0"
                    >
                      {copied === url ? <Check className="h-3 w-3 text-positive" /> : <Copy className="h-3 w-3" />}
                      {copied === url ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <code className="mt-1 block break-all rounded bg-slate-50 px-2 py-1 font-mono text-2xs dark:bg-slate-800 text-muted">
                    {url}
                  </code>
                  {endpoint.note && (
                    <p className="mt-1 text-2xs text-muted">{endpoint.note}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {tab === 'webforms' && (
        <div className="card overflow-hidden">
          {!webforms?.length ? (
            <EmptyState
              icon={<Globe className="h-8 w-8" />}
              title="No web forms yet"
              body="Create a form to capture leads from your website or a landing page."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {(webforms as { id: string; name: string; embedUrl: string; formPath: string; submission_count: number; is_active: boolean }[])
                .map((form) => {
                  const publicUrl = `${window.location.origin}${form.formPath}`;
                  return (
                    <li key={form.id} className="p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{form.name}</span>
                        <Badge color={form.is_active ? '#22c55e' : '#94a3b8'}>
                          {form.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                        <span className="ml-auto text-2xs text-muted tnum">
                          {form.submission_count} submissions
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <a href={form.formPath} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
                          <ExternalLink className="h-3.5 w-3.5" /> Open form
                        </a>
                        <button className="btn-ghost btn-sm" onClick={() => copy(publicUrl)}>
                          {copied === publicUrl ? <Check className="h-3 w-3 text-positive" /> : <Copy className="h-3 w-3" />}
                          {copied === publicUrl ? 'Copied' : 'Copy link'}
                        </button>
                      </div>
                      <p className="mt-1.5 text-2xs text-muted">For your website&apos;s developer to post to:</p>
                      <code className="mt-0.5 block break-all rounded bg-slate-50 px-2 py-1 font-mono text-2xs dark:bg-slate-800">
                        {form.embedUrl}
                      </code>
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      )}

      {tab === 'inbox' && (
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Raw inbound leads</p>
            <p className="text-xs text-muted">
              Every payload is stored before processing, so a mapping problem never loses a lead.
            </p>
          </div>
          {!inbox?.length ? (
            <EmptyState title="No inbound leads recorded yet" />
          ) : (
            <table className="w-full">
              <thead>
                <tr>{['Source', 'Status', 'Received', 'Error'].map((h) => <th key={h} className="list-head">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(inbox as { id: string; source: string; status: string; received_at: string; error: string | null; record_id: string | null }[])
                  .map((row) => (
                    <tr key={row.id}>
                      <td className="list-cell font-medium capitalize">{row.source.replace(/_/g, ' ')}</td>
                      <td className="list-cell">
                        <Badge color={
                          row.status === 'processed' ? '#22c55e'
                            : row.status === 'duplicate' ? '#f59e0b'
                            : row.status === 'failed' ? '#ef4444' : '#94a3b8'
                        }>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="list-cell text-2xs text-muted">{relativeTime(row.received_at)}</td>
                      <td className="list-cell max-w-xs truncate text-2xs text-negative">{row.error ?? '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
