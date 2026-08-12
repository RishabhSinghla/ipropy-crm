/**
 * Typed API client.
 *
 * A single fetch wrapper handles auth headers, token refresh on 401, and turns
 * server error envelopes into thrown ApiError objects the UI can render.
 */
import type {
  AuthUser, CustomView, Dashboard, FieldMeta, ListQuery, ListResult, ModuleMeta,
  RecordEnvelope, TimelineEntry,
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
  getRefresh: (): string | null => localStorage.getItem(REFRESH_KEY),
  setRefresh: (token: string): void => localStorage.setItem(REFRESH_KEY, token),
  clear: (): void => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

let refreshPromise: Promise<boolean> | null = null;

async function refreshToken(): Promise<boolean> {
  // Collapse concurrent 401s into a single refresh attempt.
  if (refreshPromise) return refreshPromise;

  const refresh = tokenStore.getRefresh();
  if (!refresh) return false;

  refreshPromise = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  })
    .then(async (res) => {
      if (!res.ok) return false;
      const data = await res.json() as { token: string };
      tokenStore.set(data.token);
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
  photos: { id: string; url: string; name: string }[];
  sharedAt: string;
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

export interface Broadcast {
  id: string; name: string; channel_mode: 'api' | 'device';
  template_name: string | null; body_text?: string | null;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
  scheduled_at: string | null; total_count: number; sent_count: number;
  failed_count: number; blocked_count: number;
  created_at: string; started_at: string | null; completed_at: string | null;
  created_by_name?: string | null;
}

export interface BroadcastRecipient {
  id: string; record_id: string | null; handle: string; name: string | null;
  status: string; error: string | null; rendered_text: string | null; sent_at: string | null;
}

export interface Sequence {
  id: string; name: string; description: string | null; is_active: boolean;
  module_name: string; enrol_trigger: string; exit_on_reply: boolean;
  exit_on_status: string[]; quiet_start: number; quiet_end: number;
  enrolled_count: number; step_count?: number; active_count?: number;
  created_at: string;
}

export interface SequenceStep {
  id: string; sequence: number; delay_minutes: number;
  channel: 'whatsapp' | 'email' | 'task' | 'sms';
  template_name: string | null; subject: string | null; body: string | null;
  buttons: { id: string; title: string }[];
  fallback_to_device: boolean; is_active: boolean;
}

export interface AutoReplyRule {
  id: string; name: string; is_active: boolean; sequence: number;
  trigger_type: 'keyword' | 'welcome' | 'fallback'; match_type: 'contains' | 'exact';
  keywords: string[]; reply_text: string;
  buttons: { id: string; title: string }[];
  button_routes: Record<string, string>;
  business_hours_only: boolean; handoff: boolean;
  media_url: string | null; is_routed_only: boolean; match_count: number;
}

export interface SavedDesign {
  id: string; name: string; kind: 'post' | 'reel' | 'brochure';
  template_key: string | null; record_id: string | null; module_name: string | null;
  width: number; height: number; thumbnail: string | null;
  record_label?: string | null; created_by_name?: string | null;
  created_at: string; updated_at: string;
}

export interface RenderJob {
  id: string; kind: 'reel' | 'brochure' | 'image_edit';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'unsupported';
  progress: number; error: string | null; output_mime: string | null;
  record_id: string | null; record_label?: string | null;
  title?: string | null; created_at: string; finished_at: string | null;
}

export const api = {
  /** Escape hatch for endpoints without a dedicated helper. */
  request,

  // --- auth ---------------------------------------------------------------
  /** `identifier` is an email address or a mobile number. */
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
  logout: () => post('/api/auth/logout', { refreshToken: tokenStore.getRefresh() }),
  me: () => get<AuthUser>('/api/auth/me'),
  updateProfile: (data: Record<string, unknown>) => patch<AuthUser>('/api/auth/me', data),
  changePassword: (currentPassword: string, newPassword: string) =>
    post('/api/auth/change-password', { currentPassword, newPassword }),

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
  savePicklistValues: (name: string, values: unknown[]) => put(`/api/meta/picklists/${name}/values`, { values }),
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
  /** `permanent` drops the column and its data; otherwise the field is only hidden. */
  deleteField: (id: string, permanent = false) =>
    del<{ ok: boolean; deactivated?: boolean; deleted?: boolean; hadValues?: number }>(
      `/api/meta/fields/${id}${permanent ? '?permanent=true' : ''}`,
    ),
  reorderFields: (fields: { id: string; blockId: string; sequence: number }[]) =>
    post('/api/meta/fields/reorder', { fields }),
  createBlock: (module: string, data: Record<string, unknown>) => post(`/api/meta/modules/${module}/blocks`, data),
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
  massDelete: (module: string, ids: string[]) =>
    post<{ deleted: number }>(`/api/records/${module}/mass-delete`, { ids }),
  transfer: (module: string, ids: string[], ownerId: string) =>
    post<{ transferred: number }>(`/api/records/${module}/transfer`, { ids, ownerId }),
  merge: (module: string, primaryId: string, duplicateIds: string[], fieldChoices: Record<string, string> = {}) =>
    post(`/api/merge/${module}`, { primaryId, duplicateIds, fieldChoices }),
  star: (module: string, id: string, starred: boolean) => post(`/api/records/${module}/${id}/star`, { starred }),
  setTags: (module: string, id: string, tags: string[]) => post(`/api/records/${module}/${id}/tags`, { tags }),
  exportUrl: (module: string, query: ListQuery) =>
    `/api/records/${module}/export${qs({ ...query, filter: query.filter, access_token: tokenStore.get() })}`,

  // --- views --------------------------------------------------------------
  views: (module: string, withCounts = false, includeInactive = false) =>
    get<(CustomView & { count?: number; isActive?: boolean; isSystem?: boolean })[]>(
      `/api/views/${module}${qs({ withCounts, includeInactive })}`),
  reorderViews: (module: string, ids: string[]) => post(`/api/views/${module}/reorder`, { ids }),
  duplicateView: (module: string, id: string) => post<{ id: string }>(`/api/views/${module}/${id}/duplicate`, {}),
  createView: (module: string, data: Record<string, unknown>) => post<{ id: string }>(`/api/views/${module}`, data),
  updateView: (module: string, id: string, data: Record<string, unknown>) => put(`/api/views/${module}/${id}`, data),
  deleteView: (module: string, id: string) => del(`/api/views/${module}/${id}`),

  // --- dashboards & reports ----------------------------------------------
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
  reports: () => get<Record<string, unknown>[]>('/api/reports'),
  runReport: (spec: Record<string, unknown>) =>
    post<{ rows: Record<string, unknown>[]; columns: string[]; totals?: Record<string, number> }>('/api/reports/run', spec),

  // --- admin --------------------------------------------------------------
  users: (includeInactive = false) => get<Record<string, unknown>[]>(`/api/admin/users${qs({ includeInactive })}`),
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
  settings: (category?: string) => get<Record<string, unknown>[]>(`/api/admin/settings${qs({ category })}`),
  saveSettings: (settings: Record<string, unknown>) => put('/api/admin/settings', { settings }),
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

  // --- outreach: device sends, broadcasts, sequences, auto-replies ---------
  /** Whether WhatsApp can send by itself, or needs a human to tap send. */
  outreachChannel: () => get<{ apiReady: boolean; mode: 'api' | 'device'; message: string }>('/api/outreach/channel'),
  deviceQueue: () => get<DeviceSend[]>('/api/outreach/device-queue'),
  deviceLink: (data: { handle: string; body: string; recordId?: string | null; module?: string; render?: boolean }) =>
    post<{ link: string; body: string }>('/api/outreach/device-link', data),
  queueDeviceSend: (data: Record<string, unknown>) =>
    post<{ id: string; skipped?: string }>('/api/outreach/device-queue', data),
  deviceSendOpened: (id: string) => post(`/api/outreach/device-queue/${id}/opened`),
  deviceSendDone: (id: string) => post<{ messageId: string | null }>(`/api/outreach/device-queue/${id}/sent`),
  deviceSendSkip: (id: string, reason?: string) => post(`/api/outreach/device-queue/${id}/skip`, { reason }),
  logDeviceSent: (data: { handle: string; body: string; recordId?: string | null; module?: string }) =>
    post<{ messageId: string | null }>('/api/outreach/device-sent', data),

  broadcasts: () => get<Broadcast[]>('/api/outreach/broadcasts'),
  broadcast_: (id: string) => get<Broadcast & { recipients: BroadcastRecipient[] }>(`/api/outreach/broadcasts/${id}`),
  createBroadcast: (data: Record<string, unknown>) =>
    post<{ id: string; total: number; skipped: number }>('/api/outreach/broadcasts', data),
  startBroadcast: (id: string) => post(`/api/outreach/broadcasts/${id}/start`),
  pauseBroadcast: (id: string) => post(`/api/outreach/broadcasts/${id}/pause`),
  cancelBroadcast: (id: string) => post(`/api/outreach/broadcasts/${id}/cancel`),

  sequences: () => get<Sequence[]>('/api/outreach/sequences'),
  sequence: (id: string) => get<Sequence & { steps: SequenceStep[]; enrolments: Record<string, unknown>[] }>(`/api/outreach/sequences/${id}`),
  createSequence: (data: Record<string, unknown>) => post<{ id: string }>('/api/outreach/sequences', data),
  updateSequence: (id: string, data: Record<string, unknown>) => patch(`/api/outreach/sequences/${id}`, data),
  deleteSequence: (id: string) => del(`/api/outreach/sequences/${id}`),
  saveSequenceSteps: (id: string, steps: Record<string, unknown>[]) =>
    put(`/api/outreach/sequences/${id}/steps`, { steps }),
  enrolInSequence: (id: string, audience: { recordIds?: string[]; viewId?: string }) =>
    post<{ enrolled: number; skipped: { recordId: string; reason: string }[] }>(`/api/outreach/sequences/${id}/enrol`, audience),
  exitEnrolment: (id: string, reason?: string) => post(`/api/outreach/enrolments/${id}/exit`, { reason }),
  runSequences: () => post<{ ran: number; exited: number }>('/api/outreach/sequences/run'),

  autoReplyRules: () => get<AutoReplyRule[]>('/api/outreach/autoreply'),
  createAutoReplyRule: (data: Record<string, unknown>) => post<{ id: string }>('/api/outreach/autoreply', data),
  updateAutoReplyRule: (id: string, data: Record<string, unknown>) => patch(`/api/outreach/autoreply/${id}`, data),
  deleteAutoReplyRule: (id: string) => del(`/api/outreach/autoreply/${id}`),
  testAutoReply: (text: string, buttonPayload?: string) =>
    post<{ matched: boolean; rule?: { id: string; name: string; replyText: string; buttons: { id: string; title: string }[] } }>(
      '/api/outreach/autoreply/test', { text, buttonPayload }),
  createWhatsappTemplate: (data: Record<string, unknown>) => post<{ id: string }>('/api/comms/templates', data),
  deleteWhatsappTemplate: (id: string) => del(`/api/comms/templates/${id}`),
  syncWhatsappTemplates: () => post<{ synced: number }>('/api/comms/templates/sync', {}),

  // --- studio ---------------------------------------------------------------
  studioCapabilities: () => get<{
    video: boolean; music: boolean; imageEdit: boolean; brochure: boolean;
    presets: { key: string; label: string }[];
  }>('/api/studio/capabilities'),
  designs: (params: Record<string, unknown> = {}) => get<SavedDesign[]>(`/api/studio/designs${qs(params)}`),
  design: (id: string) => get<SavedDesign & { spec: Record<string, unknown> }>(`/api/studio/designs/${id}`),
  saveDesign: (data: Record<string, unknown>) => post<{ id: string }>('/api/studio/designs', data),
  updateDesign: (id: string, data: Record<string, unknown>) => patch(`/api/studio/designs/${id}`, data),
  deleteDesign: (id: string) => del(`/api/studio/designs/${id}`),
  renders: () => get<RenderJob[]>('/api/studio/renders'),
  render: (id: string) => get<RenderJob>(`/api/studio/renders/${id}`),
  renderFile: (id: string) => request<Response>(`/api/studio/renders/${id}/file`, { raw: true }),
  queueReel: (data: Record<string, unknown>) => post<{ id: string }>('/api/studio/renders/reel', data),
  queueBrochure: (data: Record<string, unknown>) => post<{ id: string }>('/api/studio/renders/brochure', data),
  editImage: (file: Blob, preset: string, instruction?: string) => {
    const form = new FormData();
    form.append('image', file, 'photo.jpg');
    form.append('preset', preset);
    if (instruction) form.append('instruction', instruction);
    return request<{ ok: boolean; dataUrl?: string; reason?: string }>('/api/studio/image-edit', {
      method: 'POST', body: form,
    });
  },

  // --- telephony ----------------------------------------------------------
  telephonyStatus: () => get<{ configured: boolean }>('/api/telephony/status'),
  callsNeedingDisposition: () => get<Record<string, unknown>[]>('/api/telephony/needs-disposition'),
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
  callStats: (params: Record<string, unknown> = {}) => get<Record<string, unknown>>(`/api/telephony/stats${qs(params)}`),

  // --- AI -----------------------------------------------------------------
  aiStatus: () => get<{ available: boolean; message: string }>('/api/ai/status'),
  scoreLead: (id: string) => post<Record<string, unknown>>(`/api/ai/score-lead/${id}`),
  analyseDeal: (id: string) => post<Record<string, unknown>>(`/api/ai/analyse-deal/${id}`),
  matchProperties: (module: string, id: string, narrative = false) =>
    get<{ matches: Record<string, unknown>[]; requirement: Record<string, unknown> }>(`/api/ai/match/${module}/${id}${qs({ narrative, limit: 6 })}`),
  buyersForProperty: (propertyId: string) =>
    get<{ buyers: Record<string, unknown>[] }>(`/api/ai/buyers-for/${propertyId}`),
  draft: (data: Record<string, unknown>) => post<{ subject?: string; body: string }>('/api/ai/draft', data),
  summarise: (module: string, id: string) => post<{ summary: string }>(`/api/ai/summarise/${module}/${id}`),
  insights: (recordId: string) => get<Record<string, unknown>[]>(`/api/ai/insights/${recordId}`),
  dismissInsight: (id: string) => post(`/api/ai/insights/${id}/dismiss`),
  askAi: (question: string, context?: { contextRecordId?: string; contextModule?: string }) =>
    post<{ answer: string; query?: Record<string, unknown>; results?: ListResult }>('/api/ai/ask', { question, ...context }),
  digest: () => get<{ greeting: string; summary: string; priorities: Record<string, unknown>[]; stats: Record<string, number> }>('/api/ai/digest'),
  dashboardInsight: (scope: string, prompt?: string) => post<{ insight: string }>('/api/ai/insight', { scope, prompt }),
  analyseCall: (id: string, transcript?: string) => post<Record<string, unknown>>(`/api/ai/calls/${id}/analyse`, { transcript }),
  transcribeCall: (id: string) => post<{ transcript: string }>(`/api/ai/calls/${id}/transcribe`, {}),
  coaching: (userId: string) => get<Record<string, unknown>>(`/api/ai/coaching/${userId}`),
  aiUsage: () => get<{ byFeature: Record<string, unknown>[]; daily: Record<string, unknown>[] }>('/api/ai/usage'),

  // --- misc ---------------------------------------------------------------
  search: (q: string) => get<{ id: string; module: string; moduleLabel: string; label: string }[]>(`/api/search${qs({ q })}`),
  recent: () => get<{ id: string; label: string; module_name: string }[]>('/api/recent'),
  // --- branding & the company's own social accounts ------------------------
  /** Public: the sign-in screen renders before there is a session. */
  publicBrand: () => get<{
    orgName: string; tagline: string | null;
    socialLinks: { platform: string; label: string; url: string }[];
  }>('/api/public/brand'),
  brand: () => get<{
    orgName: string; logoUrl: string | null; phone: string | null; email: string | null;
    tagline: string | null;
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
  uploadFile: (file: File, recordId?: string, module?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (recordId) form.append('recordId', recordId);
    if (module) form.append('module', module);
    return request<{ id: string; fileName: string; url: string }>('/api/files', { method: 'POST', body: form });
  },
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

  // --- site capture --------------------------------------------------------
  /**
   * Start a visit. Callers go through lib/captureQueue rather than calling this
   * directly — the screen must not wait on a network that is often not there.
   */
  startCapture: (body: Record<string, unknown>) =>
    post<{ session: CaptureSession; replayed: boolean }>('/api/capture/sessions', body),
  currentCapture: () => get<{ session: CaptureSession | null }>('/api/capture/sessions/current'),
  captureSessions: (limit = 25) =>
    get<CaptureSessionRow[]>(`/api/capture/sessions${qs({ limit })}`),
  assignCaptureRecord: (id: string, recordId: string) =>
    patch<CaptureSession>(`/api/capture/sessions/${id}`, { recordId }),
  captureSession: (id: string) => get<CaptureSessionDetail>(`/api/capture/sessions/${id}`),
  /** Everything shot that still has no property on it. */
  unnamedShoots: (limit = 50) => get<UnnamedShoot[]>(`/api/capture/shoots/unnamed${qs({ limit })}`),
  /**
   * Name one shoot — either an existing property or the values to create one.
   * Creating is the common case: a floor photographed this morning usually is
   * not in the CRM yet.
   */
  nameShoot: (id: string, body: { recordId: string } | { property: { module: string; values: Record<string, unknown> } }) =>
    post<{ session: CaptureSession; recordId: string; photosAttached: number }>(
      `/api/capture/shoots/${id}/name`, body,
    ),
  /** Write the accepted details onto the property and mark the visit done. */
  reviewCaptureSession: (id: string, values: Record<string, unknown>) =>
    post<{ session: CaptureSession; record: unknown }>(`/api/capture/sessions/${id}/review`, { values }),
  /**
   * The note recorded at the gate. Sent after the visit exists, because it
   * needs the session's id — and separately from it, because the tap must land
   * even when a hundred kilobytes of audio will not.
   */
  uploadCaptureVoice: (sessionId: string, audio: Blob, fileName: string) => {
    const form = new FormData();
    form.append('audio', audio, fileName);
    return request<{ voiceNoteId: string; session: CaptureSession }>(
      `/api/capture/sessions/${sessionId}/voice`, { method: 'POST', body: form },
    );
  },
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
  runImport: (module: string, file: File, mapping: Record<string, string>, duplicateHandling: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('mapping', JSON.stringify(mapping));
    form.append('duplicateHandling', duplicateHandling);
    return request<{ jobId: string; totalRows: number }>(`/api/import/${module}`, { method: 'POST', body: form });
  },
  importJobs: () => get<Record<string, unknown>[]>('/api/import/jobs'),
  webforms: () => get<Record<string, unknown>[]>('/api/webforms'),
  createWebform: (data: Record<string, unknown>) => post<{ id: string; publicKey: string; endpoint: string }>('/api/webforms', data),
  leadInbox: (status?: string) => get<Record<string, unknown>[]>(`/api/lead-inbox${qs({ status })}`),

};
