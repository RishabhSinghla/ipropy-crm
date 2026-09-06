import type { FilterGroup, FieldMeta, ModuleMeta } from './uitypes.js';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RecordEnvelope {
  id: string;
  module: string;
  recordNumber: string | null;
  label: string;
  ownerId: string | null;
  ownerType: 'user' | 'group';
  ownerName?: string;
  createdBy: string | null;
  createdByName?: string;
  modifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
  isDeleted: boolean;
  starred?: boolean;
  tags?: string[];
  /** flat field-name → value map, values already cast to JS types */
  values: Record<string, unknown>;
  /** display values for reference/picklist fields, keyed by field name */
  display?: Record<string, string>;
  /** permissions the current user has on this record */
  can?: RecordPermissions;
}

export interface RecordPermissions {
  view: boolean;
  edit: boolean;
  delete: boolean;
  share: boolean;
}

export interface ListQuery {
  view?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  search?: string;
  filter?: FilterGroup;
  columns?: string[];
  /** kanban grouping */
  groupBy?: string;
  includeDeleted?: boolean;
}

export interface ListResult<T = RecordEnvelope> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  columns?: string[];
  /** when groupBy is used */
  groups?: { key: string; label: string; color?: string | null; count: number; sum?: number }[];
}

// ---------------------------------------------------------------------------
// Custom views (list view definitions)
// ---------------------------------------------------------------------------

export interface CustomView {
  id: string;
  module: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isPublic: boolean;
  isSystem: boolean;
  ownerId: string | null;
  columns: string[];
  filter: FilterGroup;
  sortBy: string | null;
  sortDir: 'asc' | 'desc';
  /** kanban / calendar / table / map / timeline */
  displayMode: ViewDisplayMode;
  groupBy: string | null;
  /** show record count badge in the view switcher */
  showMetrics: boolean;
  sequence: number;
}

export type ViewDisplayMode = 'table' | 'kanban' | 'calendar' | 'map' | 'timeline' | 'gallery' | 'split';

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

export type LayoutType = 'detail' | 'edit' | 'quick_create' | 'summary' | 'convert';

export interface LayoutDefinition {
  id: string;
  module: string;
  name: string;
  type: LayoutType;
  isDefault: boolean;
  /** profiles this layout applies to; empty = all */
  profileIds: string[];
  config: LayoutConfig;
}

export interface LayoutConfig {
  /** ordered blocks; each block lists field names in order */
  blocks: LayoutBlock[];
  /** optional right-hand sidebar widgets on detail view */
  sidebar?: LayoutWidgetRef[];
  /** header summary fields shown as key-value chips */
  headerFields?: string[];
  /**
   * Show the auto-number (LD-00003) beside the record name.
   *
   * Off unless an admin turns it on: the number is an internal key, and a
   * salesperson opening a lead wants the person's name, not the row's id.
   */
  showRecordNumber?: boolean;
  /** related lists shown, in order */
  relatedLists?: string[];
  /** which tabs appear on the detail view */
  tabs?: { key: string; label: string; icon?: string }[];
  /** which tab opens first */
  defaultTab?: string;
}

export interface LayoutBlock {
  key: string;
  label: string;
  columns: 1 | 2 | 3;
  collapsed?: boolean;
  fields: string[];
  /** conditional block visibility */
  visibleWhen?: FilterGroup;
}

export interface LayoutWidgetRef {
  type: string;
  title?: string;
  config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export type WidgetType =
  | 'metric'
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'funnel'
  | 'table'
  | 'list'
  | 'gauge'
  | 'heatmap'
  | 'leaderboard'
  | 'activity_feed'
  | 'ai_insights'
  | 'tasks'
  | 'calendar'
  | 'inventory_status'
  | 'pipeline_forecast'
  | 'iframe'
  | 'markdown';

export interface DashboardWidget {
  id: string;
  dashboardId: string;
  type: WidgetType;
  title: string;
  /** grid position */
  x: number;
  y: number;
  w: number;
  h: number;
  config: WidgetConfig;
  sequence: number;
}

export interface WidgetConfig {
  module?: string;
  /** aggregation */
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  aggregateField?: string;
  groupBy?: string;
  /** date field used for time series */
  dateField?: string;
  interval?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  filter?: FilterGroup;
  /** view to pull from instead of a raw filter */
  view?: string;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  columns?: string[];
  /** metric widget extras */
  comparePrevious?: boolean;
  target?: number;
  format?: 'number' | 'currency' | 'percent' | 'area';
  color?: string;
  colorScheme?: string[];
  /** funnel: ordered stage values */
  stages?: string[];
  /** ai_insights: what to analyse */
  aiPrompt?: string;
  aiScope?: string;
  /** markdown widget */
  content?: string;
  /** iframe */
  url?: string;
  /** drill-down target */
  drilldown?: boolean;
  [key: string]: unknown;
}

export interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  isShared: boolean;
  isDefault: boolean;
  /** null = global dashboard, otherwise module-scoped */
  module: string | null;
  sequence: number;
  widgets: DashboardWidget[];
}

