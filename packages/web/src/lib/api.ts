/**
 * Typed API client.
 *
 * A single fetch wrapper handles auth headers, token refresh on 401, and turns
 * server error envelopes into thrown ApiError objects the UI can render.
 */
import type {
  AuthUser, BuyerMatch, CustomView, Dashboard, FieldMeta, ListQuery, ListResult, ModuleMeta,
  PropertyMatch, RecordEnvelope, TimelineEntry,
} from '@ipropy/shared';

const TOKEN_KEY = 'ipropy.token';
const REFRESH_KEY = 'ipropy.refresh';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const tokenStore = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (token: string): void => localStorage.setItem(TOKEN_KEY, token),
  /*
    Read, but no longer written.

    The refresh token lives in an httpOnly cookie now, where no script on the
    page can reach it — not an injected advert, not a compromised dependency.
    It is good for thirty days and exists to mint logins, so a copy of it in
    localStorage was a month of somebody else's access sitting in reach of any
    XSS.

    The getter stays because browsers signed in before this shipped still have
    the old value, and the server still accepts it. They hand it over once, get
    a cookie back, and `forgetRefresh` clears it. Nobody is logged out.
  */
  getRefresh: (): string | null => localStorage.getItem(REFRESH_KEY),
  forgetRefresh: (): void => localStorage.removeItem(REFRESH_KEY),
  clear: (): void => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

let refreshPromise: Promise<boolean> | null = null;

async function refreshToken(): Promise<boolean> {
  // Collapse concurrent 401s into a single refresh attempt.
  if (refreshPromise) return refreshPromise;

  // No localStorage token is the normal case now: the cookie carries it and the
  // browser attaches it on its own. Only give up if there is no session at all,
  // which the server tells us by refusing the refresh.
  const refresh = tokenStore.getRefresh();

  refreshPromise = fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  })
    .then(async (res) => {
      if (!res.ok) return false;
      const data = await res.json() as { token: string; refreshToken?: string };
      tokenStore.set(data.token);
      /*
        Refresh tokens rotate now: each exchange retires the one that was used.
        Failing to store the replacement means the next refresh presents a
        retired token, which the server reads as a stolen one and answers by
        signing every session out. So this line is what stands between rotation
        and being logged out every hour.

        It is absent when a second tab refreshed a moment earlier — that reply
        deliberately carries no new refresh token, and the one already held is
        still the live one.
      */
      /*
        The server set a cookie alongside this response, so the copy in
        localStorage is now both redundant and the only one an attacker could
        read. Clearing it here is what actually completes the migration, one
        browser at a time, without anybody signing in again.
      */
      tokenStore.forgetRefresh();
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshPromise = null; });

  return refreshPromise;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** don't attempt a token refresh (used by auth calls themselves) */
  skipRefresh?: boolean;
  raw?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipRefresh, raw, headers, ...rest } = options;

  const doFetch = async (): Promise<Response> => {
    const token = tokenStore.get();
    const isFormData = body instanceof FormData;
    return fetch(path.startsWith('/') ? path : `/api/${path}`, {
      ...rest,
      // Required by the trusted-device PIN in split localhost deployments.
      // Its HttpOnly cookie is path-scoped to /api/auth/pin.
      credentials: rest.credentials ?? 'include',
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers as Record<string, string> ?? {}),
      },
      body: body === undefined ? undefined : (isFormData ? body : JSON.stringify(body)),
    });
  };

  let res = await doFetch();

  if (res.status === 401 && !skipRefresh) {
    if (await refreshToken()) {
      res = await doFetch();
    } else {
      tokenStore.clear();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
      throw new ApiError('Your session expired. Please sign in again.', 401, 'unauthorized');
    }
  }

  if (!res.ok) {
    let payload: { message?: string; error?: string; details?: unknown } = {};
    try { payload = await res.json(); } catch { /* non-JSON error body */ }
    throw new ApiError(
      payload.message ?? `Request failed (${res.status})`,
      res.status,
      payload.error ?? 'error',
      payload.details,
    );
  }

  if (raw) return res as unknown as T;

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? JSON.parse(text) as T : (undefined as T);
}

/**
 * Add the session token to a same-origin file URL.
 *
 * `<img>`, `<iframe>` and `<video>` cannot carry an Authorization header, and
 * `/api/files/:id` is permission-checked — so embeds use the `?access_token=`
 * fallback `requireAuth` already supports. External URLs are returned as-is:
 * sending our token to someone else's host would leak the session.
 */
export function authedFileUrl(url: string, params: Record<string, string> = {}): string {
  if (!url.startsWith('/api/')) return url;
  const search = new URLSearchParams(params);
  const token = tokenStore.get();
  if (token) search.set('access_token', token);
  const qs = search.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'POST', body });
const patch = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'PATCH', body });
const put = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'PUT', body });
const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------


/** A link that shows one property to one person — see server/core/sharing/shareLinks.ts. */
/** One field of an import collision, as it stands on each side. */
export interface ImportFieldComparison {
  name: string;
  label: string;
  uitype: string;
  incoming: unknown;
  existing: unknown;
  incomingDisplay: string | null;
  existingDisplay: string | null;
  /** Both sides filled in, and they disagree — the only case needing a decision. */
  conflict: boolean;
  /** The sheet has something the record does not. Merged in unless told otherwise. */
  fillsGap: boolean;
  /** The sheet's column is empty here, so the record's value simply stands. */
  absent: boolean;
  matched: boolean;
}

export interface ImportDuplicatePair {
  id: string;
  rowNumber: number;
  existingId: string;
  existingLabel: string;
  incomingLabel: string;
  matchedOn: string[];
  fields: ImportFieldComparison[];
  /** The record it collided with can no longer be read — only Skip and Create apply. */
  existingMissing: boolean;
}

export type ImportResolution = 'merged' | 'skipped' | 'created';
export type ImportSection = 'created' | 'updated' | 'skipped' | 'failed' | 'duplicates' | 'all';

export interface SearchHit {
  id: string;
  module: string;
  moduleLabel: string;
  label: string;
  /**
   * The number is on a record this user cannot open. Carries a name and an
   * owner and nothing else — there is no id to follow.
   */
  restricted?: true;
  ownerName?: string | null;
}

