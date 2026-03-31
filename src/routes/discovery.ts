import { Router } from 'express';
import * as airtableService from '../services/airtable';
import * as webflowService from '../services/webflow';
import { getCompatibleWebflowTypes, getCompatibleAirtableTypes, AIRTABLE_TO_WEBFLOW_COMPAT, WEBFLOW_TO_AIRTABLE_COMPAT } from '../services/field-mapper';
import type { AirtableFieldType, WebflowFieldType } from '../types';

const router = Router();

// ─── Airtable Discovery ────────────────────────────────────────

router.get('/airtable/bases', async (_req, res) => {
  try {
    const bases = await airtableService.listBases();
    res.json({ bases });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.get('/airtable/bases/:baseId/tables', async (req, res) => {
  try {
    const baseId = req.params.baseId as string;
    const tables = await airtableService.getTableSchema(baseId);
    res.json({ tables });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ─── Airtable Field Creation ────────────────────────────────────

router.post('/airtable/bases/:baseId/tables/:tableId/fields', async (req, res) => {
  try {
    const baseId = req.params.baseId as string;
    const tableId = req.params.tableId as string;
    const { name, type, options } = req.body;
    if (!name || !type) {
      res.status(400).json({ error: 'name and type are required' });
      return;
    }
    const field = await airtableService.createField(baseId, tableId, { name, type, options });
    res.status(201).json({ field });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ─── Webflow Discovery ─────────────────────────────────────────

router.get('/webflow/sites', async (_req, res) => {
  try {
    const sites = await webflowService.listSites();
    res.json({ sites });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.get('/webflow/sites/:siteId/collections', async (req, res) => {
  try {
    const siteId = req.params.siteId as string;
    const collections = await webflowService.listCollections(siteId);
    res.json({ collections });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.get('/webflow/collections/:collectionId', async (req, res) => {
  try {
    const collectionId = req.params.collectionId as string;
    const collection = await webflowService.getCollection(collectionId);
    res.json({ collection });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ─── Webflow Field Creation ─────────────────────────────────────

router.post('/webflow/collections/:collectionId/fields', async (req, res) => {
  try {
    const collectionId = req.params.collectionId as string;
    const { displayName, type, isRequired } = req.body as {
      displayName?: string;
      type?: string;
      isRequired?: boolean;
    };
    if (!displayName || !type) {
      res.status(400).json({ error: 'displayName and type are required' });
      return;
    }
    const field = await webflowService.createField(collectionId, { displayName, type, isRequired });
    res.status(201).json({ field });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ─── Field Compatibility ────────────────────────────────────────

router.get('/compatibility', (_req, res) => {
  res.json({
    airtable_to_webflow: AIRTABLE_TO_WEBFLOW_COMPAT,
    webflow_to_airtable: WEBFLOW_TO_AIRTABLE_COMPAT,
  });
});

router.get('/compatibility/airtable/:fieldType', (req, res) => {
  const fieldType = req.params.fieldType as string;
  const types = getCompatibleWebflowTypes(fieldType as AirtableFieldType);
  res.json({ compatible_webflow_types: types });
});

router.get('/compatibility/webflow/:fieldType', (req, res) => {
  const fieldType = req.params.fieldType as string;
  const types = getCompatibleAirtableTypes(fieldType as WebflowFieldType);
  res.json({ compatible_airtable_types: types });
});

export default router;