// ---------------------------------------------------------------------------
// Users, roles, permissions
// ---------------------------------------------------------------------------

/** How lists behave. Org-wide, set in Admin → Settings, sent with the user. */
export interface UiSettings {
  /** Click a value in a list and type into it. Off by default: too easy to trigger by accident. */
  inlineEdit: boolean;
  /** Open a record from a list in a new browser tab, keeping the list and its filters. */
  openInNewTab: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  avatarUrl: string | null;
  phone: string | null;
  isAdmin: boolean;
  /**
   * What this person may do, from `GET /api/auth/me`.
   *
   * Optional because a browser holding a user cached before this shipped has
   * none, and the screens treat an absent list as "nothing extra" rather than
   * as "everything" — the safe direction if the two ever disagree.
   */
  capabilities?: string[];
  isActive: boolean;
  roleId: string | null;
  roleName: string | null;
  profileId: string | null;
  profileName: string | null;
  groupIds: string[];
  /** users below this one in the role hierarchy — used for data scoping */
  subordinateIds?: string[];
  timezone: string;
  locale: string;
  currency: string;
  theme: 'light' | 'dark' | 'system';
  defaultDashboardId: string | null;
  lastLoginAt: string | null;
  /** Sent by GET /api/auth/me. Absent on a cached user from before this shipped. */
  ui?: UiSettings;
}

export interface Role {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  description: string | null;
  /** report-to chain, computed */
  path?: string[];
  children?: Role[];
}

export interface Profile {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  modulePermissions: Record<string, ModulePermission>;
  fieldPermissions: Record<string, FieldPermission>;
  /** named global capabilities, e.g. "admin.settings", "export.records" */
  capabilities: string[];
}

export interface ModulePermission {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  export: boolean;
  import: boolean;
}

/**
 * What a profile may do with one field.
 *
 * `owner_only` is the record-aware one: the field reads normally for the user
 * who owns the record and is masked for everybody else, which is how a mobile
 * number stops being a list anybody can copy without stopping the person
 * working the lead from ringing it. It is a *visibility* rule — writing is
 * governed by whether you can edit the record at all.
 */
export type FieldPermission = 'hidden' | 'readonly' | 'owner_only' | 'editable';

export interface Group {
  id: string;
  name: string;
  description: string | null;
  memberUserIds: string[];
  memberRoleIds: string[];
  memberGroupIds: string[];
}

export type SharingAccess = 'private' | 'public_read' | 'public_read_write' | 'public_read_write_delete';