export interface ShareLink {
  id: string;
  recordId: string;
  token: string;
  /** Who it was sent to. The sender's own note; never shown to the visitor. */
  label: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

/** What the public page renders. No auth, no CRM fields beyond the whitelist. */
export interface SharedProperty {
  property: Record<string, unknown>;
  fields: { name: string; label: string; uitype: string }[];
  photos: { id: string; url: string }[];
  sharedAt: string;
}

export interface PropertyShareAdminConfig {
  fields: { name: string; label: string; uitype: string; visible: boolean }[];
  showPhotos: boolean;
}

export interface MatchingFieldPair {
  contactField: string;
  propertyField: string;
  contactFieldId?: string;
  propertyFieldId?: string;
}

export interface MatchingAdminConfig {
  fieldMap: MatchingFieldPair[];
  priceGracePercent: number;
  contactFields: { id: string; name: string; label: string; uitype: string }[];
  propertyFields: { id: string; name: string; label: string; uitype: string }[];
}

/** A site visit — see server/src/core/capture/sessions.ts. */
export interface CaptureSession {
  /** Whether a gate recording exists and how far transcription got. */
  voiceStatus: 'none' | 'pending' | 'done' | 'failed';
  voiceNoteId: string | null;
  id: string;
  recordId: string | null;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  status: 'capturing' | 'ready' | 'reviewed';
  transcript: string | null;
  clientRef: string;
  deviceLabel: string | null;
  notes: string | null;
}

export interface CaptureSessionRow extends CaptureSession {
  mediaCount: number;
  recordLabel: string | null;
}

/**
 * Where a property's media has got to.
 *
 * Was `CaptureStorageStatus`, left behind when the capture screens were removed
 * and referenced by nothing. The three timestamps are what let the record say
 * whether processing is working, finished or stuck, instead of going quiet after
 * Finish and looking identical to a property nobody had touched.
 */
export interface PropertyStorageInfo {
  recordId: string;
  folderKey: string | null;
  status: 'pending' | 'running' | 'ready' | 'failed';
  provisionedDriver: string | null;
  externalUrl: string | null;
  lastError: string | null;
  folderMadeAt: string | null;
  mediaRequestedAt: string | null;
  mediaDoneAt: string | null;
  photosInCrm: number;
}

export interface AiAssistantAction {
  id: string;
  type: 'update_record';
  /** Where it came from — a chat message, or a call that has just ended. */
  origin?: 'ask_ipropy' | 'call';
  summary: string;
  module: string;
  recordId: string;
  recordLabel: string;
  changes: { field: string; label: string; from: unknown; to: unknown }[];
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
  expiresAt: string;
}

export interface AiAssistantChoice {
  id: string;
  module: string;
  moduleLabel: string;
  label: string;
  recordNumber: string | null;
}

export interface AiAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  at?: string;
  query?: Record<string, unknown>;
  action?: AiAssistantAction;
  choices?: AiAssistantChoice[];
  results?: ListResult;
}

export interface AiThreadSummary {
  id: string;
  title: string;
  contextRecordId: string | null;
  contextModule: string | null;
  updatedAt: string;
  messageCount: number;
  preview: string | null;
}

export interface AiThreadDetail extends Omit<AiThreadSummary, 'messageCount' | 'preview'> {
  messages: AiAssistantMessage[];
  createdAt: string;
}

export interface AiMemory {
  id: string;
  fact: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiAskResponse {
  answer: string;
  threadId: string;
  query?: Record<string, unknown>;
  results?: ListResult;
  action?: AiAssistantAction;
  choices?: AiAssistantChoice[];
  remembered?: AiMemory;
}

/**
 * A shoot with no property on it yet — see server/src/core/capture/grouping.ts.
 *
 * Either a run of photos the clock grouped together with nobody having tapped
 * anything, or a visit somebody opened and never named. The screen treats them
 * identically because the job is identical: point it at a property.
 */
export interface UnnamedShoot {
  id: string;
  origin: 'manual' | 'auto';
  startedAt: string;
  endedAt: string | null;
  mediaCount: number;
  /** A handful of attachment ids, enough to recognise the place at a glance. */
  previewIds: string[];
  transcript: string | null;
  lat: number | null;
  lng: number | null;
  /**
   * What a model saw in the photos. Null on an install with no AI provider —
   * which is this one until a key is added — so the screen must read fine
   * without it.
   */
  summary: string | null;
  features: string[];
}

/** One parsed detail, as the review screen needs to weigh it. */
export interface CaptureSuggestion {
  field: string;
  label: string;
  uitype: string;
  /** What the speaker actually said — the only way to judge a decode. */
  heard: string | null;
  value: unknown;
  formatted: string;
  current: unknown;
  currentFormatted: string;
  /** False when the record already says this; those rows are not worth asking about. */
  changes: boolean;
}

export interface CaptureSessionDetail extends CaptureSession {
  suggestions: CaptureSuggestion[];
  /** Metadata for the suggested fields, so a wrong value is editable in place. */
  fields: Record<string, FieldMeta>;
  unmatched: string[];
  voiceUrl: string | null;
}

export interface ModuleSummary {
  id: string; name: string; label: string; singularLabel: string;
  icon: string; color: string; sequence: number; isEntity: boolean; isCustom: boolean;
  pipelineField: string | null; menuGroup: string; showInMenu: boolean;
  /** `tabGroup` makes several modules share one menu entry as tabs. */
  settings?: { tabGroup?: string; tabOrder?: number; [key: string]: unknown };
  supportsComments: boolean; supportsAttachments: boolean; supportsTags: boolean;
  supportsConversion: boolean;
  permissions: { view: boolean; create: boolean; edit: boolean; delete: boolean; export: boolean; import: boolean };
}

export interface IntegrationSummary {
  provider: string; kind: string; label: string; isActive: boolean;
  status: string; lastSyncAt: string | null; lastError: string | null;
  config: Record<string, string>;
  credentialFields: Record<string, { set: boolean; preview: string }>;
}

export interface IntegrationModel {
  id: string;
  label: string;
  contextLength: number | null;
  free: boolean;
  vision: boolean;
}

export interface IntegrationModelCatalogue {
  models: IntegrationModel[];
  live: boolean;
  warning?: string;
}

/** A message the CRM composed, waiting for a human to send it from their phone. */
export interface DeviceSend {
  id: string; handle: string; name: string | null; body: string;
  reason: string | null; recordId: string | null; module: string | null;
  link: string; createdAt: string;
}

/** A rep's own WhatsApp, linked to the CRM the way WhatsApp Web links a laptop. */
export interface WaLink {
  id: string; userId: string; userName: string | null;
  handle: string | null; label: string | null;
  status: 'pending' | 'connected' | 'logged_out' | 'disabled';
  /** A PNG data URI while waiting to be scanned, null once connected. */
  qr: string | null; qrExpiresAt: string | null;
  linkedAt: string | null; lastSeenAt: string | null; lastSentAt: string | null;
  lastError: string | null;
  sentToday: number; sentTotal: number; dailyCap: number;
  takesUnassigned: boolean;
}

export interface PinStatus {
  available: boolean;
  label?: string | null;
  userHint?: string;
  lockedUntil?: string | null;
}

export interface PinDevice {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  locked_until: string | null;
  is_current: boolean;
}

export const api = {
  /** Escape hatch for endpoints without a dedicated helper. */
  request,

  // --- auth ---------------------------------------------------------------
  /** `identifier` is an email address or a mobile number. */
  finishProperty: (id: string) =>
    post<{ sent: boolean; reason?: string }>(`/api/records/properties/${id}/finish`, {}),
  propertyStorage: (id: string) =>
    get<PropertyStorageInfo | null>(`/api/records/properties/${id}/storage`),
  forgotPassword: (email: string) =>
    request<{ ok: true }>('/api/auth/forgot-password', {
      method: 'POST', body: { email }, skipRefresh: true,
    }),
  resetPassword: (token: string, newPassword: string) =>
    request<{ ok: true }>('/api/auth/reset-password', {
      method: 'POST', body: { token, newPassword }, skipRefresh: true,
    }),
  login: (identifier: string, password: string) =>
    request<{ token: string; refreshToken: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST', body: { identifier, password }, skipRefresh: true,
    }),

