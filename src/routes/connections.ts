import { Router } from 'express';
import {
  createConnection,
  getConnection,
  listConnections,
  updateConnection,
  deleteConnection,
  setFieldMappings,
  getFieldMappings,
} from '../models/connection';
import { listSyncLogs } from '../models/sync-log';
import { isCompatible } from '../services/field-mapper';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const connections = await listConnections();
    res.json({ connections });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id as string;
    const connection = await getConnection(id);
    if (!connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    res.json({ connection });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.post('/', async (req, res) => {
  try {
    const connection = await createConnection(req.body);
    res.status(201).json({ connection });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = req.params.id as string;
    const connection = await updateConnection(id, req.body);
    if (!connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    res.json({ connection });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id as string;
    const success = await deleteConnection(id);
    if (!success) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.get('/:id/mappings', async (req, res) => {
  try {
    const id = req.params.id as string;
    const connection = await getConnection(id);
    if (!connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    const mappings = await getFieldMappings(id);
    res.json({ mappings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.put('/:id/mappings', async (req, res) => {
  const id = req.params.id as string;
  const connection = await getConnection(id);
  if (!connection) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  try {
    const requestedMappings = req.body.mappings || [];

    for (const mapping of requestedMappings) {
      if (!isCompatible(mapping.airtable_field_type, mapping.webflow_field_type)) {
        res.status(400).json({
          error: `Incompatible mapping: "${mapping.webflow_field_slug}" (${mapping.webflow_field_type}) cannot map to "${mapping.airtable_field_name}" (${mapping.airtable_field_type})`,
        });
        return;
      }

      const isReferenceField =
        mapping.webflow_field_type === 'Reference' || mapping.webflow_field_type === 'MultiReference';
      if (isReferenceField && mapping.airtable_field_type !== 'multipleRecordLinks') {
        res.status(400).json({
          error: `Reference fields must map to Airtable "Link to another record" fields. "${mapping.webflow_field_slug}" is currently mapped to "${mapping.airtable_field_name}" (${mapping.airtable_field_type})`,
        });
        return;
      }
    }

    const mappings = await setFieldMappings(id, requestedMappings);
    res.json({ mappings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

router.get('/:id/logs', async (req, res) => {
  try {
    const id = req.params.id as string;
    const connection = await getConnection(id);
    if (!connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const logs = await listSyncLogs(id, limit);
    res.json({ logs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