export interface SharingRule {
  id: string;
  module: string;
  fromType: 'role' | 'role_and_subordinates' | 'group' | 'user';
  fromId: string;
  toType: 'role' | 'role_and_subordinates' | 'group' | 'user';
  toId: string;
  access: 'read' | 'read_write';
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export type WorkflowTrigger =
  | 'on_create'
  | 'on_modify'
  | 'on_create_or_modify'
  | 'on_delete'
  | 'on_field_change'
  | 'scheduled'
  | 'manual'
  | 'on_inbound_message'
  | 'on_call_end'
  | 'on_form_submit';

export type WorkflowTaskType =
  | 'update_fields'
  | 'create_record'
  | 'send_email'
  | 'send_whatsapp'
  | 'send_sms'
  | 'create_task'
  | 'create_event'
  | 'assign_owner'
  | 'notify_user'
  | 'webhook'
  | 'ai_action'
  | 'add_tag'
  | 'trigger_call'
  | 'delay';

export interface Workflow {
  id: string;
  module: string;
  name: string;
  description: string | null;
  trigger: WorkflowTrigger;
  /** for on_field_change */
  watchFields: string[];
  conditions: FilterGroup;
  /** 'once' = only the first time conditions become true */
  executionMode: 'always' | 'once' | 'once_until_false';
  schedule: WorkflowSchedule | null;
  isActive: boolean;
  sequence: number;
  tasks: WorkflowTask[];
  createdAt: string;
  lastRunAt: string | null;
  runCount: number;
}

export interface WorkflowSchedule {
  frequency: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';
  time?: string; // HH:mm
  daysOfWeek?: number[];
  dayOfMonth?: number;
  cron?: string;
}

export interface WorkflowTask {
  id: string;
  workflowId: string;
  type: WorkflowTaskType;
  name: string;
  sequence: number;
  isActive: boolean;
  /** minutes to wait before running (0 = immediate) */
  delayMinutes: number;
  /** relative-to-field scheduling, e.g. 2 days before {possession_date} */
  delayField?: string | null;
  delayDirection?: 'before' | 'after';
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Communications
// ---------------------------------------------------------------------------

export type Channel = 'whatsapp' | 'sms' | 'email' | 'call' | 'note' | 'webchat';

export interface Conversation {
  id: string;
  channel: Channel;
  /** E.164 for whatsapp/sms, address for email */
  handle: string;
  contactName: string | null;
  /** linked CRM record */
  recordId: string | null;
  recordModule: string | null;
  assignedTo: string | null;
  status: 'open' | 'pending' | 'resolved' | 'snoozed';
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** WhatsApp 24h customer service window */
  windowExpiresAt: string | null;
  aiAutoReply: boolean;
  /** AI-maintained rolling summary of the thread */
  aiSummary: string | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  channel: Channel;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'template' | 'interactive' | 'system';
  body: string | null;
  media: MessageMedia | null;
  templateName: string | null;
  templateParams: Record<string, string> | null;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  errorMessage: string | null;
  providerMessageId: string | null;
  sentBy: string | null;
  isAiGenerated: boolean;
  createdAt: string;
}

export interface MessageMedia {
  url: string;
  mimeType: string;
  fileName?: string;
  caption?: string;
  size?: number;
  /** AI transcription of a voice note */
  transcript?: string;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'LOCAL';
  bodyText: string;
  headerText: string | null;
  headerFormat: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'VIDEO' | null;
  footerText: string | null;
  buttons: WhatsAppButton[];
  /** {{1}} → CRM merge field, e.g. "contact.first_name" */
  variableMap: Record<string, string>;
}

export interface WhatsAppButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
  text: string;
  url?: string;
  phoneNumber?: string;
}

// ---------------------------------------------------------------------------
// Telephony
// ---------------------------------------------------------------------------

export interface CallLog {
  id: string;
  direction: 'inbound' | 'outbound' | 'missed';
  fromNumber: string;
  toNumber: string;
  userId: string | null;
  recordId: string | null;
  recordModule: string | null;
  status: 'queued' | 'ringing' | 'in_progress' | 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled';
  durationSeconds: number;
  recordingUrl: string | null;
  provider: string;
  providerCallId: string | null;
  disposition: string | null;
  notes: string | null;
  /** AI enrichment */
  transcript: string | null;
  aiSummary: string | null;
  aiSentiment: 'positive' | 'neutral' | 'negative' | null;
  aiNextActions: string[] | null;
  aiTalkRatio: number | null;
  aiObjections: string[] | null;
  startedAt: string;
  endedAt: string | null;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export interface AiInsight {
  id: string;
  recordId: string | null;
  module: string | null;
  kind: AiInsightKind;
  title: string;
  body: string;
  data: Record<string, unknown>;
  score: number | null;
  confidence: number | null;
  model: string;
  createdAt: string;
  dismissedAt: string | null;
}

export type AiInsightKind =
  | 'lead_score'
  | 'next_best_action'
  | 'deal_risk'
  | 'property_match'
  | 'summary'
  | 'sentiment'
  | 'duplicate'
  | 'forecast'
  | 'coaching'
  | 'digest';

export interface PropertyMatch {
  propertyId: string;
  propertyLabel: string;
  score: number;
  reasons: string[];
  mismatches: string[];
  projectName?: string;
  price?: number;
  configuration?: string;
}

export interface LeadScoreResult {
  score: number;
  temperature: 'Hot' | 'Warm' | 'Cold';
  reasons: string[];
  risks: string[];
  recommendedActions: string[];
  suggestedOwnerId?: string | null;
  confidence: number;
  breakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  recordId: string;
  module: string;
  userId: string | null;
  userName: string | null;
  action: 'create' | 'update' | 'delete' | 'restore' | 'convert' | 'share' | 'view' | 'export' | 'merge';
  changes: FieldChange[];
  source: string;
  createdAt: string;
}

export interface FieldChange {
  field: string;
  label: string;
  from: unknown;
  to: unknown;
  fromDisplay?: string;
  toDisplay?: string;
}

export interface Comment {
  id: string;
  recordId: string;
  parentId: string | null;
  userId: string;
  userName: string;
  userAvatar: string | null;
  body: string;
  mentions: string[];
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string | null;
  replies?: Comment[];
}

export interface Attachment {
  id: string;
  recordId: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  storageKey: string;
  uploadedBy: string;
  createdAt: string;
  /** AI-extracted text for search (KYC docs, agreements) */
  extractedText?: string | null;
}

export interface Notification {
  id: string;
  userId: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  recordId: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  type: 'audit' | 'comment' | 'message' | 'call' | 'email' | 'task' | 'event' | 'ai' | 'attachment' | 'site_visit' | 'payment';
  at: string;
  actorId: string | null;
  actorName: string | null;
  title: string;
  body: string | null;
  icon: string;
  meta: Record<string, unknown>;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  code?: string;
}

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type { FieldMeta, ModuleMeta };