  // --- passkeys (Face ID / Touch ID / Android biometrics) -------------------
  passkeyRegisterOptions: () => post<Record<string, unknown>>('/api/auth/passkeys/register/options', {}),
  passkeyRegisterVerify: (response: unknown, label?: string) =>
    post('/api/auth/passkeys/register/verify', { response, label }),
  passkeyLoginOptions: () =>
    request<Record<string, unknown>>('/api/auth/passkeys/login/options', { method: 'POST', body: {}, skipRefresh: true }),
  passkeyLoginVerify: (response: unknown) =>
    request<{ token: string; refreshToken: string; user: AuthUser }>('/api/auth/passkeys/login/verify', {
      method: 'POST', body: { response }, skipRefresh: true,
    }),
  passkeys: () => get<Record<string, unknown>[]>('/api/auth/passkeys'),
  deletePasskey: (id: string) => del(`/api/auth/passkeys/${id}`),

  // --- trusted-device four-digit PIN ---------------------------------------
  pinStatus: () => request<PinStatus>('/api/auth/pin/status', { skipRefresh: true }),
  pinLogin: (pin: string) =>
    request<{ token: string; refreshToken: string; user: AuthUser }>('/api/auth/pin/login', {
      method: 'POST', body: { pin }, skipRefresh: true,
    }),
  enrolPin: (pin: string, currentPassword: string, label?: string) =>
    post('/api/auth/pin/enrol', { pin, currentPassword, label }),
  pinDevices: () => get<PinDevice[]>('/api/auth/pin'),
  deletePinDevice: (id: string) => del(`/api/auth/pin/${id}`),
  // The cookie is what usually identifies the session here; the body still
  // carries an old localStorage token if this browser has not refreshed yet, so
  // signing out revokes the right session either way.
  logout: () => post('/api/auth/logout', { refreshToken: tokenStore.getRefresh() }),
  me: () => get<AuthUser>('/api/auth/me'),
  updateProfile: (data: Record<string, unknown>) => patch<AuthUser>('/api/auth/me', data),
  changePassword: (currentPassword: string, newPassword: string) =>
    post('/api/auth/change-password', { currentPassword, newPassword }),

  // --- connected apps -------------------------------------------------------
  /** The plaintext `key` comes back once, on creation, and is never readable again. */
  createApiKey: (name: string, expiresInDays?: number) =>
    post<{ id: string; name: string; key: string; prefix: string; expiresAt: string | null }>(
      '/api/auth/api-keys', { name, expiresInDays },
    ),
  apiKeys: () => get<{
    id: string; name: string; key_prefix: string;
    last_used_at: string | null; expires_at: string | null;
    revoked_at: string | null; created_at: string;
  }[]>('/api/auth/api-keys'),
  revokeApiKey: (id: string) => del(`/api/auth/api-keys/${id}`),

