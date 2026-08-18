import type { JSX } from 'react';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  ArrowRight, Check, CheckCircle2, Copy, Download, ExternalLink, Globe, HardDrive, Loader2,
  Mail, MessageCircle, Phone, Plug, Settings2, Sparkles, Webhook, Wand2, X, XCircle,
} from 'lucide-react';
import { api, type IntegrationSummary } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, EmptyState, Modal, Skeleton, Spinner, Tabs, Toggle } from '../../components/ui';

const API_BASE = window.location.origin;

const WEBHOOK_ENDPOINTS = [
  { label: 'WhatsApp (Meta Cloud API)', path: '/api/webhooks/whatsapp', icon: MessageCircle, note: 'Set as the callback URL in your Meta app. The verify token is set below, under WhatsApp.' },
  { label: 'Facebook Lead Ads', path: '/api/webhooks/leads/facebook', icon: Globe, note: 'Subscribe your page to the leadgen field.' },
  { label: 'Google Ads lead form', path: '/api/webhooks/leads/google', icon: Globe, note: 'Paste as the webhook URL; the key must match what you set below, under Google Ads.' },
  { label: '99acres', path: '/api/webhooks/leads/portal/99acres', icon: Globe, note: 'Give this URL to your portal account manager.' },
  { label: 'MagicBricks', path: '/api/webhooks/leads/portal/magicbricks', icon: Globe },
  { label: 'Housing.com', path: '/api/webhooks/leads/portal/housing', icon: Globe },
  { label: 'NoBroker', path: '/api/webhooks/leads/portal/nobroker', icon: Globe },
  { label: 'Twilio — call status', path: '/api/webhooks/telephony/twilio/status', icon: Phone },
  { label: 'Twilio — incoming call', path: '/api/webhooks/telephony/twilio/incoming', icon: Phone, note: 'Set as the voice webhook on your Twilio number.' },
  { label: 'Exotel — call status', path: '/api/webhooks/telephony/exotel/status', icon: Phone },
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
  meta_whatsapp: [
    { key: 'phoneNumberId', label: 'Phone Number ID', source: 'credentials' },
    { key: 'businessAccountId', label: 'Business Account ID', source: 'credentials' },
    { key: 'accessToken', label: 'Access Token', source: 'credentials', secret: true },
    { key: 'appSecret', label: 'App Secret', source: 'credentials', secret: true },
    { key: 'verifyToken', label: 'Webhook Verify Token', source: 'config', placeholder: 'ipropy-verify-token' },
    { key: 'apiVersion', label: 'API Version', source: 'config', placeholder: 'v21.0' },
  ],
  twilio: [
    { key: 'accountSid', label: 'Account SID', source: 'credentials' },
    { key: 'authToken', label: 'Auth Token', source: 'credentials', secret: true },
    { key: 'callerId', label: 'Caller ID', source: 'config', placeholder: '+91...' },
    { key: 'appSid', label: 'TwiML App SID', source: 'config' },
  ],
  exotel: [
    { key: 'sid', label: 'Account SID', source: 'credentials' },
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'apiToken', label: 'API Token', source: 'credentials', secret: true },
    { key: 'subdomain', label: 'Subdomain', source: 'config', placeholder: 'api.exotel.com' },
    { key: 'callerId', label: 'Caller ID', source: 'config', placeholder: '+91...' },
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
  ai_opencode: [
    { key: 'apiKey', label: 'OpenCode Zen API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'nemotron-3-ultra-free', model: true },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'deepseek-v4-flash-free', model: true },
  ],
  ai_openai: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'baseUrl', label: 'Base URL', source: 'config', placeholder: 'https://api.openai.com/v1' },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'gpt-4o-mini', model: true },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'gpt-4o-mini', model: true },
  ],
  ai_ollama: [
    { key: 'baseUrl', label: 'Base URL', source: 'config', placeholder: 'http://localhost:11434/v1' },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'llama3.1', model: true },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'llama3.1', model: true },
  ],
  stt: [
    { key: 'apiKey', label: 'API Key (OpenAI-compatible Whisper)', source: 'credentials', secret: true },
    { key: 'baseUrl', label: 'Base URL', source: 'config', placeholder: 'https://api.openai.com/v1' },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'whisper-large-v3-turbo', model: true },
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
  'meta_whatsapp', 'twilio', 'exotel', 'smtp', 'imap', 'facebook_leads',
  'anthropic', 'ai_gemini', 'ai_groq', 'ai_openrouter', 'ai_openai', 'ai_ollama',
  'ai_opencode', 'stt', 'onedrive',
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
  ai_opencode: {
    free: true,
    text: 'OpenCode Zen gives one key access to several models. The CRM lists only models compatible with its chat API, including the free choices.',
    href: 'https://opencode.ai/zen',
    linkLabel: 'Get a key',
  },
  ai_openai: {
    text: 'Any OpenAI-compatible endpoint — OpenAI, Together, Fireworks, vLLM.',
    href: 'https://platform.openai.com/api-keys',
    linkLabel: 'Get a key',
  },
  ai_ollama: {
    free: true,
    text: 'Free and fully local — nothing leaves this machine. Needs `ollama serve` running.',
    href: 'https://ollama.com/download',
    linkLabel: 'Install Ollama',
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
  twilio: {
    outcome: 'Click a phone number in the CRM and your phone rings, then connects the customer. Calls are logged and recorded.',
    minutes: 5,
    steps: [
      { title: 'Open your Twilio console', help: 'Sign in to Twilio. The first two values are on the dashboard you land on.', href: 'https://console.twilio.com', linkLabel: 'Open Twilio' },
      { title: 'Copy the Account SID', help: 'On the dashboard, under Account Info.', field: 'accountSid' },
      { title: 'Copy the Auth Token', help: 'Same panel — click Show to reveal it.', field: 'authToken' },
      { title: 'Which number should customers see?', help: 'One of your Twilio numbers, with the country code. Phone Numbers → Manage → Active numbers.', field: 'callerId' },
      { title: 'Tell Twilio where to report calls', help: 'Phone Numbers → your number → Voice Configuration. Paste this as the webhook for incoming calls.', copyPath: '/api/webhooks/telephony/twilio/incoming' },
    ],
  },
  exotel: {
    outcome: 'Click-to-call and call recording through Exotel, the common choice for Indian numbers.',
    minutes: 5,
    steps: [
      { title: 'Open your Exotel dashboard', help: 'Sign in, then go to Settings → API Settings.', href: 'https://my.exotel.com', linkLabel: 'Open Exotel' },
      { title: 'Copy the Account SID', help: 'On the API Settings page.', field: 'sid' },
      { title: 'Copy the API Key', help: 'Same page. Create one if there is none yet.', field: 'apiKey' },
      { title: 'Copy the API Token', help: 'Shown beside the key.', field: 'apiToken' },
      { title: 'Which number should customers see?', help: 'Your Exovirtual number, with the country code.', field: 'callerId' },
      { title: 'Tell Exotel where to report calls', help: 'Paste this as the status callback URL on your ExoPhone.', copyPath: '/api/webhooks/telephony/exotel/status' },
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
  ai_opencode: {
    outcome: 'Use OpenCode Zen free models for high-volume CRM text work, with other providers still available as fallbacks.',
    minutes: 2,
    steps: [
      { title: 'Create an OpenCode Zen key', help: 'Open Zen, add a key, then copy it. Free models can be used without choosing a paid model.', href: 'https://opencode.ai/zen', linkLabel: 'Open OpenCode Zen' },
      { title: 'Paste the key', help: 'After connecting, the detailed settings load the current compatible models directly from OpenCode.', field: 'apiKey' },
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
  ai_ollama: {
    outcome: 'AI that runs on this machine. Free, and nothing leaves the building.',
    minutes: 5,
    steps: [
      { title: 'Install Ollama', help: 'Download it, then run "ollama serve" and "ollama pull llama3.1" in a terminal.', href: 'https://ollama.com/download', linkLabel: 'Install Ollama' },
      { title: 'Where is it running?', help: 'Leave the default unless you moved it.', field: 'baseUrl' },
      { title: 'Which model did you pull?', help: 'The name you used with "ollama pull", e.g. llama3.1.', field: 'model' },
    ],
  },
  stt: {
    outcome: 'Turn property voice notes and call recordings into searchable text automatically.',
    minutes: 2,
    steps: [
      { title: 'Choose a Whisper provider', help: 'Groq is the low-cost, fast recommendation. The same Groq key can be used here and on the Groq AI card.', href: 'https://console.groq.com/keys', linkLabel: 'Open Groq keys' },
      { title: 'Paste the API key', help: 'Use your Groq or OpenAI-compatible speech key.', field: 'apiKey' },
      { title: 'Set the speech API address', help: 'For Groq use https://api.groq.com/openai/v1. For OpenAI use https://api.openai.com/v1.', field: 'baseUrl' },
      { title: 'Choose the transcription model', help: 'For Groq, whisper-large-v3-turbo is the fast recommended choice.', field: 'model' },
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

/**
 * What each connector is *for*, grouped by the job rather than by the
 * technology. Someone looking to reach customers on WhatsApp should not have
 * to know that the answer is filed under "messaging".
 */
const CATALOGUE: { title: string; blurb: string; icon: typeof MessageCircle; providers: string[] }[] = [
  {
    title: 'Message customers on WhatsApp',
    blurb: 'Two-way chat in the Inbox, plus templates and broadcasts.',
    icon: MessageCircle,
    providers: ['meta_whatsapp'],
  },
  {
    title: 'Make and record calls',
    blurb: 'Click a number to call, with the recording saved against the lead.',
    icon: Phone,
    providers: ['twilio', 'exotel'],
  },
  {
    title: 'Capture leads automatically',
    blurb: 'Ads, portals and your own website feed straight into Leads.',
    icon: Globe,
    providers: ['facebook_leads', 'google_ads', 'webform'],
  },
  {
    title: 'Send and receive email',
    blurb: 'Send from your own address; replies land on the right lead.',
    icon: Mail,
    providers: ['smtp', 'imap'],
  },
  {
    title: 'Turn on AI',
    blurb: 'Lead scoring, reply drafting and the assistant. Free options available.',
    icon: Sparkles,
    providers: ['ai_gemini', 'ai_groq', 'ai_opencode', 'ai_openrouter', 'ai_openai', 'ai_ollama', 'anthropic'],
  },
  {
    title: 'Understand voice notes and calls',
    blurb: 'Transcribe speech so AI can extract facts and update the CRM.',
    icon: Sparkles,
    providers: ['stt'],
  },
  {
    title: 'Store files in your own cloud',
    blurb: 'OneDrive is recommended; S3 and local storage remain available.',
    icon: HardDrive,
    providers: ['onedrive', 's3'],
  },
];

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
    void navigator.clipboard.writeText(text);
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

/** One tile in the catalogue: what it does, whether it's on, and one button. */
function ConnectorTile({
  summary, onConnect,
}: { summary: IntegrationSummary; onConnect: () => void }): JSX.Element {
  const guide = GUIDES[summary.provider];
  const connected = summary.isActive && !summary.lastError;

  return (
    <div className="flex flex-col rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="mb-1 flex items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', connected ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700')} />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{summary.label}</p>
        {connected && <Badge color="#22c55e">Connected</Badge>}
        {summary.lastError && <Badge color="#ef4444">Needs attention</Badge>}
      </div>

      <p className="mb-3 flex-1 text-xs text-muted">
        {guide?.outcome ?? 'Configure this provider.'}
      </p>

      <button onClick={onConnect} className={cn('btn-sm w-full', connected ? 'btn-secondary' : 'btn-primary')}>
        <Wand2 className="h-3.5 w-3.5" />
        {connected ? 'Reconnect' : `Connect${guide ? ` · ${guide.minutes} min` : ''}`}
      </button>
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
        <Badge color={summary.isActive ? '#22c55e' : '#94a3b8'}>{summary.isActive ? 'Active' : 'Inactive'}</Badge>
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

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  const KIND_LABELS: Record<string, string> = {
    messaging: 'WhatsApp', telephony: 'Telephony', lead_source: 'Lead sources', email: 'Email', ai: 'AI', storage: 'Storage',
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted">
          Pick what you want to do and follow the steps. Nothing needs editing in
          a config file, and nothing needs a redeploy.
        </p>
      </div>

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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
        ) : (
          <div className="space-y-6">
            {CATALOGUE.map((group) => {
              const list = group.providers
                .map((name) => (integrations ?? []).find((i) => i.provider === name))
                .filter((i): i is IntegrationSummary => Boolean(i));
              if (!list.length) return null;
              const connected = list.filter((i) => i.isActive && !i.lastError).length;

              return (
                <div key={group.title}>
                  <div className="mb-2 flex items-center gap-2">
                    <group.icon className="h-4 w-4 shrink-0 text-slate-400" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{group.title}</p>
                      <p className="text-xs text-muted">{group.blurb}</p>
                    </div>
                    {connected > 0 && (
                      <Badge className="ml-auto shrink-0" color="#22c55e">
                        {connected} connected
                      </Badge>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {list.map((summary) => (
                      <ConnectorTile
                        key={summary.provider}
                        summary={summary}
                        onConnect={() => setConnecting(summary)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}

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
              {(webforms as { id: string; name: string; embedUrl: string; submission_count: number; is_active: boolean }[])
                .map((form) => (
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
                    <code className="mt-1 block break-all rounded bg-slate-50 px-2 py-1 font-mono text-2xs dark:bg-slate-800">
                      {form.embedUrl}
                    </code>
                  </li>
                ))}
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
                <tr>{['Source', 'Status', 'Received', 'Error'].map((h) => <th key={h} className="table-head">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(inbox as { id: string; source: string; status: string; received_at: string; error: string | null; record_id: string | null }[])
                  .map((row) => (
                    <tr key={row.id}>
                      <td className="table-cell font-medium capitalize">{row.source.replace(/_/g, ' ')}</td>
                      <td className="table-cell">
                        <Badge color={
                          row.status === 'processed' ? '#22c55e'
                            : row.status === 'duplicate' ? '#f59e0b'
                            : row.status === 'failed' ? '#ef4444' : '#94a3b8'
                        }>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="table-cell text-2xs text-muted">{relativeTime(row.received_at)}</td>
                      <td className="table-cell max-w-xs truncate text-2xs text-negative">{row.error ?? '—'}</td>
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
