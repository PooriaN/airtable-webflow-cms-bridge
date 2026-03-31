import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../config/database';
import type { Connection, FieldMapping } from '../types';

type ConnectionRow = {
  id: string;
  name: string;
  direction: Connection['direction'] | null;
  airtable_base_id: string;
  airtable_table_id: string;
  airtable_view_id: string | null;
  webflow_site_id: string;
  webflow_collection_id: string;
  action_field: string | null;
  message_field: string | null;
  sync_time_field: string | null;
  webflow_id_field: string | null;
  airtable_id_slug: string | null;
  last_modified_field: string | null;
  cron_schedule: string | null;
  is_active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

type FieldMappingRow = {
  id: string;
  connection_id: string;
  airtable_field_id: string;
  airtable_field_name: string;
  airtable_field_type: FieldMapping['airtable_field_type'];
  webflow_field_id: string;
  webflow_field_slug: string;
  webflow_field_type: FieldMapping['webflow_field_type'];
  is_name_field: boolean;
  is_slug_field: boolean;
  transform: string | null;
  linked_connection_id: string | null;
};

type RecordMapRow = {
  id: string;
  connection_id: string;
  airtable_record_id: string;
  webflow_item_id: string;
  last_synced_at: string;
};

export async function createConnection(
  data: Omit<Connection, 'id' | 'created_at' | 'updated_at' | 'last_synced_at'>
): Promise<Connection> {
  const id = uuidv4();
  const now = new Date().toISOString();

  await query(
    `INSERT INTO connections (
      id, name, direction, airtable_base_id, airtable_table_id, airtable_view_id,
      webflow_site_id, webflow_collection_id, action_field, message_field,
      sync_time_field, webflow_id_field, airtable_id_slug, last_modified_field,
      cron_schedule, is_active, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18
    )`,
    [
      id,
      data.name,
      data.direction ?? null,
      data.airtable_base_id,
      data.airtable_table_id,
      data.airtable_view_id ?? null,
      data.webflow_site_id,
      data.webflow_collection_id,
      data.action_field ?? null,
      data.message_field ?? null,
      data.sync_time_field ?? null,
      data.webflow_id_field ?? null,
      data.airtable_id_slug ?? null,
      data.last_modified_field ?? null,
      data.cron_schedule ?? null,
      data.is_active,
      now,
      now,
    ]
  );

  return (await getConnection(id))!;
}

export async function getConnection(id: string): Promise<Connection | null> {
  const rows = await query<ConnectionRow>('SELECT * FROM connections WHERE id = $1', [id]);
  return rows[0] ? rowToConnection(rows[0]) : null;
}

export async function listConnections(): Promise<Connection[]> {
  const rows = await query<ConnectionRow>('SELECT * FROM connections ORDER BY created_at DESC');
  return rows.map(rowToConnection);
}

export async function updateConnection(id: string, data: Partial<Connection>): Promise<Connection | null> {
  const existing = await getConnection(id);
  if (!existing) return null;

  const updatable = [
    'name',
    'direction',
    'airtable_base_id',
    'airtable_table_id',
    'airtable_view_id',
    'webflow_site_id',
    'webflow_collection_id',
    'action_field',
    'message_field',
    'sync_time_field',
    'webflow_id_field',
    'airtable_id_slug',
    'last_modified_field',
    'cron_schedule',
    'is_active',
    'last_synced_at',
  ] as const;

  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of updatable) {
    if (key in data) {
      values.push(data[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }

  if (sets.length === 0) return existing;

  values.push(new Date().toISOString());
  sets.push(`updated_at = $${values.length}`);
  values.push(id);

  await query(`UPDATE connections SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
  return getConnection(id);
}

export async function deleteConnection(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>('DELETE FROM connections WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

export async function setFieldMappings(
  connectionId: string,
  mappings: Omit<FieldMapping, 'id' | 'connection_id'>[]
): Promise<FieldMapping[]> {
  await withTransaction(async client => {
    await client.query('DELETE FROM field_mappings WHERE connection_id = $1', [connectionId]);

    for (const mapping of mappings) {
      await client.query(
        `INSERT INTO field_mappings (
          id, connection_id, airtable_field_id, airtable_field_name, airtable_field_type,
          webflow_field_id, webflow_field_slug, webflow_field_type,
          is_name_field, is_slug_field, transform, linked_connection_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10, $11, $12
        )`,
        [
          uuidv4(),
          connectionId,
          mapping.airtable_field_id,
          mapping.airtable_field_name,
          mapping.airtable_field_type,
          mapping.webflow_field_id,
          mapping.webflow_field_slug,
          mapping.webflow_field_type,
          mapping.is_name_field,
          mapping.is_slug_field,
          mapping.transform ?? null,
          mapping.linked_connection_id ?? null,
        ]
      );
    }
  });

  return getFieldMappings(connectionId);
}

export async function getFieldMappings(connectionId: string): Promise<FieldMapping[]> {
  const rows = await query<FieldMappingRow>(
    'SELECT * FROM field_mappings WHERE connection_id = $1',
    [connectionId]
  );

  return rows.map(row => ({
    id: row.id,
    connection_id: row.connection_id,
    airtable_field_id: row.airtable_field_id,
    airtable_field_name: row.airtable_field_name,
    airtable_field_type: row.airtable_field_type,
    webflow_field_id: row.webflow_field_id,
    webflow_field_slug: row.webflow_field_slug,
    webflow_field_type: row.webflow_field_type,
    is_name_field: row.is_name_field,
    is_slug_field: row.is_slug_field,
    transform: row.transform ?? undefined,
    linked_connection_id: row.linked_connection_id ?? undefined,
  }));
}

export async function getRecordMapping(
  connectionId: string,
  airtableId?: string,
  webflowId?: string
): Promise<RecordMapRow | undefined> {
  if (airtableId) {
    const rows = await query<RecordMapRow>(
      'SELECT * FROM record_map WHERE connection_id = $1 AND airtable_record_id = $2',
      [connectionId, airtableId]
    );
    return rows[0];
  }

  if (webflowId) {
    const rows = await query<RecordMapRow>(
      'SELECT * FROM record_map WHERE connection_id = $1 AND webflow_item_id = $2',
      [connectionId, webflowId]
    );
    return rows[0];
  }

  return undefined;
}

export async function getAllRecordMappings(connectionId: string): Promise<RecordMapRow[]> {
  return query<RecordMapRow>('SELECT * FROM record_map WHERE connection_id = $1', [connectionId]);
}

export async function upsertRecordMapping(connectionId: string, airtableId: string, webflowId: string): Promise<void> {
  const now = new Date().toISOString();

  await query(
    `INSERT INTO record_map (id, connection_id, airtable_record_id, webflow_item_id, last_synced_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (connection_id, airtable_record_id) DO UPDATE SET
       webflow_item_id = EXCLUDED.webflow_item_id,
       last_synced_at = EXCLUDED.last_synced_at`,
    [uuidv4(), connectionId, airtableId, webflowId, now]
  );
}

export async function deleteRecordMapping(connectionId: string, airtableId?: string, webflowId?: string): Promise<void> {
  if (airtableId) {
    await query('DELETE FROM record_map WHERE connection_id = $1 AND airtable_record_id = $2', [connectionId, airtableId]);
  } else if (webflowId) {
    await query('DELETE FROM record_map WHERE connection_id = $1 AND webflow_item_id = $2', [connectionId, webflowId]);
  }
}

function rowToConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction ?? undefined,
    airtable_base_id: row.airtable_base_id,
    airtable_table_id: row.airtable_table_id,
    airtable_view_id: row.airtable_view_id ?? undefined,
    webflow_site_id: row.webflow_site_id,
    webflow_collection_id: row.webflow_collection_id,
    action_field: row.action_field ?? undefined,
    message_field: row.message_field ?? undefined,
    sync_time_field: row.sync_time_field ?? undefined,
    webflow_id_field: row.webflow_id_field ?? undefined,
    airtable_id_slug: row.airtable_id_slug ?? undefined,
    last_modified_field: row.last_modified_field ?? undefined,
    cron_schedule: row.cron_schedule ?? undefined,
    is_active: row.is_active,
    last_synced_at: row.last_synced_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