  // --- metadata -----------------------------------------------------------
  modules: () => get<ModuleSummary[]>('/api/meta/modules'),
  module: (name: string, opts: { includeInactive?: boolean } = {}) => get<ModuleMeta & {
    layouts: { id: string; name: string; type: string; is_default: boolean; config: unknown }[];
    picklistDependencies: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[];
    permissions: ModuleSummary['permissions'];
    supportsConversion: boolean;
  }>(`/api/meta/modules/${name}${opts.includeInactive ? '?includeInactive=true' : ''}`),
  layout: (module: string, type: string) =>
    get<{ id: string; name: string; config: Record<string, unknown> }>(`/api/meta/modules/${module}/layout/${type}`),
  layouts: (module: string) => get<Record<string, unknown>[]>(`/api/meta/modules/${module}/layouts`),
  saveLayout: (id: string, data: Record<string, unknown>) => put(`/api/meta/layouts/${id}`, data),
  createLayout: (module: string, data: Record<string, unknown>) =>
    post<{ id: string }>(`/api/meta/modules/${module}/layouts`, data),
  picklists: () => get<Record<string, { value: string; label: string; color: string | null }[]>>('/api/meta/picklists'),
  picklist: (name: string) => get<{ value: string; label: string; color: string | null }[]>(`/api/meta/picklists/${name}`),
  picklistCatalogue: () => get<{
    name: string; label: string; isSystem: boolean; allowAdhoc: boolean;
    values: {
      value: string; label: string; color: string | null;
      sequence: number; isActive: boolean; isDefault: boolean;
      /** What the application matches on this exact word, if anything. */
      usedInCode: string | null;
    }[];
    usedBy: { module: string; moduleLabel: string; field: string; fieldLabel: string }[];
    canDelete: boolean;
    usedInCode: string | null;
  }[]>('/api/meta/picklist-catalogue'),
  /**
   * `restore` names values that were deleted earlier and are being brought
   * back deliberately. Anything else tombstoned is skipped and returned in
   * `skipped` — a save must not undo a deletion as a side effect.
   */
  savePicklistValues: (name: string, values: unknown[], restore: string[] = []) =>
    put<{ values: unknown[]; renamedRecords: number; renamedFilters: number; skipped?: string[] }>(
      `/api/meta/picklists/${name}/values`, { values, restore },
    ),
  createPicklist: (data: { name: string; label: string; values?: unknown[] }) =>
    post('/api/meta/picklists', data),
  renamePicklist: (name: string, label: string) => patch(`/api/meta/picklists/${name}`, { label }),
  deletePicklist: (name: string) => del(`/api/meta/picklists/${name}`),
  picklistValueUsage: (name: string, value: string) => get<{
    total: number;
    byField: { module: string; field: string; count: number }[];
    canClear: boolean;
    /** What in the application matches this option by name, if anything. */
    usedInCode: string | null;
  }>(`/api/meta/picklists/${name}/value-usage?value=${encodeURIComponent(value)}`),
  deletePicklistValue: (name: string, value: string, opts: { replaceWith?: string; clear?: boolean } = {}) =>
    del<{ ok: boolean; movedRecords: number }>(
      `/api/meta/picklists/${name}/values?value=${encodeURIComponent(value)}`
      + (opts.replaceWith ? `&replaceWith=${encodeURIComponent(opts.replaceWith)}` : '')
      + (opts.clear ? '&clear=true' : ''),
    ),
  uitypes: () => get<{ uitypes: Record<string, unknown>[]; formulaFunctions: string[] }>('/api/meta/uitypes'),
  allModules: () => get<{
    id: string; name: string; label: string; singularLabel: string;
    icon: string; color: string; isActive: boolean; isCustom: boolean; isCore: boolean;
    disabledReason: string | null; menuGroup: string;
    fieldCount: number; recordCount: number; dependents: string[];
  }[]>('/api/meta/modules/all'),
  fieldModules: () => get<{
    id: string; name: string; label: string; icon: string; color: string;
    isActive: boolean; isCustom: boolean; isEntity: boolean; fieldCount: number;
  }[]>('/api/meta/modules/field-builder'),
  toggleModule: (name: string, isActive: boolean, reason?: string) =>
    post<{ ok: boolean; message: string }>(`/api/meta/modules/${name}/toggle`, { isActive, reason }),
  createModule: (data: Record<string, unknown>) => post('/api/meta/modules', data),
  updateModule: (name: string, data: Record<string, unknown>) => patch(`/api/meta/modules/${name}`, data),
  deleteModule: (name: string, force = false) => del(`/api/meta/modules/${name}${force ? '?force=true' : ''}`),
  createField: (module: string, data: Record<string, unknown>) => post(`/api/meta/modules/${module}/fields`, data),
  updateField: (id: string, data: Record<string, unknown>) => patch(`/api/meta/fields/${id}`, data),
  previewFieldConversion: (id: string, data: { targetType: string; invalidStrategy: 'blank' | 'default' | 'keep'; valueMap?: Record<string, string>; defaultValue?: unknown }) =>
    post<{ totalRecords: number; convertibleRecords: number; invalidRecords: number; invalidSamples: { recordId: string; value: unknown }[] }>(`/api/meta/fields/${id}/type-conversion/preview`, data),
  convertField: (id: string, data: { targetType: string; invalidStrategy: 'blank' | 'default' | 'keep'; valueMap?: Record<string, string>; defaultValue?: unknown }) =>
    post<{ ok: boolean; convertedRecords: number; invalidRecords: number }>(`/api/meta/fields/${id}/type-conversion`, data),
  /** `permanent` drops the column and its data; otherwise the field is only hidden. */
  deleteField: (id: string, permanent = false) =>
    del<{ ok: boolean; deactivated?: boolean; deleted?: boolean; hadValues?: number }>(
      `/api/meta/fields/${id}${permanent ? '?permanent=true' : ''}`,
    ),
  reorderFields: (fields: { id: string; blockId: string; sequence: number }[]) =>
    post('/api/meta/fields/reorder', { fields }),
  unitMaster: (kind: 'area' | 'budget_demand') => get<{ id: string; value: string; label: string; factorSqft: number | null; isActive: boolean; isDefault: boolean }[]>(`/api/meta/masters/units/${kind}`),
  saveUnitMaster: (kind: 'area' | 'budget_demand', units: unknown[]) => put(`/api/meta/masters/units/${kind}`, { units }),
  createBlock: (module: string, data: Record<string, unknown>) =>
    post<{ id: string }>(`/api/meta/modules/${module}/blocks`, data),
  updateBlock: (id: string, data: Record<string, unknown>) => patch(`/api/meta/blocks/${id}`, data),
  deleteBlock: (id: string) => del<{ ok: boolean; deleted?: string }>(`/api/meta/blocks/${id}`),
  /** Where each person's phone last was, newest fix each. */
  teamLocations: () => get<{
    positions: {
      userId: string; name: string; latitude: number; longitude: number;
      recordedAt: string; accuracyM: number | null; batteryPct: number | null;
      atProperty: { id: string; label: string; metres: number } | null;
      atPropertyMinutes: number | null;
    }[];
    settings: {
      enabled: boolean; everyMinutes: number; fromHour: number; toHour: number;
      keepDays: number; siteRadiusM: number;
    };
  }>('/api/admin/team/locations'),
  /** One person's path over a window, oldest first. */
  teamTrail: (userId: string, hours = 12) => get<{
    trail: { latitude: number; longitude: number; recordedAt: string; accuracyM: number | null; nearLabel: string | null }[];
  }>(`/api/admin/team/locations/${userId}?hours=${hours}`),
  /**
   * What Android build the CRM is handing out, if any.
   *
   * Unauthenticated on the server side so a phone can fetch the file itself,
   * but asked for from behind a login here because the button lives in
   * Settings.
   */
  companionBuild: () => get<{
    available: boolean;
    build: {
      versionName: string; versionCode: number; minSdk: number;
      sizeBytes: number; sha256: string; builtAt: string;
    } | null;
    url: string;
  }>('/api/public/companion'),
  /** A real call against one model id, to find out whether it answers. */
  testAiModel: (job: string, model: string) =>
    post<{ ok: boolean; message: string; ms?: number }>('/api/admin/ai-models/test', { job, model }),
  /** The models that can do one job. Empty when the catalogue is unreachable. */
  aiModelCatalogue: (job: string) =>
    get<{ models: { id: string; name: string; free: boolean; price: string }[] }>(
      `/api/admin/ai-models/catalogue?job=${encodeURIComponent(job)}`,
    ),
  validateFormula: (expression: string) => post<{ valid: boolean; error?: string }>('/api/meta/fields/validate-formula', { expression }),

