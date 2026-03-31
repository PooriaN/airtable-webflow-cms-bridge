import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database';
import type { SyncLog, SyncError, SyncDirection, SyncStatus } from '../types';

type SyncLogRow = {
  id: string;
  connection_id: string;
  status: SyncStatus;
  direction: SyncDirection;
  records_processed: number;
  records_created: number;
  records_updated: number;
  records_deleted: number;
  records_failed: number;
  errors: string | SyncError[];
  started_at: string;
  completed_at: string | null;
};

export async function createSyncLog(connectionId: string, direction: SyncDirection): Promise<SyncLog> {
  const id = uuidv4();

  await query(
    `INSERT INTO sync_logs (id, connection_id, status, direction, started_at)
     VALUES ($1, $2, 'running', $3, $4)`,
    [id, connectionId, direction, new Date().toISOString()]
  );

  return (await getSyncLog(id))!;
}

export async function updateSyncLog(
  id: string,
  data: {
    status?: SyncStatus;
    records_processed?: number;
    records_created?: number;
    records_updated?: number;
    records_deleted?: number;
    records_failed?: number;
    errors?: SyncError[];
  }
): Promise<SyncLog | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.status !== undefined) { values.push(data.status); fields.push(`status = $${values.length}`); }
  if (data.records_processed !== undefined) { values.push(data.records_processed); fields.push(`records_processed = $${values.length}`); }
  if (data.records_created !== undefined) { values.push(data.records_created); fields.push(`records_created = $${values.length}`); }
  if (data.records_updated !== undefined) { values.push(data.records_updated); fields.push(`records_updated = $${values.length}`); }
  if (data.records_deleted !== undefined) { values.push(data.records_deleted); fields.push(`records_deleted = $${values.length}`); }
  if (data.records_failed !== undefined) { values.push(data.records_failed); fields.push(`records_failed = $${values.length}`); }
  if (data.errors !== undefined) { values.push(JSON.stringify(data.errors)); fields.push(`errors = $${values.length}`); }

  if (data.status === 'completed' || data.status === 'failed' || data.status === 'partial') {
    values.push(new Date().toISOString());
    fields.push(`completed_at = $${values.length}`);
  }

  if (fields.length === 0) return getSyncLog(id);

  values.push(id);
  await query(`UPDATE sync_logs SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
  return getSyncLog(id);
}

export async function getSyncLog(id: string): Promise<SyncLog | null> {
  const rows = await query<SyncLogRow>('SELECT * FROM sync_logs WHERE id = $1', [id]);
  return rows[0] ? rowToSyncLog(rows[0]) : null;
}

export async function listSyncLogs(connectionId: string, limit = 20): Promise<SyncLog[]> {
  const rows = await query<SyncLogRow>(
    'SELECT * FROM sync_logs WHERE connection_id = $1 ORDER BY started_at DESC LIMIT $2',
    [connectionId, limit]
  );
  return rows.map(rowToSyncLog);
}

function rowToSyncLog(row: SyncLogRow): SyncLog {
  return {
    id: row.id,
    connection_id: row.connection_id,
    status: row.status,
    direction: row.direction,
    records_processed: row.records_processed,
    records_created: row.records_created,
    records_updated: row.records_updated,
    records_deleted: row.records_deleted,
    records_failed: row.records_failed,
    errors: typeof row.errors === 'string' ? JSON.parse(row.errors || '[]') as SyncError[] : row.errors,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
  };
}
