import type { Connection, FieldMapping, SyncLog, SyncRecordResult, RecordAction, AirtableRecord, WebflowItem, SyncDirection } from '../types';
import * as airtable from './airtable';
import * as webflow from './webflow';
import { convertAirtableToWebflow, convertWebflowToAirtable } from './field-mapper';
import {
  getFieldMappings,
  getRecordMapping,
  getAllRecordMappings,
  upsertRecordMapping,
  deleteRecordMapping,
  updateConnection,
  listConnections,
} from '../models/connection';
import { createSyncLog, updateSyncLog } from '../models/sync-log';
import { createLogger } from '../utils/logger';

const logger = createLogger('sync');

export interface SyncOptions {
  /** Which direction to run — passed per-request, not stored on the connection */
  direction: SyncDirection;
  dryRun?: boolean;
  /** Only sync records with these source IDs */
  recordIds?: string[];
  /** Re-process all mapped records even if delta-sync metadata says they are unchanged */
  force?: boolean;
}

// ─── Reference ID Extraction Helpers ───────────────────────────

/**
 * Extracts plain Webflow item ID strings from a Reference/MultiReference
 * field value, which the Webflow API may return as:
 *   - a single string           →  "67c06782..."
 *   - an array of strings       →  ["67c06782...", "67c06783..."]
 *   - an object with id key     →  { id: "67c06782..." }   (some API versions)
 *   - an array of such objects  →  [{ id: "..." }, ...]
 */
function extractWebflowItemIds(rawValue: unknown): string[] {
  const items = Array.isArray(rawValue) ? rawValue : (rawValue != null ? [rawValue] : []);
  return items
    .map((item: unknown) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'id' in item) return (item as { id: string }).id;
      return null;
    })
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Extracts plain Airtable record ID strings from a multipleRecordLinks
 * field value, which the Airtable SDK returns as:
 *   - an array of objects:  [{ id: "recXXX", name?: "..." }, ...]
 *   - occasionally a single such object or a plain string
 */
function extractAirtableRecordIds(rawValue: unknown): string[] {
  const items = Array.isArray(rawValue) ? rawValue : (rawValue != null ? [rawValue] : []);
  return items
    .map((item: unknown) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'id' in item) return (item as { id: string }).id;
      return null;
    })
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function findLinkedConnectionByAirtableRecord(
  currentConnectionId: string,
  airtableRecordId: string
): Promise<string | undefined> {
  const connections = await listConnections();
  for (const conn of connections) {
    if (conn.id === currentConnectionId) continue;
    if (await getRecordMapping(conn.id, airtableRecordId)) {
      return conn.id;
    }
  }
  return undefined;
}

async function findLinkedConnectionByWebflowItem(
  currentConnectionId: string,
  webflowItemId: string
): Promise<string | undefined> {
  const connections = await listConnections();
  for (const conn of connections) {
    if (conn.id === currentConnectionId) continue;
    if (await getRecordMapping(conn.id, undefined, webflowItemId)) {
      return conn.id;
    }
  }
  return undefined;
}

async function getMappedWebflowItemIds(linkedConnectionId: string, airtableRecordIds: string[]): Promise<string[]> {
  const webflowIds: string[] = [];
  for (const airtableRecordId of airtableRecordIds) {
    const mapping = await getRecordMapping(linkedConnectionId, airtableRecordId);
    if (mapping?.webflow_item_id) {
      webflowIds.push(mapping.webflow_item_id);
    }
  }
  return webflowIds;
}

async function getMappedAirtableRecordIds(linkedConnectionId: string, webflowItemIds: string[]): Promise<string[]> {
  const airtableIds: string[] = [];
  for (const webflowItemId of webflowItemIds) {
    const mapping = await getRecordMapping(linkedConnectionId, undefined, webflowItemId);
    if (mapping?.airtable_record_id) {
      airtableIds.push(mapping.airtable_record_id);
    }
  }
  return airtableIds;
}

export async function runSync(connection: Connection, options: SyncOptions): Promise<SyncLog> {
  const syncLog = await createSyncLog(connection.id, options.direction);
  const mappings = await getFieldMappings(connection.id);
  const connLabel = connection.name || connection.id;

  logger.info('Sync started', {
    name: connLabel,
    direction: options.direction,
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
  });

  if (mappings.length === 0) {
    logger.warn('No field mappings configured — sync aborted', { name: connLabel });
    await updateSyncLog(syncLog.id, {
      status: 'failed',
      errors: [{ record_id: '', message: 'No field mappings configured for this connection' }],
    });
    return syncLog;
  }

  try {
    let results: SyncRecordResult[];

    if (options.direction === 'airtable_to_webflow') {
      results = await syncAirtableToWebflow(connection, mappings, options);
    } else {
      results = await syncWebflowToAirtable(connection, mappings, options);
    }

    const created = results.filter(r => r.action === 'created').length;
    const updated = results.filter(r => r.action === 'updated').length;
    const deleted = results.filter(r => r.action === 'deleted').length;
    const skipped = results.filter(r => r.action === 'skipped').length;
    const failed = results.filter(r => r.action === 'failed').length;
    const errors = results
      .filter(r => r.action === 'failed' && r.error)
      .map(r => ({ record_id: r.source_id, message: r.error! }));

    const status = failed > 0 ? (created + updated + deleted > 0 ? 'partial' : 'failed') : 'completed';

    logger.info(`Sync ${status}`, { name: connLabel, created, updated, deleted, skipped, failed });
    for (const e of errors) {
      logger.warn('Record error', { record: e.record_id, message: e.message });
    }

    await updateSyncLog(syncLog.id, {
      status,
      records_processed: results.length - skipped,
      records_created: created,
      records_updated: updated,
      records_deleted: deleted,
      records_failed: failed,
      errors,
    });

    await updateConnection(connection.id, { last_synced_at: new Date().toISOString() });

    return syncLog;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Sync threw an unhandled error', err instanceof Error ? err : new Error(message));
    await updateSyncLog(syncLog.id, {
      status: 'failed',
      errors: [{ record_id: '', message: `Sync failed: ${message}` }],
    });
    return syncLog;
  }
}