  // --- records ------------------------------------------------------------
  list: (module: string, query: ListQuery = {}) =>
    post<ListResult>(`/api/records/${module}/search`, query),
  record: (module: string, id: string) => get<RecordEnvelope>(`/api/records/${module}/${id}`),
  create: (module: string, values: Record<string, unknown>) => post<RecordEnvelope>(`/api/records/${module}`, values),
  update: (module: string, id: string, values: Record<string, unknown>) =>
    patch<RecordEnvelope>(`/api/records/${module}/${id}`, values),
  remove: (module: string, id: string) => del(`/api/records/${module}/${id}`),
  lookup: (module: string, q: string, filter?: unknown) =>
    get<{ id: string; label: string; recordNumber: string | null }[]>(`/api/records/${module}/lookup${qs({ q, filter })}`),
  timeline: (module: string, id: string, types?: string[]) =>
    get<TimelineEntry[]>(`/api/records/${module}/${id}/timeline${qs({ types: types?.join(',') })}`),
  comments: (module: string, id: string) =>
    get<Record<string, unknown>[]>(`/api/records/${module}/${id}/comments`),
  addComment: (module: string, id: string, body: string, mentions: string[] = []) =>
    post(`/api/records/${module}/${id}/comments`, { body, mentions }),
  /** Fix a note after posting — the author only; the old text is kept as history. */
  editComment: (module: string, id: string, commentId: string, body: string, mentions: string[] = []) =>
    patch<{ ok: boolean; edited: boolean }>(`/api/records/${module}/${id}/comments/${commentId}`, { body, mentions }),
  related: (module: string, id: string, relation: string, page = 1) =>
    get<ListResult & { relation: Record<string, unknown> }>(`/api/records/${module}/${id}/related/${relation}${qs({ page })}`),
  linkRelated: (module: string, id: string, relation: string, targetId: string) =>
    post(`/api/records/${module}/${id}/related/${relation}`, { targetId }),
  unlinkRelated: (module: string, id: string, relation: string, targetId: string) =>
    del(`/api/records/${module}/${id}/related/${relation}/${targetId}`),
  audit: (module: string, id: string) => get<Record<string, unknown>[]>(`/api/records/${module}/${id}/audit`),
  checkDuplicates: (module: string, values: Record<string, unknown>, excludeId?: string) =>
    post<{ id: string; label: string; matchedOn: string[] }[]>(`/api/records/${module}/check-duplicates`, { values, excludeId }),
  massUpdate: (module: string, ids: string[], values: Record<string, unknown>) =>
    post<{ updated: number; failed: unknown[] }>(`/api/records/${module}/mass-update`, { ids, values }),
  /** Gmail's "select all in this search": every record the view/filter matches. */
  massUpdateAll: (module: string, query: Record<string, unknown>, values: Record<string, unknown>) =>
    post<{ updated: number; matched: number; capped: boolean; failed: unknown[] }>(
      `/api/records/${module}/mass-update-all`, { query, values },
    ),
  massDelete: (module: string, ids: string[]) =>
    post<{ deleted: number }>(`/api/records/${module}/mass-delete`, { ids }),
  transfer: (module: string, ids: string[], ownerId: string) =>
    post<{ transferred: number }>(`/api/records/${module}/transfer`, { ids, ownerId }),
  transferAll: (module: string, query: Record<string, unknown>, ownerId: string) =>
    post<{ transferred: number; matched: number }>(`/api/records/${module}/transfer-all`, { query, ownerId }),
  merge: (module: string, primaryId: string, duplicateIds: string[], fieldChoices: Record<string, string> = {}) =>
    post(`/api/merge/${module}`, { primaryId, duplicateIds, fieldChoices }),
  star: (module: string, id: string, starred: boolean) => post(`/api/records/${module}/${id}/star`, { starred }),
  setTags: (module: string, id: string, tags: string[]) => post(`/api/records/${module}/${id}/tags`, { tags }),
  exportUrl: (module: string, query: ListQuery) =>
    `/api/records/${module}/export${qs({ ...query, filter: query.filter, access_token: tokenStore.get() })}`,
  exportRecords: (module: string, data: Record<string, unknown>) =>
    request<Response>(`/api/records/${module}/export`, { method: 'POST', body: data, raw: true }),

  // --- views --------------------------------------------------------------
  views: (module: string, withCounts = false, includeInactive = false) =>
    get<(CustomView & { count?: number; isActive?: boolean; isSystem?: boolean })[]>(
      `/api/views/${module}${qs({ withCounts, includeInactive })}`),
  reorderViews: (module: string, ids: string[]) => post(`/api/views/${module}/reorder`, { ids }),
  duplicateView: (module: string, id: string) => post<{ id: string }>(`/api/views/${module}/${id}/duplicate`, {}),
  createView: (module: string, data: Record<string, unknown>) => post<{ id: string }>(`/api/views/${module}`, data),
  updateView: (module: string, id: string, data: Record<string, unknown>) => put(`/api/views/${module}/${id}`, data),
  deleteView: (module: string, id: string) => del(`/api/views/${module}/${id}`),

  // --- dashboards --------------------------------------------------------
  dashboards: () => get<(Dashboard & { canEdit: boolean })[]>('/api/dashboards'),
  dashboard: (id: string) => get<Dashboard & { canEdit: boolean }>(`/api/dashboards/${id}`),
  widgetData: (widgetId: string) => get<Record<string, unknown>>(`/api/dashboards/widgets/${widgetId}/data`),
  previewWidget: (type: string, config: Record<string, unknown>) =>
    post<Record<string, unknown>>('/api/dashboards/preview', { type, config }),
  createDashboard: (data: Record<string, unknown>) => post<{ id: string }>('/api/dashboards', data),
  updateDashboard: (id: string, data: Record<string, unknown>) => patch(`/api/dashboards/${id}`, data),
  deleteDashboard: (id: string) => del(`/api/dashboards/${id}`),
  duplicateDashboard: (id: string) => post<{ id: string }>(`/api/dashboards/${id}/duplicate`, {}),
  addWidget: (dashboardId: string, data: Record<string, unknown>) =>
    post<{ id: string }>(`/api/dashboards/${dashboardId}/widgets`, data),
  updateWidget: (dashboardId: string, widgetId: string, data: Record<string, unknown>) =>
    patch(`/api/dashboards/${dashboardId}/widgets/${widgetId}`, data),
  deleteWidget: (dashboardId: string, widgetId: string) => del(`/api/dashboards/${dashboardId}/widgets/${widgetId}`),
  saveDashboardLayout: (dashboardId: string, widgets: { id: string; x: number; y: number; w: number; h: number }[]) =>
    post(`/api/dashboards/${dashboardId}/layout`, { widgets }),

