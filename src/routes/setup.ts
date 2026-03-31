import { Router } from 'express';
import {
  createSessionToken,
  getAuthConfig,
  serializeSessionCookie,
} from '../utils/auth';
import { closeDatabase, initializeDatabase } from '../config/database';
import {
  EDITABLE_SETUP_KEYS,
  type EditableSetupKey,
  getSetupStatus,
  persistSetupValues,
} from '../utils/setup';

const router = Router();

router.get('/status', async (_req, res) => {
  try {
    const status = await getSetupStatus();
    res.json({ status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

router.post('/config', async (req, res) => {
  try {
    const initialStatus = await getSetupStatus();
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    if (!initialStatus.canSaveFromUi) {
      res.status(409).json({
        error: 'In-app setup is only available for local or writable self-hosted environments.',
      });
      return;
    }

    const updates: Partial<Record<EditableSetupKey, string>> = {};
    for (const key of EDITABLE_SETUP_KEYS) {
      if (!(key in body)) continue;

      const rawValue = body[key];
      if (typeof rawValue !== 'string') {
        res.status(400).json({ error: `${key} must be a string` });
        return;
      }

      const trimmed = rawValue.trim();
      if (key !== 'APP_AUTOMATION_TOKEN' && trimmed.length === 0) {
        res.status(400).json({ error: `${key} cannot be empty` });
        return;
      }

      updates[key] = rawValue;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No supported setup values were provided' });
      return;
    }

    await persistSetupValues(updates);
    if ('DATABASE_URL' in updates || 'POSTGRES_URL' in updates) {
      await closeDatabase();
      if ((updates.DATABASE_URL && updates.DATABASE_URL.trim()) || (updates.POSTGRES_URL && updates.POSTGRES_URL.trim()) || process.env.DATABASE_URL || process.env.POSTGRES_URL) {
        try {
          await initializeDatabase();
        } catch {
          // Keep setup route successful so the user can continue correcting env values from the UI.
        }
      }
    }

    const authConfig = getAuthConfig();
    if (authConfig && (res.locals.authMode === 'session' || typeof updates.APP_PASSWORD === 'string')) {
      res.setHeader('Set-Cookie', serializeSessionCookie(createSessionToken(authConfig.sessionSecret), req));
    }

    const status = await getSetupStatus();
    res.json({ ok: true, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

export default router;
