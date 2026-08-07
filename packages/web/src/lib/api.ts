/**
 * Typed API client.
 *
 * A single fetch wrapper handles auth headers, token refresh on 401, and turns
 * server error envelopes into thrown ApiError objects the UI can render.
 */
import type {
  AuthUser, CustomView, Dashboard, ListQuery, ListResult, ModuleMeta,
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

  if (raw) return res as unknown as T;

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

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? JSON.parse(text) as T : (undefined as T);
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

export interface ModuleSummary {
  id: string; name: string; label: string; singularLabel: string;
  icon: string; color: string; sequence: number; isEntity: boolean; isCustom: boolean;
  pipelineField: string | null; menuGroup: string; showInMenu: boolean;
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

export const api = {
  /** Escape hatch for endpoints without a dedicated helper. */
  request,

  // --- auth ---------------------------------------------------------------
  login: (email: string, password: string) =>
    request<{ token: string; refreshToken: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST', body: { email, password }, skipRefresh: true,
    }),
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
  toggleModule: (name: string, isActive: boolean, reason?: string) =>
    post<{ ok: boolean; message: string }>(`/api/meta/modules/${name}/toggle`, { isActive, reason }),
  createModule: (data: Record<string, unknown>) => post('/api/meta/modules', data),
  updateModule: (name: string, data: Record<string, unknown>) => patch(`/api/meta/modules/${name}`, data),
  deleteModule: (name: string, force = false) => del(`/api/meta/modules/${name}${force ? '?force=true' : ''}`),
  createField: (module: string, data: Record<string, unknown>) => post(`/api/meta/modules/${module}/fields`, data),
  updateField: (id: string, data: Record<string, unknown>) => patch(`/api/meta/fields/${id}`, data),
  deleteField: (id: string) => del(`/api/meta/fields/${id}`),
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
  convert: (module: string, id: string, options: Record<string, unknown>) =>
    post<{ contactId: string; dealId: string | null; organizationId: string | null }>(`/api/records/${module}/${id}/convert`, options),
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
  views: (module: string, withCounts = false) => get<(CustomView & { count?: number })[]>(`/api/views/${module}${qs({ withCounts })}`),
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
  saveIntegration: (provider: string, data: { config?: Record<string, string>; credentials?: Record<string, string>; isActive?: boolean }) =>
    put<IntegrationSummary>(`/api/admin/integrations/${provider}`, data),
  testIntegration: (provider: string) => post<{ ok: boolean; message: string }>(`/api/admin/integrations/${provider}/test`, {}),

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

  // --- telephony ----------------------------------------------------------
  telephonyStatus: () => get<{ configured: boolean }>('/api/telephony/status'),
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
  coaching: (userId: string) => get<Record<string, unknown>>(`/api/ai/coaching/${userId}`),
  aiUsage: () => get<{ byFeature: Record<string, unknown>[]; daily: Record<string, unknown>[] }>('/api/ai/usage'),

  // --- misc ---------------------------------------------------------------
  search: (q: string) => get<{ id: string; module: string; moduleLabel: string; label: string }[]>(`/api/search${qs({ q })}`),
  recent: () => get<{ id: string; label: string; module_name: string }[]>('/api/recent'),
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
  tags: () => get<{ id: string; name: string; color: string; usage_count: number }[]>('/api/tags'),
  inventoryBoard: (projectId: string) =>
    get<{ summary: Record<string, unknown>[]; total: number; towers: Record<string, unknown>[] }>(`/api/inventory/${projectId}`),
  blockUnit: (propertyId: string, data: Record<string, unknown>) => post(`/api/inventory/${propertyId}/block`, data),
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