  // --- admin --------------------------------------------------------------
  users: (includeInactive = false, adminOnly = false) =>
    get<Record<string, unknown>[]>(`/api/admin/users${qs({ includeInactive, adminOnly })}`),
  createUser: (data: Record<string, unknown>) => post('/api/admin/users', data),
  updateUser: (id: string, data: Record<string, unknown>) => patch(`/api/admin/users/${id}`, data),
  roles: () => get<{ tree: Record<string, unknown>[]; flat: Record<string, unknown>[] }>('/api/admin/roles'),
  createRole: (data: Record<string, unknown>) => post('/api/admin/roles', data),
  profiles: () => get<Record<string, unknown>[]>('/api/admin/profiles'),
  profile: (id: string) => get<Record<string, unknown>>(`/api/admin/profiles/${id}`),
  saveProfilePermissions: (id: string, data: Record<string, unknown>) => put(`/api/admin/profiles/${id}/permissions`, data),
  groups: () => get<Record<string, unknown>[]>('/api/admin/groups'),
  sharing: () => get<{ defaults: Record<string, unknown>[]; rules: Record<string, unknown>[] }>('/api/admin/sharing'),
  saveSharingDefaults: (defaults: Record<string, string>) => put('/api/admin/sharing/defaults', { defaults }),
  propertyShareConfig: () => get<PropertyShareAdminConfig>('/api/admin/sharing/property-link'),
  savePropertyShareConfig: (data: { visibleFields: string[]; showPhotos: boolean }) =>
    put<PropertyShareAdminConfig>('/api/admin/sharing/property-link', data),
  settings: (category?: string) => get<Record<string, unknown>[]>(`/api/admin/settings${qs({ category })}`),
  saveSettings: (settings: Record<string, unknown>) => put('/api/admin/settings', { settings }),
  matchingConfig: () => get<MatchingAdminConfig>('/api/admin/matching-config'),
  saveMatchingConfig: (fieldMap: MatchingFieldPair[], priceGracePercent: number) => put('/api/admin/matching-config', { fieldMap, priceGracePercent }),
  auditLog: (params: Record<string, unknown> = {}) => get<Record<string, unknown>[]>(`/api/admin/audit${qs(params)}`),
  systemHealth: () => get<Record<string, unknown>>('/api/admin/health'),
  integrations: () => get<IntegrationSummary[]>('/api/admin/integrations'),
  integration: (provider: string) => get<IntegrationSummary>(`/api/admin/integrations/${provider}`),
  integrationModels: (provider: string) =>
    get<IntegrationModelCatalogue>(`/api/admin/integrations/${provider}/models`),
  saveIntegration: (provider: string, data: { config?: Record<string, string>; credentials?: Record<string, string>; isActive?: boolean }) =>
    put<IntegrationSummary>(`/api/admin/integrations/${provider}`, data),
  testIntegration: (provider: string) => post<{ ok: boolean; message: string }>(`/api/admin/integrations/${provider}/test`, {}),
  syncImapInbound: (max?: number) => post<{ checked: number; imported: number; matched: number; skipped: number; errors: string[] }>(
    `/api/admin/integrations/imap/sync${max ? `?max=${max}` : ''}`, {}),

  // --- workflows ----------------------------------------------------------
  workflows: () => get<{ workflows: Record<string, unknown>[]; taskTypes: string[] }>('/api/workflows'),
  workflow: (id: string) => get<Record<string, unknown>>(`/api/workflows/${id}`),
  createWorkflow: (data: Record<string, unknown>) => post<{ id: string }>('/api/workflows', data),
  updateWorkflow: (id: string, data: Record<string, unknown>) => put(`/api/workflows/${id}`, data),
  deleteWorkflow: (id: string) => del(`/api/workflows/${id}`),
  testWorkflow: (id: string, recordId: string) =>
    post<{ matched: boolean; workflow: string }>(`/api/workflows/${id}/test`, { recordId }),
  taskQueue: () => get<Record<string, unknown>[]>('/api/queue'),
  runScheduler: () => post('/api/scheduler/run'),
  assignmentRules: () => get<Record<string, unknown>[]>('/api/assignment-rules'),

  // --- comms --------------------------------------------------------------
  conversations: (params: Record<string, unknown> = {}) =>
    get<Record<string, unknown>[]>(`/api/comms/conversations${qs(params)}`),
  conversation: (id: string) => get<Record<string, unknown>>(`/api/comms/conversations/${id}`),
  sendMessage: (conversationId: string, data: Record<string, unknown>) =>
    post(`/api/comms/conversations/${conversationId}/messages`, data),
  startConversation: (data: Record<string, unknown>) => post('/api/comms/messages', data),
  updateConversation: (id: string, data: Record<string, unknown>) => patch(`/api/comms/conversations/${id}`, data),
  replySuggestions: (id: string) => get<{ suggestions: string[] }>(`/api/comms/conversations/${id}/suggestions`),
  whatsappTemplates: () => get<Record<string, unknown>[]>('/api/comms/templates'),
  emailTemplates: () => get<Record<string, unknown>[]>('/api/comms/email/templates'),
  broadcast: (data: Record<string, unknown>) => post<{ queued: number }>('/api/comms/broadcast', data),

  // --- outreach: the per-record WhatsApp hand-off ---------------------------
  /** Whether WhatsApp can send by itself, or needs a human to tap send. */
  outreachChannel: () => get<{ apiReady: boolean; mode: 'api' | 'device'; message: string }>('/api/outreach/channel'),
  deviceQueue: () => get<DeviceSend[]>('/api/outreach/device-queue'),

  // --- WhatsApp linked to a rep's own phone -------------------------------
  deviceLink: (data: { handle: string; body: string; recordId?: string | null; module?: string; render?: boolean }) =>
    post<{ link: string; body: string }>('/api/outreach/device-link', data),
  queueDeviceSend: (data: Record<string, unknown>) =>
    post<{ id: string; skipped?: string }>('/api/outreach/device-queue', data),
  editDeviceSend: (id: string, body: string) =>
    patch<DeviceSend>(`/api/outreach/device-queue/${id}`, { body }),
  deviceSendOpened: (id: string) => post(`/api/outreach/device-queue/${id}/opened`),
  deviceSendDone: (id: string) => post<{ messageId: string | null }>(`/api/outreach/device-queue/${id}/sent`),
  deviceSendSkip: (id: string, reason?: string) => post(`/api/outreach/device-queue/${id}/skip`, { reason }),
  logDeviceSent: (data: { handle: string; body: string; recordId?: string | null; module?: string }) =>
    post<{ messageId: string | null }>('/api/outreach/device-sent', data),

  createWhatsappTemplate: (data: Record<string, unknown>) => post<{ id: string }>('/api/comms/templates', data),
  deleteWhatsappTemplate: (id: string) => del(`/api/comms/templates/${id}`),
  syncWhatsappTemplates: () => post<{ synced: number }>('/api/comms/templates/sync', {}),