// ─── Airtable → Webflow ────────────────────────────────────────

async function syncAirtableToWebflow(
  connection: Connection,
  mappings: FieldMapping[],
  options: SyncOptions
): Promise<SyncRecordResult[]> {
  // Fetch all Airtable records
  const atRecords = await airtable.listRecords(
    connection.airtable_base_id,
    connection.airtable_table_id,
    { viewId: connection.airtable_view_id }
  );
  logger.debug(`Fetched ${atRecords.length} Airtable records`, { connection: connection.name });

  // Log the connection's metadata field configuration so we can see exactly
  // which fields are active and whether action_field / last_modified_field are set.
  logger.info('Connection metadata config', {
    connection: connection.name,
    action_field: connection.action_field ?? '(not set)',
    last_modified_field: connection.last_modified_field ?? '(not set)',
    message_field: connection.message_field ?? '(not set)',
    sync_time_field: connection.sync_time_field ?? '(not set)',
    webflow_id_field: connection.webflow_id_field ?? '(not set)',
    delta_sync_enabled: !!connection.last_modified_field,
  });

  // Filter to specific records if requested
  const recordsToSync = options.recordIds
    ? atRecords.filter(r => options.recordIds!.includes(r.id))
    : atRecords;

  const results: SyncRecordResult[] = [];
  if (options.recordIds) {
    const foundIds = new Set(recordsToSync.map(record => record.id));
    for (const recordId of options.recordIds) {
      if (!foundIds.has(recordId)) {
        results.push({
          source_id: recordId,
          action: 'failed',
          error: 'Airtable record not found for provided recordId',
        });
      }
    }
  }
  const existingMappings = await getAllRecordMappings(connection.id);
  const processedAirtableIds = new Set<string>();
  const metadataUpdates: { id: string; fields: Record<string, unknown> }[] = [];
  // Webflow item IDs that need live publishing after all records are processed
  const publishIds: string[] = [];
  // Records that synced successfully — their last_synced_at will be re-stamped
  // AFTER the metadata write-back so that delta sync doesn't re-trigger on
  // the field changes the write-back itself causes.
  const syncedMappings: { airtableId: string; webflowId: string }[] = [];

  // Build set of Airtable field names already used in regular mappings.
  // Metadata write-back will skip any field in this set to prevent overwriting mapped content.
  const mappedAtFieldNames = new Set(mappings.map(m => m.airtable_field_name));

  // Process each Airtable record
  for (const record of recordsToSync) {
    processedAirtableIds.add(record.id);

    // ── Delta sync: skip records that haven't changed since last sync ──
    if (connection.last_modified_field && !options.recordIds && !options.force) {
      const lastModified = record.fields[connection.last_modified_field] as string | undefined;
      const existingMap = await getRecordMapping(connection.id, record.id);

      if (!lastModified) {
        logger.debug('Delta check: no lastModified value — will process record normally', { id: record.id, last_modified_field: connection.last_modified_field });
      } else if (!existingMap) {
        logger.debug('Delta check: no existing mapping — new record, will process', { id: record.id });
      } else {
        const modifiedAt = new Date(lastModified).getTime();
        const syncedAt = new Date(existingMap.last_synced_at).getTime();
        logger.debug('Delta check', {
          id: record.id,
          lastModified,
          last_synced_at: existingMap.last_synced_at,
          modifiedAt,
          syncedAt,
          diff_ms: modifiedAt - syncedAt,
          will_skip: !isNaN(modifiedAt) && !isNaN(syncedAt) && modifiedAt <= syncedAt,
        });

        if (!isNaN(modifiedAt) && !isNaN(syncedAt) && modifiedAt <= syncedAt) {
          logger.debug('Skipping AT record (unchanged since last sync)', { id: record.id });

          // Even for skipped records: if the action field is completely empty
          // (e.g. it was just recreated in Airtable), queue a write-back so it
          // gets populated. Recreating a field clears all values without
          // bumping lastModifiedTime, so without this check those records would
          // be skipped forever and the field would stay empty.
          // Also re-stamp last_synced_at after the write-back so the bump to
          // lastModifiedTime caused by the write-back doesn't trigger a
          // delta-sync re-process on the very next run.
          if (connection.action_field && !mappedAtFieldNames.has(connection.action_field) && !options.dryRun) {
            const currentAction = (record.fields[connection.action_field] ?? '') as string;
            logger.debug('Skipped record action field check', {
              id: record.id,
              action_field: connection.action_field,
              currentValue: currentAction || '(empty)',
              will_queue_writeback: !currentAction,
            });
            if (!currentAction) {
              logger.info('Queueing action field write-back for skipped record with empty action field', { id: record.id });
              metadataUpdates.push({ id: record.id, fields: { [connection.action_field]: 'Re: Item updated' } });
              syncedMappings.push({ airtableId: record.id, webflowId: existingMap.webflow_item_id });
            }
          } else if (connection.action_field) {
            logger.debug('Skipped record: action field write-back blocked', {
              id: record.id,
              reason: mappedAtFieldNames.has(connection.action_field)
                ? 'action_field is also used in a regular field mapping'
                : options.dryRun ? 'dryRun mode' : 'unknown',
            });
          } else {
            logger.debug('Skipped record: no action_field configured on connection', { id: record.id });
          }

          results.push({ source_id: record.id, target_id: existingMap.webflow_item_id, action: 'skipped' });
          continue;
        }
      }
    }

    const result = await syncOneRecordToWebflow(connection, record, mappings, options, publishIds);
    results.push(result);

    // Track successful syncs for re-stamping last_synced_at after write-back (see below)
    if (result.target_id && (result.action === 'created' || result.action === 'updated')) {
      syncedMappings.push({ airtableId: record.id, webflowId: result.target_id });
    }

    // ── Metadata write-back to Airtable ──────────────────────────────
    if (!options.dryRun) {
      const meta: Record<string, unknown> = {};

      if (result.action === 'failed') {
        // Write error to message field
        if (connection.message_field && !mappedAtFieldNames.has(connection.message_field))
          meta[connection.message_field] = result.error || 'Unknown error';
        // Flag the action field so users see the failure at a glance
        if (connection.action_field && !mappedAtFieldNames.has(connection.action_field))
          meta[connection.action_field] = 'Re: Item encountered error';
      } else if (result.action !== 'skipped') {
        // Clear previous error
        if (connection.message_field && !mappedAtFieldNames.has(connection.message_field))
          meta[connection.message_field] = '';
        // Write sync timestamp
        if (connection.sync_time_field && !mappedAtFieldNames.has(connection.sync_time_field))
          meta[connection.sync_time_field] = new Date().toISOString();
        // Write Webflow item ID
        if (connection.webflow_id_field && result.target_id && !mappedAtFieldNames.has(connection.webflow_id_field))
          meta[connection.webflow_id_field] = result.target_id;
        // Action feedback: mirrors the command back with "Re:" prefix.
        // Also fires when action is empty so the field is always filled after first sync.
        if (connection.action_field && !mappedAtFieldNames.has(connection.action_field)) {
          const actionValue = (record.fields[connection.action_field] ?? '') as string;
          if (!actionValue.startsWith('Re:')) {
            const actionNorm = actionValue.toLowerCase(); // "Draft" → "draft"
            const label = actionNorm === 'draft'   ? 'drafted'
                        : actionNorm === 'archive' ? 'archived'
                        : actionNorm === 'delete'  ? 'deleted'
                        : actionNorm === 'stage'   ? 'staged'
                        : actionNorm === 'publish' ? 'published'
                        : result.action === 'created' ? 'created'
                        : 'updated';
            meta[connection.action_field] = `Re: Item ${label}`;
          }
        }
      }

      if (Object.keys(meta).length > 0) {
        metadataUpdates.push({ id: record.id, fields: meta });
      }
    }
  }

  // Handle deletions: records in mapping that no longer exist in Airtable
  if (!options.recordIds) {
    for (const mapping of existingMappings) {
      if (!processedAirtableIds.has(mapping.airtable_record_id)) {
        const result = await deleteWebflowItem(connection, mapping.airtable_record_id, mapping.webflow_item_id, options);
        results.push(result);
      }
    }
  }

  // ── Publish items that had action === 'publish' ───────────────────
  if (publishIds.length > 0 && !options.dryRun) {
    try {
      await webflow.publishItems(connection.webflow_collection_id, publishIds);
      logger.info(`Published ${publishIds.length} item(s) to live site`, { connection: connection.name });
    } catch (pubErr) {
      logger.warn('Failed to publish items to live site', pubErr instanceof Error ? pubErr : undefined);
    }
  }

  // ── Ensure action field singleSelect has all "Re:" response choices ──
  // singleSelect rejects values not in its choice list — add any missing
  // "Re:" responses before the batch write so nothing is silently dropped.
  if (connection.action_field && !options.dryRun && metadataUpdates.length > 0) {
    const responseValues = [...new Set(
      metadataUpdates
        .map(u => u.fields[connection.action_field!] as string | undefined)
        .filter((v): v is string => typeof v === 'string' && v.startsWith('Re:'))
    )];
    logger.debug('Action field choice check', {
      action_field: connection.action_field,
      response_values_in_batch: responseValues,
    });
    if (responseValues.length > 0) {
      try {
        logger.info(`Ensuring action field "${connection.action_field}" has ${responseValues.length} choice(s)`, { responseValues });
        await airtable.ensureSelectChoices(
          connection.airtable_base_id,
          connection.airtable_table_id,
          connection.action_field,
          responseValues
        );
        logger.info('ensureSelectChoices completed successfully');
      } catch (choiceErr) {
        logger.warn('Failed to ensure action field choices', choiceErr instanceof Error ? choiceErr : undefined);
      }
    }
  } else if (connection.action_field) {
    logger.debug('ensureSelectChoices skipped', {
      action_field: connection.action_field,
      reason: options.dryRun ? 'dryRun' : metadataUpdates.length === 0 ? 'no metadata updates queued' : 'unknown',
    });
  }

  // ── Batch write metadata back to Airtable ────────────────────────
  logger.info(`Metadata write-back: ${metadataUpdates.length} record(s) to update`, {
    fields_in_updates: metadataUpdates.length > 0
      ? [...new Set(metadataUpdates.flatMap(u => Object.keys(u.fields)))]
      : [],
    sample: metadataUpdates.slice(0, 3).map(u => ({ id: u.id, fields: u.fields })),
  });
  if (metadataUpdates.length > 0) {
    try {
      await airtable.updateRecords(
        connection.airtable_base_id,
        connection.airtable_table_id,
        metadataUpdates
      );
      logger.info(`Metadata write-back succeeded for ${metadataUpdates.length} record(s)`);
    } catch (metaErr) {
      // Metadata write-back is best-effort — don't fail the entire sync
      logger.warn('Metadata write-back to Airtable failed', metaErr instanceof Error ? metaErr : undefined);
    }
  }

  // ── Re-stamp last_synced_at AFTER write-back ──────────────────────
  // The metadata write-back updates Airtable fields, which causes Airtable to
  // bump lastModifiedTime on those records. If last_synced_at was set before
  // the write-back (during the sync loop), the bumped lastModifiedTime would
  // exceed last_synced_at and every record would be picked up again on the
  // next run — an infinite delta sync loop. Re-stamping here ensures
  // last_synced_at always covers the write-back itself.
  if (!options.dryRun) {
    for (const m of syncedMappings) {
      await upsertRecordMapping(connection.id, m.airtableId, m.webflowId);
    }
    logger.info(`Re-stamped last_synced_at for ${syncedMappings.length} record(s) after write-back`, {
      airtable_ids: syncedMappings.map(m => m.airtableId),
    });
  }

  return results;
}

