import Airtable from 'airtable';
import type { FieldSet } from 'airtable';
import type { AirtableBase, AirtableTable, AirtableField, AirtableView, AirtableRecord } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('airtable');
const META_API_BASE = 'https://api.airtable.com/v0/meta';

function normalizeFieldTypeFromApi(type: string): AirtableField['type'] {
  if (type === 'phoneNumber') return 'phone';
  return type as AirtableField['type'];
}

function normalizeFieldTypeForApi(type: string): string {
  if (type === 'phone') return 'phoneNumber';
  return type;
}

function getApiKey(): string {
  const rawKey = process.env.AIRTABLE_API_KEY;
  if (!rawKey) throw new Error('AIRTABLE_API_KEY is not set');

  const key = rawKey.trim().replace(/^Bearer\s+/i, '');
  if (!key) throw new Error('AIRTABLE_API_KEY is empty');
  return key;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
  };
}

// ─── Metadata API ───────────────────────────────────────────────

export async function listBases(): Promise<AirtableBase[]> {
  log.debug('GET /meta/bases');
  const res = await fetch(`${META_API_BASE}/bases`, { headers: headers() });
  if (!res.ok) throw new Error(`Airtable API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { bases: { id: string; name: string }[] };
  log.debug(`Listed ${data.bases.length} bases`);
  return data.bases.map(b => ({ id: b.id, name: b.name }));
}

export async function getTableSchema(baseId: string): Promise<AirtableTable[]> {
  log.debug('GET /meta/bases/:id/tables', { baseId });
  const res = await fetch(`${META_API_BASE}/bases/${baseId}/tables`, { headers: headers() });
  if (!res.ok) throw new Error(`Airtable API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as {
    tables: {
      id: string;
      name: string;
      fields: { id: string; name: string; type: string; options?: Record<string, unknown> }[];
      views: { id: string; name: string; type: string }[];
    }[];
  };

  return data.tables.map(t => ({
    id: t.id,
    name: t.name,
      fields: t.fields.map(f => ({
        id: f.id,
        name: f.name,
        type: normalizeFieldTypeFromApi(f.type),
        options: f.options,
      })),
    views: t.views.map(v => ({
      id: v.id,
      name: v.name,
      type: v.type,
    })),
  }));
}

// ─── Field Creation ─────────────────────────────────────────────

/**
 * Airtable requires specific `options` for certain field types at creation time.
 * This returns the minimum valid options for each type that needs them.
 */
function defaultFieldOptions(type: string): Record<string, unknown> | undefined {
  switch (type) {
    case 'checkbox':
      return { icon: 'check', color: 'grayBright' };

    case 'number':
    case 'percent':
      return { precision: 0 };

    case 'currency':
      return { precision: 2, symbol: '$' };

    case 'rating':
      return { icon: 'star', max: 5, color: 'yellowBright' };

    case 'duration':
      return { durationFormat: 'h:mm' };

    case 'date':
      return { dateFormat: { name: 'local' } };

    case 'dateTime':
      return {
        dateFormat: { name: 'local' },
        timeFormat: { name: '12hour' },
        timeZone: 'client',
      };

    case 'singleSelect':
    case 'multipleSelects':
      return { choices: [] };

    // lastModifiedTime is a computed field — Airtable auto-updates it.
    // referencedFieldIds: null means "watch all fields".
    case 'lastModifiedTime':
      return {
        isValid: true,
        referencedFieldIds: null,
      };

    // multipleRecordLinks requires a linkedTableId which the caller must supply —
    // there is no sensible default, so we return undefined and let the caller's
    // options pass through unchanged.
    case 'multipleRecordLinks':
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Ensures that a singleSelect (or multipleSelects) field contains all of the
 * specified choice names. Any missing choices are added by PATCHing the field.
 * Existing choices are preserved (passed back with their IDs so Airtable
 * doesn't delete them).
 * No-op if the field is not a select type or all choices already exist.
 */
export async function ensureSelectChoices(
  baseId: string,
  tableId: string,
  fieldName: string,
  requiredChoices: string[]
): Promise<void> {
  const tables = await getTableSchema(baseId);
  const table = tables.find(t => t.id === tableId);
  if (!table) return;

  const field = table.fields.find(f => f.name === fieldName);
  if (!field || (field.type !== 'singleSelect' && field.type !== 'multipleSelects')) return;

  const existingChoices = (field.options?.choices as { id?: string; name: string; color?: string }[]) ?? [];
  const existingNames = new Set(existingChoices.map(c => c.name));
  const missing = requiredChoices.filter(n => !existingNames.has(n));
  if (missing.length === 0) return;

  log.debug(`Adding ${missing.length} missing choice(s) to "${fieldName}"`, { missing });

  // Keep all existing choices (with their IDs so Airtable doesn't delete them)
  // and append new ones (without IDs — Airtable assigns them).
  const allChoices = [...existingChoices, ...missing.map(n => ({ name: n }))];

  const res = await fetch(`${META_API_BASE}/bases/${baseId}/tables/${tableId}/fields/${field.id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ options: { choices: allChoices } }),
  });
  if (!res.ok) {
    log.warn(`Failed to add choices to "${fieldName}": ${res.status} ${await res.text()}`);
  }
}

export async function createField(
  baseId: string,
  tableId: string,
  field: { name: string; type: string; options?: Record<string, unknown> }
): Promise<AirtableField> {
  log.debug('POST /meta/bases/:id/tables/:id/fields', { baseId, tableId, name: field.name, type: field.type });
  // Merge caller-supplied options over the defaults so callers can still override
  const defaults = defaultFieldOptions(field.type);
  const resolvedOptions = field.options
    ? { ...defaults, ...field.options }
    : defaults;

  const body: Record<string, unknown> = {
    name: field.name,
    type: normalizeFieldTypeForApi(field.type),
  };
  if (resolvedOptions) body.options = resolvedOptions;

  const res = await fetch(
    `${META_API_BASE}/bases/${baseId}/tables/${tableId}/fields`,
    { method: 'POST', headers: headers(), body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`Airtable API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { id: string; name: string; type: string; options?: Record<string, unknown> };
  return {
    id: data.id,
    name: data.name,
    type: normalizeFieldTypeFromApi(data.type),
    options: data.options,
  };
}

// ─── Record Operations ──────────────────────────────────────────

export async function listRecords(
  baseId: string,
  tableId: string,
  options?: { viewId?: string; fields?: string[]; maxRecords?: number }
): Promise<AirtableRecord[]> {
  log.debug('listRecords', { baseId, tableId, viewId: options?.viewId });
  const base = new Airtable({ apiKey: getApiKey() }).base(baseId);
  const records: AirtableRecord[] = [];

  const queryParams: Record<string, unknown> = {};
  if (options?.viewId) queryParams.view = options.viewId;
  if (options?.fields) queryParams.fields = options.fields;
  if (options?.maxRecords) queryParams.maxRecords = options.maxRecords;

  await new Promise<void>((resolve, reject) => {
    base(tableId)
      .select(queryParams)
      .eachPage(
        (pageRecords, fetchNextPage) => {
          for (const rec of pageRecords) {
            records.push({
              id: rec.id,
              fields: rec.fields as Record<string, unknown>,
              createdTime: rec._rawJson?.createdTime || '',
            });
          }
          fetchNextPage();
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
  });

  log.debug(`listRecords returned ${records.length} records`, { baseId, tableId });
  return records;
}

export async function getRecord(baseId: string, tableId: string, recordId: string): Promise<AirtableRecord> {
  const base = new Airtable({ apiKey: getApiKey() }).base(baseId);
  const rec = await base(tableId).find(recordId);
  return {
    id: rec.id,
    fields: rec.fields as Record<string, unknown>,
    createdTime: rec._rawJson?.createdTime || '',
  };
}

export async function createRecords(
  baseId: string,
  tableId: string,
  records: { fields: Record<string, unknown> }[]
): Promise<AirtableRecord[]> {
  log.debug(`createRecords (${records.length})`, { baseId, tableId });
  const base = new Airtable({ apiKey: getApiKey() }).base(baseId);
  const results: AirtableRecord[] = [];

  // Airtable batch limit is 10 records at a time
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const created = await base(tableId).create(
      batch.map(r => ({ fields: r.fields as Partial<FieldSet> }))
    ) as Airtable.Records<FieldSet>;
    for (const rec of created) {
      results.push({
        id: rec.id,
        fields: rec.fields as Record<string, unknown>,
        createdTime: rec._rawJson?.createdTime || '',
      });
    }
  }

  return results;
}

export async function updateRecords(
  baseId: string,
  tableId: string,
  records: { id: string; fields: Record<string, unknown> }[]
): Promise<AirtableRecord[]> {
  log.debug(`updateRecords (${records.length})`, { baseId, tableId });
  const base = new Airtable({ apiKey: getApiKey() }).base(baseId);
  const results: AirtableRecord[] = [];

  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const updated = await base(tableId).update(
      batch.map(r => ({ id: r.id, fields: r.fields as Partial<FieldSet> }))
    ) as Airtable.Records<FieldSet>;
    for (const rec of updated) {
      results.push({
        id: rec.id,
        fields: rec.fields as Record<string, unknown>,
        createdTime: rec._rawJson?.createdTime || '',
      });
    }
  }

  return results;
}

export async function deleteRecords(baseId: string, tableId: string, recordIds: string[]): Promise<void> {
  log.debug(`deleteRecords (${recordIds.length})`, { baseId, tableId });
  const base = new Airtable({ apiKey: getApiKey() }).base(baseId);

  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10);
    await base(tableId).destroy(batch);
  }
}