  // --- telephony ----------------------------------------------------------
  telephonyStatus: () => get<{ configured: boolean }>('/api/telephony/status'),
  setDisposition: (id: string, data: { disposition: string; notes?: string; followUpAt?: string | null }) =>
    post(`/api/telephony/calls/${id}/disposition`, data),
  recordingUrl: (callId: string) => authedFileUrl(`/api/telephony/calls/${callId}/recording`),
  devices: () => get<Record<string, unknown>[]>('/api/telephony/devices'),
  pairDevice: (data: { label?: string; phoneNumber?: string | null; model?: string | null }) =>
    post<{ deviceId: string; token: string; note: string }>('/api/telephony/devices', data),
  revokeDevice: (id: string) => del(`/api/telephony/devices/${id}`),
  call: (to: string, recordId?: string, module?: string) =>
    post<{ callId: string }>('/api/telephony/call', { to, recordId, module }),
  logCall: (data: Record<string, unknown>) => post('/api/telephony/log', data),
  calls: (params: Record<string, unknown> = {}) => get<Record<string, unknown>[]>(`/api/telephony/calls${qs(params)}`),
  callDetail: (id: string) => get<Record<string, unknown>>(`/api/telephony/calls/${id}`),
  updateCall: (id: string, data: Record<string, unknown>) => patch(`/api/telephony/calls/${id}`, data),

  // --- AI -----------------------------------------------------------------
  aiStatus: () => get<{ available: boolean; message: string }>('/api/ai/status'),
  scoreLead: (id: string) => post<Record<string, unknown>>(`/api/ai/score-lead/${id}`),
  analyseDeal: (id: string) => post<Record<string, unknown>>(`/api/ai/analyse-deal/${id}`),
  matchProperties: (module: string, id: string, narrative = false) =>
    get<{ matches: PropertyMatch[]; requirement: Record<string, unknown> }>(`/api/ai/match/${module}/${id}${qs({ narrative, limit: 10 })}`),
  buyersForProperty: (propertyId: string, narrative = false) =>
    get<{ buyers: BuyerMatch[] }>(`/api/ai/buyers-for/${propertyId}${qs({ narrative, limit: 10 })}`),
  draft: (data: Record<string, unknown>) => post<{ subject?: string; body: string }>('/api/ai/draft', data),
  summarise: (module: string, id: string) => post<{ summary: string }>(`/api/ai/summarise/${module}/${id}`),
  insights: (recordId: string) => get<Record<string, unknown>[]>(`/api/ai/insights/${recordId}`),
  dismissInsight: (id: string) => post(`/api/ai/insights/${id}/dismiss`),
  askAi: (question: string, context?: { contextRecordId?: string; contextModule?: string; threadId?: string }) =>
    post<AiAskResponse>('/api/ai/ask', { question, ...context }),
  aiThreads: () => get<AiThreadSummary[]>('/api/ai/threads'),
  aiThread: (id: string) => get<AiThreadDetail>(`/api/ai/threads/${id}`),
  createAiThread: (context?: { title?: string; contextRecordId?: string; contextModule?: string }) =>
    post<{ id: string; title: string }>('/api/ai/threads', context ?? {}),
  renameAiThread: (id: string, title: string) => patch<{ id: string; title: string }>(`/api/ai/threads/${id}`, { title }),
  deleteAiThread: (id: string) => del<{ ok: boolean }>(`/api/ai/threads/${id}`),
  confirmAiAction: (id: string) => post<{ action: AiAssistantAction; answer: string; threadId: string | null }>(`/api/ai/actions/${id}/confirm`, {}),
  /** Whether this deployment is configured for a real team — see core/readiness.ts. */
  readiness: () => get<{
    readyCount: number;
    total: number;
    checks: { id: string; title: string; status: 'ok' | 'warn' | 'fail' | 'unknown'; detail: string; fix?: string }[];
  }>('/api/admin/readiness'),
  /** What your own comparable units were listed at — for the shape being typed. */
  comparables: (input: { locality: string; bedrooms: number; carpetArea?: number; excludeRecordId?: string }) =>
    get<{ comparables: { summary: string; count: number; medianPrice: number } | null }>(
      `/api/ai/comparables${qs(input)}`,
    ),
  /** Changes proposed but not yet confirmed for one record — e.g. after a call. */
  pendingAiActions: (recordId: string) =>
    get<{ actions: AiAssistantAction[] }>(`/api/ai/actions?recordId=${encodeURIComponent(recordId)}`),
  cancelAiAction: (id: string) => del<{ action: AiAssistantAction; answer: string }>(`/api/ai/actions/${id}`),
  aiMemories: () => get<AiMemory[]>('/api/ai/memory'),
  deleteAiMemory: (id: string) => del<{ ok: boolean }>(`/api/ai/memory/${id}`),
  /** Records that look like the same person under a different spelling. */
  duplicateSuggestions: (module: string, id: string) =>
    get<{ duplicates: { recordId: string; label: string; confidence: number; why: string }[] }>(
      `/api/ai/records/${module}/${id}/duplicates`,
    ),
  dismissDuplicate: (module: string, id: string, otherId: string) =>
    post(`/api/ai/records/${module}/${id}/duplicates/dismiss`, { otherId }),
  /**
   * Thirty seconds of Hinglish becomes a note. Comes back for somebody to read
   * and post; nothing is saved by this call.
   */
  voiceNote: (audio: Blob) => {
    const form = new FormData();
    form.append('audio', audio, 'note.webm');
    return request<{ transcript: string; note: string; tidied: boolean }>(
      '/api/ai/voice-note', { method: 'POST', body: form },
    );
  },
  transcribeAiAudio: (audio: Blob) => {
    const form = new FormData();
    const extension = audio.type.includes('ogg') ? 'ogg' : audio.type.includes('mp4') ? 'm4a' : 'webm';
    form.append('audio', audio, `ask-ipropy.${extension}`);
    return request<{ transcript: string }>('/api/ai/transcribe', { method: 'POST', body: form });
  },
  digest: () => get<{ greeting: string; summary: string; priorities: Record<string, unknown>[]; stats: Record<string, number> }>('/api/ai/digest'),
  dashboardInsight: (scope: string, prompt?: string) => post<{ insight: string }>('/api/ai/insight', { scope, prompt }),
  analyseCall: (id: string, transcript?: string) => post<Record<string, unknown>>(`/api/ai/calls/${id}/analyse`, { transcript }),
  transcribeCall: (id: string) => post<{ transcript: string }>(`/api/ai/calls/${id}/transcribe`, {}),
  aiUsage: () => get<{
    byFeature: Record<string, unknown>[];
    daily: Record<string, unknown>[];
    /** The month's spend, in paise, so it stays an integer over the wire. */
    totalPaise: number;
  }>('/api/ai/usage'),