async function syncOneRecordToWebflow(
  connection: Connection,
  record: AirtableRecord,
  mappings: FieldMapping[],
  options: SyncOptions,
  publishIds: string[] = []
): Promise<SyncRecordResult> {
  try {
    // Read the action field value once — used throughout this function
    const actionRaw = connection.action_field
      ? (record.fields[connection.action_field] as string | undefined)
      : undefined;
    // Normalise: strip "Re:" responses → treat as no pending command
    // Also lowercase so "Draft"/"DRAFT" all match the RecordAction literals
    const action = (actionRaw && !actionRaw.startsWith('Re:'))
      ? (actionRaw.toLowerCase() as RecordAction)
      : undefined;

    // Handle delete before building field data
    if (action === 'delete') {
      const existingMap = await getRecordMapping(connection.id, record.id);
      if (existingMap) {
        return deleteWebflowItem(connection, record.id, existingMap.webflow_item_id, options);
      }
      return { source_id: record.id, action: 'skipped' };
    }

    const existingMap = await getRecordMapping(connection.id, record.id);

    // Build Webflow field data from mappings
    const fieldData: Record<string, unknown> = {};
    for (const mapping of mappings) {
      const rawValue = record.fields[mapping.airtable_field_name];
      let converted: unknown;

      // ── Reference / MultiReference resolution ──────────────────────────
      // Airtable stores linked records as [{ id: 'recXXX' }, …].
      // We translate those Airtable record IDs → Webflow item IDs via the
      // linked connection's record_map.
      // If no linked_connection_id is configured, we auto-detect by searching
      // all other connections' record maps for a matching Airtable record ID.
      if (mapping.webflow_field_type === 'Reference' || mapping.webflow_field_type === 'MultiReference') {
        if (mapping.airtable_field_type !== 'multipleRecordLinks') {
          logger.warn(
            `Reference field "${mapping.webflow_field_slug}" is mapped to incompatible Airtable field "${mapping.airtable_field_name}" (${mapping.airtable_field_type}) — expected multipleRecordLinks; skipping field`,
            { airtableFieldId: mapping.airtable_field_id, webflowFieldId: mapping.webflow_field_id }
          );
          continue;
        }

        const atRecordIds = extractAirtableRecordIds(rawValue);
        if (atRecordIds.length === 0) continue;

        let linkedConnId = mapping.linked_connection_id;
        if (!linkedConnId) {
          linkedConnId = await findLinkedConnectionByAirtableRecord(connection.id, atRecordIds[0]);
          if (linkedConnId) {
            logger.debug(`Auto-detected linked connection for reference field "${mapping.airtable_field_name}"`, { linkedConnId });
          }
        }
        if (!linkedConnId) {
          logger.warn(`No linked connection found for reference field "${mapping.airtable_field_name}" — skipping field`, { atRecordIds });
          continue; // no match found — skip to avoid invalid IDs
        }

        const wfIds = await getMappedWebflowItemIds(linkedConnId, atRecordIds);
        if (wfIds.length === 0) {
          logger.warn(
            `Reference resolution produced no mapped Webflow IDs for field "${mapping.airtable_field_name}" — skipping field to preserve existing data`,
            { linkedConnId, atRecordIds }
          );
          continue;
        }

        converted = mapping.webflow_field_type === 'Reference' ? wfIds[0] : wfIds;
      } else {
        converted = convertAirtableToWebflow(rawValue, mapping);
      }

      if (existingMap && (converted === null || converted === undefined || converted === '')) {
        logger.debug('Preserving existing Webflow field on update because Airtable value is empty', {
          airtableId: record.id,
          webflowFieldSlug: mapping.webflow_field_slug,
          airtableFieldName: mapping.airtable_field_name,
        });
        continue;
      }

      if (mapping.is_name_field) {
        fieldData['name'] = converted;
      } else if (mapping.is_slug_field) {
        fieldData['slug'] = converted;
      } else {
        fieldData[mapping.webflow_field_slug] = converted;
      }
    }

    // Determine Webflow item flags from action:
    //   draft   → isDraft: true  (hidden from live site, visible in editor)
    //   archive → isArchived: true
    //   publish → isDraft: false (staged), will be live-published after the batch
    //   stage   → isDraft: false (staged, not pushed to live domain) — default
    //   <none>  → same as stage
    const isDraft    = action === 'draft';
    const isArchived = action === 'archive';

    if (options.dryRun) {
      const existing = await getRecordMapping(connection.id, record.id);
      return {
        source_id: record.id,
        target_id: existing?.webflow_item_id,
        action: existing ? 'updated' : 'created',
      };
    }

    if (existingMap) {
      // Update existing item
      const updated = await webflow.updateItem(
        connection.webflow_collection_id,
        existingMap.webflow_item_id,
        fieldData,
        { isDraft, isArchived }
      );
      await upsertRecordMapping(connection.id, record.id, updated.id);
      logger.debug('Updated Webflow item', { airtableId: record.id, webflowId: updated.id, action });
      if (action === 'publish') publishIds.push(updated.id);
      return { source_id: record.id, target_id: updated.id, action: 'updated' };
    } else {
      // Create new item
      const created = await webflow.createItem(
        connection.webflow_collection_id,
        fieldData,
        { isDraft, isArchived }
      );
      await upsertRecordMapping(connection.id, record.id, created.id);
      logger.debug('Created Webflow item', { airtableId: record.id, webflowId: created.id, action });
      if (action === 'publish') publishIds.push(created.id);
      return { source_id: record.id, target_id: created.id, action: 'created' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to sync Airtable record to Webflow', { airtableId: record.id, error: message });
    return { source_id: record.id, action: 'failed', error: message };
  }
}

async function deleteWebflowItem(
  connection: Connection,
  airtableId: string,
  webflowId: string,
  options: SyncOptions
): Promise<SyncRecordResult> {
  try {
    if (!options.dryRun) {
      await webflow.deleteItem(connection.webflow_collection_id, webflowId);
      await deleteRecordMapping(connection.id, airtableId);
    }
    logger.debug('Deleted Webflow item', { airtableId, webflowId });
    return { source_id: airtableId, target_id: webflowId, action: 'deleted' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to delete Webflow item', { airtableId, webflowId, error: message });
    return { source_id: airtableId, action: 'failed', error: `Delete failed: ${message}` };
  }
}

// ─── Webflow → Airtable ────────────────────────────────────────

async function syncWebflowToAirtable(
  connection: Connection,
  mappings: FieldMapping[],
  options: SyncOptions
): Promise<SyncRecordResult[]> {
  // Fetch all Webflow items
  const wfItems = await webflow.listItems(connection.webflow_collection_id);
  logger.debug(`Fetched ${wfItems.length} Webflow items`, { connection: connection.name });

  logger.info('Connection metadata config', {
    connection: connection.name,
    action_field: connection.action_field ?? '(not set)',
    last_modified_field: connection.last_modified_field ?? '(not set)',
    message_field: connection.message_field ?? '(not set)',
    sync_time_field: connection.sync_time_field ?? '(not set)',
    webflow_id_field: connection.webflow_id_field ?? '(not set)',
  });

  const itemsToSync = options.recordIds
    ? wfItems.filter(i => options.recordIds!.includes(i.id))
    : wfItems;

  const results: SyncRecordResult[] = [];
  if (options.recordIds) {
    const foundIds = new Set(itemsToSync.map(item => item.id));
    for (const recordId of options.recordIds) {
      if (!foundIds.has(recordId)) {
        results.push({
          source_id: recordId,
          action: 'failed',
          error: 'Webflow item not found for provided recordId',
        });
      }
    }
  }
  const existingMappings = await getAllRecordMappings(connection.id);
  const processedWebflowIds = new Set<string>();

  for (const item of itemsToSync) {
    processedWebflowIds.add(item.id);

    // ── Delta sync: skip items not updated since last sync ──────────
    if (!options.recordIds && !options.force) {
      const existingMap = await getRecordMapping(connection.id, undefined, item.id);
      if (existingMap && item.lastUpdated) {
        const updatedAt = new Date(item.lastUpdated).getTime();
        const syncedAt = new Date(existingMap.last_synced_at).getTime();
        logger.debug('Delta check (WF→AT)', {
          id: item.id,
          lastUpdated: item.lastUpdated,
          last_synced_at: existingMap.last_synced_at,
          diff_ms: updatedAt - syncedAt,
          will_skip: !isNaN(updatedAt) && !isNaN(syncedAt) && updatedAt <= syncedAt,
        });
        if (!isNaN(updatedAt) && !isNaN(syncedAt) && updatedAt <= syncedAt) {
          logger.debug('Skipping WF item (unchanged since last sync)', { id: item.id });
          results.push({ source_id: item.id, target_id: existingMap.airtable_record_id, action: 'skipped' });
          continue;
        }
      }
    }

    const result = await syncOneRecordToAirtable(connection, item, mappings, options);
    results.push(result);
  }

  // Handle deletions: mapped records that no longer exist in Webflow
  if (!options.recordIds) {
    for (const mapping of existingMappings) {
      if (!processedWebflowIds.has(mapping.webflow_item_id)) {
        const result = await deleteAirtableRecord(connection, mapping.webflow_item_id, mapping.airtable_record_id, options);
        results.push(result);
      }
    }
  }

  // ── Process action commands + backfill empty metadata ─────────
  // Pass the already-fetched wfItems so processActionCommands can
  // populate metadata fields (action_field, webflow_id_field, etc.)
  // on records that were skipped by delta sync and have never had
  // those fields set (e.g. the connection was configured after the
  // initial sync, or the field was added later).
  if (!options.dryRun) {
    const wfItemsMap = new Map(wfItems.map(i => [i.id, i]));
    await processActionCommands(connection, mappings, wfItemsMap);
  }

  return results;
}

// ─── Action Command Processing ─────────────────────────────────
// Scans Airtable records for pending action commands and applies
// them to the corresponding Webflow items.  Called at the end of
// syncWebflowToAirtable so that action commands work regardless
// of the connection's sync direction.  (The AT→WF path handles
// actions inline in syncOneRecordToWebflow, so it doesn't need
// this extra step.)

async function processActionCommands(
  connection: Connection,
  mappings: FieldMapping[],
  // Webflow items already fetched by the calling sync — used to backfill
  // metadata fields on records that were skipped by delta sync.
  wfItemsMap?: Map<string, WebflowItem>
): Promise<void> {
  const mappedAtFieldNames = new Set(mappings.map(m => m.airtable_field_name));
  if (connection.action_field && mappedAtFieldNames.has(connection.action_field)) {
    logger.debug('Action field is used in a regular mapping — skipping action processing');
    return;
  }

  // Fetch all Airtable records to inspect the action field
  const records = await airtable.listRecords(
    connection.airtable_base_id,
    connection.airtable_table_id,
    { viewId: connection.airtable_view_id }
  );

  const metadataUpdates: { id: string; fields: Record<string, unknown> }[] = [];
  const publishIds: string[] = [];
  const syncedMappings: { airtableId: string; webflowId: string }[] = [];

  for (const record of records) {
    const actionRaw = connection.action_field
      ? (record.fields[connection.action_field] ?? '') as string
      : '';
    const hasPendingCommand = actionRaw && !actionRaw.startsWith('Re:');

    // ── Backfill empty metadata for records skipped by delta sync ──
    // These are records that exist in Airtable but whose metadata fields
    // were never populated (e.g. the fields were added to the connection
    // after the initial sync, or the first write-back failed).
    if (!hasPendingCommand && wfItemsMap) {
      const existingMap = await getRecordMapping(connection.id, record.id);
      if (existingMap) {
        const wfItem = wfItemsMap.get(existingMap.webflow_item_id);
        if (wfItem) {
          const backfill: Record<string, unknown> = {};

          if (connection.action_field && !mappedAtFieldNames.has(connection.action_field) && !actionRaw) {
            const actionLabel = wfItem.isArchived ? 'Re: Item archived'
                              : wfItem.isDraft    ? 'Re: Item drafted'
                              :                    'Re: Item published';
            backfill[connection.action_field] = actionLabel;
          }
          if (connection.webflow_id_field && !mappedAtFieldNames.has(connection.webflow_id_field)
              && !record.fields[connection.webflow_id_field]) {
            backfill[connection.webflow_id_field] = wfItem.id;
          }
          if (connection.sync_time_field && !mappedAtFieldNames.has(connection.sync_time_field)
              && !record.fields[connection.sync_time_field]) {
            backfill[connection.sync_time_field] = new Date().toISOString();
          }

          if (Object.keys(backfill).length > 0) {
            logger.debug('Backfilling empty metadata for skipped record', { id: record.id, fields: Object.keys(backfill) });
            metadataUpdates.push({ id: record.id, fields: backfill });
            syncedMappings.push({ airtableId: record.id, webflowId: existingMap.webflow_item_id });
          }
        }
      }
      continue; // no pending command — nothing else to do for this record
    }

    if (!hasPendingCommand) continue; // no wfItemsMap and no command

    const action = actionRaw.toLowerCase().trim();
    const existingMap = await getRecordMapping(connection.id, record.id);
    if (!existingMap) {
      logger.debug('Action command on unmapped record — skipping', { id: record.id, action });
      continue;
    }

    logger.info(`Processing action command: "${actionRaw}"`, { id: record.id, webflowId: existingMap.webflow_item_id });

    try {
      let label: string;

      if (action === 'delete') {
        await webflow.deleteItem(connection.webflow_collection_id, existingMap.webflow_item_id);
        await deleteRecordMapping(connection.id, record.id);
        label = 'deleted';
      } else {
        const isDraft    = action === 'draft';
        const isArchived = action === 'archive';

        await webflow.updateItem(
          connection.webflow_collection_id,
          existingMap.webflow_item_id,
          {}, // no field data changes — only status
          { isDraft, isArchived }
        );

        if (action === 'publish') {
          publishIds.push(existingMap.webflow_item_id);
        }

        label = action === 'draft'   ? 'drafted'
              : action === 'archive' ? 'archived'
              : action === 'stage'   ? 'staged'
              : action === 'publish' ? 'published'
              : 'updated';

        syncedMappings.push({ airtableId: record.id, webflowId: existingMap.webflow_item_id });
      }

      const meta: Record<string, unknown> = { [connection.action_field!]: `Re: Item ${label}` };
      // Clear previous error on success
      if (connection.message_field && !mappedAtFieldNames.has(connection.message_field))
        meta[connection.message_field] = '';
      metadataUpdates.push({ id: record.id, fields: meta });

      logger.info(`Action command processed: ${actionRaw} → Re: Item ${label}`, { id: record.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to process action command "${actionRaw}"`, { id: record.id, error: message });
      const meta: Record<string, unknown> = { [connection.action_field!]: 'Re: Item encountered error' };
      if (connection.message_field && !mappedAtFieldNames.has(connection.message_field))
        meta[connection.message_field] = message;
      metadataUpdates.push({ id: record.id, fields: meta });
    }
  }

  if (metadataUpdates.length === 0) {
    logger.debug('No action commands or metadata backfills to process');
    return;
  }
  logger.info(`Metadata updates queued: ${metadataUpdates.length} record(s)`, {
    sample: metadataUpdates.slice(0, 3).map(u => ({ id: u.id, fields: Object.keys(u.fields) })),
  });

  // ── Publish batch ──────────────────────────────────────────────
  if (publishIds.length > 0) {
    try {
      await webflow.publishItems(connection.webflow_collection_id, publishIds);
      logger.info(`Published ${publishIds.length} item(s) to live site (action commands)`);
    } catch (pubErr) {
      logger.warn('Failed to publish items (action commands)', pubErr instanceof Error ? pubErr : undefined);
    }
  }

  // ── Ensure singleSelect choices exist ──────────────────────────
  const responseValues = [...new Set(
    metadataUpdates
      .map(u => u.fields[connection.action_field!] as string | undefined)
      .filter((v): v is string => typeof v === 'string' && v.startsWith('Re:'))
  )];
  if (responseValues.length > 0) {
    try {
      await airtable.ensureSelectChoices(
        connection.airtable_base_id,
        connection.airtable_table_id,
        connection.action_field!,
        responseValues
      );
    } catch (choiceErr) {
      logger.warn('Failed to ensure action field choices (action commands)', choiceErr instanceof Error ? choiceErr : undefined);
    }
  }

  // ── Write back responses to Airtable ───────────────────────────
  try {
    await airtable.updateRecords(
      connection.airtable_base_id,
      connection.airtable_table_id,
      metadataUpdates
    );
    logger.info(`Action command write-back succeeded for ${metadataUpdates.length} record(s)`);
  } catch (metaErr) {
    logger.warn('Action command write-back failed', metaErr instanceof Error ? metaErr : undefined);
  }

  // ── Re-stamp last_synced_at so the write-back doesn't trigger re-sync ──
  for (const m of syncedMappings) {
    await upsertRecordMapping(connection.id, m.airtableId, m.webflowId);
  }
  if (syncedMappings.length > 0) {
    logger.debug(`Re-stamped last_synced_at for ${syncedMappings.length} record(s) after action processing`);
  }
}

async function syncOneRecordToAirtable(
  connection: Connection,
  item: WebflowItem,
  mappings: FieldMapping[],
  options: SyncOptions
): Promise<SyncRecordResult> {
  try {
    // Build Airtable fields from mappings
    const fields: Record<string, unknown> = {};
    for (const mapping of mappings) {
      let rawValue: unknown;
      if (mapping.is_name_field) {
        rawValue = item.fieldData['name'];
      } else if (mapping.is_slug_field) {
        rawValue = item.fieldData['slug'];
      } else {
        rawValue = item.fieldData[mapping.webflow_field_slug];
      }

      let converted: unknown;

      // ── Reference / MultiReference resolution ──────────────────────────
      // Webflow returns Reference values as a string item ID (or occasionally
      // as an object with an `id` key); MultiReference as an array of those.
      // We translate Webflow item IDs → Airtable record IDs via the linked
      // connection's record_map, then format them as [{ id: 'recXXX' }, …]
      // which is what Airtable's multipleRecordLinks field expects.
      // If no linked_connection_id is configured, we auto-detect by searching
      // all other connections' record maps for a matching Webflow item ID.
      if (mapping.webflow_field_type === 'Reference' || mapping.webflow_field_type === 'MultiReference') {
        if (mapping.airtable_field_type !== 'multipleRecordLinks') {
          logger.warn(
            `Reference field "${mapping.webflow_field_slug}" is mapped to incompatible Airtable field "${mapping.airtable_field_name}" (${mapping.airtable_field_type}) — expected multipleRecordLinks; skipping field`,
            { airtableFieldId: mapping.airtable_field_id, webflowFieldId: mapping.webflow_field_id }
          );
          continue;
        }

        const wfItemIds = extractWebflowItemIds(rawValue);
        if (wfItemIds.length === 0) continue;

        let linkedConnId = mapping.linked_connection_id;
        if (!linkedConnId) {
          linkedConnId = await findLinkedConnectionByWebflowItem(connection.id, wfItemIds[0]);
          if (linkedConnId) {
            logger.debug(`Auto-detected linked connection for reference field "${mapping.airtable_field_name}"`, { linkedConnId });
          }
        }
        if (!linkedConnId) {
          logger.warn(`No linked connection found for reference field "${mapping.airtable_field_name}" — skipping field`, { wfItemIds });
          continue; // no match found — skip to avoid invalid IDs
        }

        // Airtable's write API expects plain record ID strings for multipleRecordLinks.
        // (The object format { id: 'recXXX' } is what Airtable returns on read — not what it accepts on write.)
        const atIds = await getMappedAirtableRecordIds(linkedConnId, wfItemIds);
        if (atIds.length === 0) {
          logger.warn(
            `Reference resolution produced no mapped Airtable IDs for field "${mapping.airtable_field_name}" — skipping field to preserve existing data`,
            { linkedConnId, wfItemIds }
          );
          continue;
        }

        converted = atIds; // ["recXXX", "recYYY"] — plain string array
      } else {
        converted = convertWebflowToAirtable(rawValue, mapping);
      }

      fields[mapping.airtable_field_name] = converted;
    }

    // ── Resolve create vs update early so we can build all metadata at once ──
    const existingMap = await getRecordMapping(connection.id, undefined, item.id);
    const recordAction = existingMap ? 'updated' : 'created';

    // ── Metadata fields: embed Webflow item ID + sync time + action directly ──
    // Guard: only write to a metadata field if it isn't already occupied by a
    // regular field mapping (prevents metadata from silently overwriting content).
    if (connection.webflow_id_field && !(connection.webflow_id_field in fields))
      fields[connection.webflow_id_field] = item.id;
    if (connection.sync_time_field && !(connection.sync_time_field in fields))
      fields[connection.sync_time_field] = new Date().toISOString();
    if (connection.action_field && !(connection.action_field in fields) && !options.dryRun && !existingMap) {
      // Only set the initial Webflow status for NEWLY CREATED records.
      // For existing records, leave the action field untouched — the user
      // may have set a pending command (Draft, Publish, etc.) that will be
      // processed in the action-command phase after the content sync.
      const actionLabel = item.isArchived ? 'Re: Item archived'
                        : item.isDraft    ? 'Re: Item drafted'
                        :                   'Re: Item published';
      logger.debug(`Writing initial action field for new record (webflow state: ${actionLabel})`, { id: item.id, isDraft: item.isDraft, isArchived: item.isArchived });
      fields[connection.action_field] = actionLabel;
    }

    logger.debug('WF→AT fields to write', {
      id: item.id,
      recordAction,
      fieldKeys: Object.keys(fields),
    });

    if (options.dryRun) {
      return {
        source_id: item.id,
        target_id: existingMap?.airtable_record_id,
        action: recordAction,
      };
    }

    // Ensure the action field singleSelect has the "Re: Item created/updated" choice
    if (connection.action_field && fields[connection.action_field]) {
      try {
        await airtable.ensureSelectChoices(
          connection.airtable_base_id,
          connection.airtable_table_id,
          connection.action_field,
          [fields[connection.action_field] as string]
        );
        logger.debug('ensureSelectChoices done for WF→AT action field');
      } catch (choiceErr) {
        logger.warn('Failed to ensure action field choices (WF→AT)', choiceErr instanceof Error ? choiceErr : undefined);
      }
    }

    let airtableRecordId: string;

    if (existingMap) {
      // Update existing Airtable record
      const updated = await airtable.updateRecords(
        connection.airtable_base_id,
        connection.airtable_table_id,
        [{ id: existingMap.airtable_record_id, fields }]
      );
      airtableRecordId = updated[0].id;
      await upsertRecordMapping(connection.id, airtableRecordId, item.id);
      logger.debug('Updated Airtable record', { webflowId: item.id, airtableId: airtableRecordId });
    } else {
      // Create new Airtable record
      const created = await airtable.createRecords(
        connection.airtable_base_id,
        connection.airtable_table_id,
        [{ fields }]
      );
      airtableRecordId = created[0].id;
      await upsertRecordMapping(connection.id, airtableRecordId, item.id);
      logger.debug('Created Airtable record', { webflowId: item.id, airtableId: airtableRecordId });
    }

    return { source_id: item.id, target_id: airtableRecordId, action: recordAction };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to sync Webflow item to Airtable', { webflowId: item.id, error: message });
    return { source_id: item.id, action: 'failed', error: message };
  }
}

async function deleteAirtableRecord(
  connection: Connection,
  webflowId: string,
  airtableId: string,
  options: SyncOptions
): Promise<SyncRecordResult> {
  try {
    if (!options.dryRun) {
      await airtable.deleteRecords(connection.airtable_base_id, connection.airtable_table_id, [airtableId]);
      await deleteRecordMapping(connection.id, undefined, webflowId);
    }
    logger.debug('Deleted Airtable record', { webflowId, airtableId });
    return { source_id: webflowId, target_id: airtableId, action: 'deleted' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to delete Airtable record', { webflowId, airtableId, error: message });
    return { source_id: webflowId, action: 'failed', error: `Delete failed: ${message}` };
  }
}
