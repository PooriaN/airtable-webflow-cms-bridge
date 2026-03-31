import { Pool, type PoolClient, type QueryResultRow } from 'pg';

let db: Pool | undefined;
let databaseInitialized = false;
let lastDatabaseError: string | null = null;

export function hasDatabaseConnectionConfig(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

export function getDatabaseStatus(): { configured: boolean; initialized: boolean; error: string | null } {
  return {
    configured: hasDatabaseConnectionConfig(),
    initialized: databaseInitialized,
    error: lastDatabaseError,
  };
}

function getSslConfig(): false | { rejectUnauthorized: false } {
  const sslMode = (process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase();
  return sslMode === 'require' || sslMode === 'true'
    ? { rejectUnauthorized: false }
    : false;
}

function getConnectionString(): string {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    lastDatabaseError = 'DATABASE_URL or POSTGRES_URL is not set';
    databaseInitialized = false;
    throw new Error('DATABASE_URL or POSTGRES_URL is not set');
  }
  return connectionString;
}

export function getDatabase(): Pool {
  if (!db) {
    db = new Pool({
      connectionString: getConnectionString(),
      max: parseInt(process.env.PG_POOL_SIZE || '3', 10),
      ssl: getSslConfig(),
    });
  }

  return db;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getDatabase().query<T>(text, params);
  return result.rows;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDatabase().connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase(): Promise<void> {
  try {
    const pool = getDatabase();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        direction TEXT CHECK(direction IN ('airtable_to_webflow', 'webflow_to_airtable')),
        airtable_base_id TEXT NOT NULL,
        airtable_table_id TEXT NOT NULL,
        airtable_view_id TEXT,
        webflow_site_id TEXT NOT NULL,
        webflow_collection_id TEXT NOT NULL,
        action_field TEXT,
        message_field TEXT,
        sync_time_field TEXT,
        webflow_id_field TEXT,
        airtable_id_slug TEXT,
        last_modified_field TEXT,
        cron_schedule TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS field_mappings (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        airtable_field_id TEXT NOT NULL,
        airtable_field_name TEXT NOT NULL,
        airtable_field_type TEXT NOT NULL,
        webflow_field_id TEXT NOT NULL,
        webflow_field_slug TEXT NOT NULL,
        webflow_field_type TEXT NOT NULL,
        is_name_field BOOLEAN NOT NULL DEFAULT FALSE,
        is_slug_field BOOLEAN NOT NULL DEFAULT FALSE,
        transform TEXT,
        linked_connection_id TEXT
      );

      CREATE TABLE IF NOT EXISTS record_map (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        airtable_record_id TEXT NOT NULL,
        webflow_item_id TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        UNIQUE(connection_id, airtable_record_id),
        UNIQUE(connection_id, webflow_item_id)
      );

      CREATE TABLE IF NOT EXISTS sync_logs (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'partial')),
        direction TEXT NOT NULL,
        records_processed INTEGER NOT NULL DEFAULT 0,
        records_created INTEGER NOT NULL DEFAULT 0,
        records_updated INTEGER NOT NULL DEFAULT 0,
        records_deleted INTEGER NOT NULL DEFAULT 0,
        records_failed INTEGER NOT NULL DEFAULT 0,
        errors TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);

    await pool.query('ALTER TABLE field_mappings ADD COLUMN IF NOT EXISTS linked_connection_id TEXT');
    await pool.query('ALTER TABLE connections ADD COLUMN IF NOT EXISTS message_field TEXT');
    await pool.query('ALTER TABLE connections ADD COLUMN IF NOT EXISTS sync_time_field TEXT');
    await pool.query('ALTER TABLE connections ADD COLUMN IF NOT EXISTS webflow_id_field TEXT');
    await pool.query('ALTER TABLE connections ADD COLUMN IF NOT EXISTS airtable_id_slug TEXT');
    await pool.query('ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_modified_field TEXT');
    databaseInitialized = true;
    lastDatabaseError = null;
  } catch (error) {
    databaseInitialized = false;
    lastDatabaseError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.end();
    db = undefined;
  }
  databaseInitialized = false;
}