  // --- misc ---------------------------------------------------------------
  search: (q: string) => get<SearchHit[]>(`/api/search${qs({ q })}`),
  recent: () => get<{ id: string; label: string; module_name: string }[]>('/api/recent'),
  // --- branding & the company's own social accounts ------------------------
  /** Public: the sign-in screen renders before there is a session. */
  publicBrand: () => get<{
    orgName: string; tagline: string | null;
    socialLinks: { platform: string; label: string; url: string }[];
  }>('/api/public/brand'),
  brand: () => get<{
    orgName: string; logoUrl: string | null; phone: string | null; email: string | null;
    tagline: string | null; primaryColor: string | null;
    socialLinks: { platform: string; label: string; url: string }[];
  }>('/api/brand'),

  // --- browser push --------------------------------------------------------
  pushKey: () => get<{ publicKey: string }>('/api/push/key'),
  pushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    post('/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => post('/api/push/unsubscribe', { endpoint }),
  pushTest: () => post<{ ok: boolean; message: string }>('/api/push/test', {}),
  pushDevices: () => get<Record<string, unknown>[]>('/api/push/devices'),

  // --- "new since you last looked" ----------------------------------------
  unseen: (module: string, ids: string[]) =>
    post<{ unseen: string[] }>(`/api/records/${module}/unseen`, { ids }),
  markModuleSeen: (module: string) => post(`/api/records/${module}/seen`, {}),
  unseenCounts: () => get<Record<string, number>>('/api/unseen-counts'),

  notifications: (unread = false) =>
    get<{ notifications: Record<string, unknown>[]; unreadCount: number }>(`/api/notifications${qs({ unread })}`),
  markNotificationsRead: (ids?: string[]) => post('/api/notifications/read', { ids }),
  files: (recordId: string) => get<Record<string, unknown>[]>(`/api/records/${recordId}/files`),
  /** Full list in the wanted order — the server assigns positions from it. */
  reorderFiles: (recordId: string, ids: string[]) =>
    put<{ ok: true; ordered: number }>(`/api/records/${recordId}/files/order`, { ids }),
  uploadFile: (file: File, recordId?: string, module?: string, shootSessionId?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (recordId) form.append('recordId', recordId);
    if (module) form.append('module', module);
    if (shootSessionId) form.append('shootSessionId', shootSessionId);
    return request<{ id: string; fileName: string; url: string }>('/api/files', { method: 'POST', body: form });
  },
  updateFile: (id: string, data: { fileName?: string; category?: string | null }) =>
    patch<{ id: string; file_name: string; category: string | null }>(`/api/files/${id}`, data),
  deleteFile: (id: string) => del(`/api/files/${id}`),
  /**
   * Everything attached to a record, as a zip of ordinary folders.
   *
   * A URL rather than a fetch: the response streams and can be gigabytes, so
   * the browser's own downloader should handle it instead of buffering the lot
   * into memory as a Blob. It navigates rather than XHRs, hence `access_token`
   * — same reason embeds use it.
   */
  archiveUrl: (recordId: string, set: 'all' | 'originals' | 'branded' | 'web' = 'branded') =>
    authedFileUrl(`/api/records/${recordId}/archive`, { set }),
  shareLinks: (module: string, id: string) =>
    get<ShareLink[]>(`/api/records/${module}/${id}/share-links`),
  createShareLink: (module: string, id: string, body: { label?: string; expiresInDays?: number }) =>
    post<ShareLink>(`/api/records/${module}/${id}/share-links`, body),
  revokeShareLink: (module: string, id: string, linkId: string) =>
    del<void>(`/api/records/${module}/${id}/share-links/${linkId}`),
  /** The public read. Deliberately not authenticated — a buyer has no account. */
  sharedProperty: (token: string) => get<SharedProperty>(`/api/public/share/${token}`),
  tags: () => get<{ id: string; name: string; color: string; usage_count: number }[]>('/api/tags'),
  importPreview: (module: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ headers: string[]; sample: Record<string, string>[]; totalRows: number; suggestedMapping: Record<string, string>; fields: Record<string, unknown>[] }>(
      `/api/import/${module}/preview`, { method: 'POST', body: form },
    );
  },
  runImport: (module: string, file: File, mapping: Record<string, string>, duplicateHandling: string, runWorkflows = false) => {
    const form = new FormData();
    form.append('file', file);
    form.append('mapping', JSON.stringify(mapping));
    form.append('duplicateHandling', duplicateHandling);
    form.append('runWorkflows', String(runWorkflows));
    return request<{ jobId: string; totalRows: number }>(`/api/import/${module}`, { method: 'POST', body: form });
  },
  importJobs: () => get<Record<string, unknown>[]>('/api/import/jobs'),
  cancelImport: (jobId: string) => post<{ ok: boolean }>(`/api/import/jobs/${jobId}/cancel`),
  /** The collisions this import parked, each beside the record it hit. */
  importDuplicates: (jobId: string) =>
    get<{ module: string; pairs: ImportDuplicatePair[] }>(`/api/import/jobs/${jobId}/duplicates`),
  resolveImportDuplicate: (
    jobId: string,
    rowId: string,
    action: ImportResolution,
    fieldChoices: Record<string, 'incoming' | 'existing'> = {},
  ) => post<{ recordId: string | null }>(
    `/api/import/jobs/${jobId}/duplicates/${rowId}`, { action, fieldChoices },
  ),
  resolveAllImportDuplicates: (jobId: string, action: ImportResolution) =>
    post<{ resolved: number }>(`/api/import/jobs/${jobId}/duplicates`, { action }),
  /** A section of a finished import as a downloadable sheet. */
  importResultUrl: (jobId: string, section: ImportSection, name: string) =>
    authedFileUrl(`/api/import/jobs/${jobId}/result.csv`, { section, name }),
  neighbours: (module: string, id: string, params: { view?: string; sort?: string; dir?: string } = {}) =>
    get<{ prevId: string | null; nextId: string | null }>(
      `/api/records/${module}/${id}/neighbours${qs(params as Record<string, string>)}`,
    ),
  webforms: () => get<Record<string, unknown>[]>('/api/webforms'),
  /** Public, no sign-in: what a visitor's form page renders from. */
  publicForm: (publicKey: string) =>
    get<{ id: string; name: string; fields: { name: string; label: string; type?: string; required?: boolean }[]; success_message: string | null; captcha_enabled: boolean }>(`/api/webhooks/forms/${publicKey}`),
  submitPublicForm: (publicKey: string, payload: Record<string, unknown>) =>
    post<{ ok: boolean; message: string; redirectUrl: string | null }>(`/api/webhooks/forms/${publicKey}`, payload),
  createWebform: (data: Record<string, unknown>) => post<{ id: string; publicKey: string; endpoint: string }>('/api/webforms', data),
  leadInbox: (status?: string) => get<Record<string, unknown>[]>(`/api/lead-inbox${qs({ status })}`),

};
