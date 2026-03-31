// ─── Sync Direction ─────────────────────────────────────────────
export type SyncDirection = 'airtable_to_webflow' | 'webflow_to_airtable';

// ─── Record Action (mirrors Finsweet's CMS-B: Action) ──────────
export type RecordAction = 'publish' | 'draft' | 'archive' | 'delete' | 'stage';

// ─── Connection ─────────────────────────────────────────────────
export interface Connection {
  id: string;
  name: string;
  /** Kept for backward-compat with existing DB rows; ignored at runtime — direction is passed per-sync-request */
  direction?: SyncDirection;
  airtable_base_id: string;
  airtable_table_id: string;
  airtable_view_id?: string;
  webflow_site_id: string;
  webflow_collection_id: string;
  /** Airtable field name that holds the RecordAction */
  action_field?: string;
  /** Airtable field name for per-record error/status messages (CMS-B: Message) */
  message_field?: string;
  /** Airtable field name where sync timestamp is written per record (CMS-B: Sync Time) */
  sync_time_field?: string;
  /** Airtable field name where the Webflow item ID is stored */
  webflow_id_field?: string;
  /** Webflow field slug where the Airtable record ID is stored */
  airtable_id_slug?: string;
  /** Airtable field name for Last Modified Time — enables delta sync (skip unchanged records) */
  last_modified_field?: string;
  /** Enable scheduled sync via cron expression */
  cron_schedule?: string;
  is_active: boolean;
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
}

// ─── Field Mapping ──────────────────────────────────────────────
export interface FieldMapping {
  id: string;
  connection_id: string;
  airtable_field_id: string;
  airtable_field_name: string;
  airtable_field_type: AirtableFieldType;
  webflow_field_id: string;
  webflow_field_slug: string;
  webflow_field_type: WebflowFieldType;
  is_name_field: boolean;
  is_slug_field: boolean;
  transform?: string; // optional JS expression for custom transforms
  /**
   * For Reference / MultiReference fields only.
   * The ID of the CMS Bridge connection that manages the referenced Webflow
   * collection (and its corresponding Airtable table).  Used at sync time to
   * look up cross-collection record IDs from the record_map table.
   */
  linked_connection_id?: string;
}

// ─── Airtable Field Types ───────────────────────────────────────
export type AirtableFieldType =
  | 'singleLineText'
  | 'multilineText'
  | 'richText'
  | 'multipleAttachments'
  | 'singleSelect'
  | 'multipleSelects'
  | 'number'
  | 'currency'
  | 'percent'
  | 'autoNumber'
  | 'formula'
  | 'date'
  | 'dateTime'
  | 'email'
  | 'phone'
  | 'url'
  | 'checkbox'
  | 'duration'
  | 'rollup'
  | 'multipleRecordLinks'
  | 'lookup'
  | 'button'
  | 'barcode'
  | 'createdTime'
  | 'lastModifiedTime'
  | 'externalSyncSource'
  | 'singleCollaborator'
  | 'multipleCollaborators'
  | 'rating'
  | 'count';

// ─── Webflow Field Types ────────────────────────────────────────
export type WebflowFieldType =
  | 'PlainText'
  | 'RichText'
  | 'Image'
  | 'MultiImage'
  | 'Video'
  | 'VideoLink'
  | 'Link'
  | 'Email'
  | 'Phone'
  | 'Number'
  | 'DateTime'
  | 'Switch'
  | 'Color'
  | 'Option'
  | 'File'
  | 'Reference'
  | 'MultiReference'
  | 'User'
  | 'Set'
  | 'ExtFileRef'; // external file reference

// ─── Sync Log ───────────────────────────────────────────────────
export type SyncStatus = 'running' | 'completed' | 'failed' | 'partial';

export interface SyncLog {
  id: string;
  connection_id: string;
  status: SyncStatus;
  direction: SyncDirection;
  records_processed: number;
  records_created: number;
  records_updated: number;
  records_deleted: number;
  records_failed: number;
  errors: SyncError[];
  started_at: string;
  completed_at?: string;
}

export interface SyncError {
  record_id: string;
  field?: string;
  message: string;
  code?: string;
}

// ─── Sync Record Result ─────────────────────────────────────────
export interface SyncRecordResult {
  source_id: string;
  target_id?: string;
  action: 'created' | 'updated' | 'deleted' | 'skipped' | 'failed';
  error?: string;
}

// ─── API Response Types ─────────────────────────────────────────
export interface AirtableBase {
  id: string;
  name: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  fields: AirtableField[];
  views: AirtableView[];
}

export interface AirtableField {
  id: string;
  name: string;
  type: AirtableFieldType;
  options?: Record<string, unknown>;
}

export interface AirtableView {
  id: string;
  name: string;
  type: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime: string;
}

export interface WebflowSite {
  id: string;
  displayName: string;
  shortName: string;
}

export interface WebflowCollection {
  id: string;
  displayName: string;
  slug: string;
  fields: WebflowField[];
}

export interface WebflowField {
  id: string;
  slug: string;
  displayName: string;
  type: WebflowFieldType;
  isRequired: boolean;
  isEditable: boolean;
  /** Present on Reference/MultiReference fields — contains collectionId of the referenced collection */
  validations?: Record<string, unknown>;
}

export interface WebflowItem {
  id: string;
  fieldData: Record<string, unknown>;
  isDraft: boolean;
  isArchived: boolean;
  createdOn: string;
  lastPublished?: string;
  lastUpdated: string;
}

// ─── Field Compatibility Matrix ─────────────────────────────────
export interface FieldCompatibility {
  airtableType: AirtableFieldType;
  webflowTypes: WebflowFieldType[];
  notes?: string;
}
