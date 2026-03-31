import { Router } from 'express';
import { getConnection } from '../models/connection';
import { getSyncLog } from '../models/sync-log';
import { runSync } from '../services/sync-engine';

const router = Router();

const runningSyncs = new Set<string>();

function normalizeRecordIds(rawRecordIds: unknown, direction: string | undefined): string[] | undefined {
  if (!Array.isArray(rawRecordIds)) return undefined;

  const normalized = rawRecordIds
    .filter((value: unknown): value is string => typeof value === 'string')
    .map(value => {
      const trimmed = value.trim();
      if (!trimmed) return '';

      if (direction === 'airtable_to_webflow') {
        const airtableIdMatch = trimmed.match(/\brec[a-zA-Z0-9]{14}\b/);
        return airtableIdMatch?.[0] ?? trimmed;
      }

      return trimmed;
    })
    .filter(Boolean);

  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

router.post('/:connectionId', async (req, res) => {
  let activeConnectionId: string | undefined;
  try {
    const authMode = res.locals.authMode as 'session' | 'automation' | undefined;
    const connectionId = req.params.connectionId as string;
    const connection = await getConnection(connectionId);
    if (!connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    if (!connection.is_active) {
      res.status(400).json({ error: 'Connection is not active' });
      return;
    }

    if (runningSyncs.has(connection.id)) {
      res.status(409).json({ error: 'A sync is already running for this connection' });
      return;
    }

    const direction = req.body.direction as string | undefined;
    if (direction !== 'airtable_to_webflow' && direction !== 'webflow_to_airtable') {
      res.status(400).json({ error: 'direction must be "airtable_to_webflow" or "webflow_to_airtable"' });
      return;
    }

    const dryRun = req.body.dryRun === true;
    const force = req.body.force === true;
    const recordIds = normalizeRecordIds(req.body.recordIds, direction);

    if (authMode === 'automation') {
      if (direction !== 'airtable_to_webflow') {
        res.status(400).json({ error: 'Automation token requests only support "airtable_to_webflow"' });
        return;
      }

      if (!recordIds || recordIds.length === 0) {
        res.status(400).json({ error: 'Automation token requests require a non-empty "recordIds" array' });
        return;
      }

      if (dryRun || force) {
        res.status(400).json({ error: 'Automation token requests do not support "dryRun" or "force"' });
        return;
      }
    }

    runningSyncs.add(connection.id);
    activeConnectionId = connection.id;
    const log = await runSync(connection, { direction, dryRun, recordIds, force });
    const result = await getSyncLog(log.id);
    res.json({ sync: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  } finally {
    if (activeConnectionId) {
      runningSyncs.delete(activeConnectionId);
    }
  }
});

router.get('/status/:logId', async (req, res) => {
  try {
    const logId = req.params.logId as string;
    const log = await getSyncLog(logId);
    if (!log) {
      res.status(404).json({ error: 'Sync log not found' });
      return;
    }
    res.json({ sync: log });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
