import express from 'express';
import cors from 'cors';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import connectionsRouter from './routes/connections';
import syncRouter from './routes/sync';
import discoveryRouter from './routes/discovery';
import setupRouter from './routes/setup';
import { createLogger } from './utils/logger';
import { getDatabaseStatus } from './config/database';
import {
  AUTOMATION_TOKEN_HEADER,
  createSessionToken,
  getAuthConfig,
  getAutomationConfig,
  hasValidSession,
  hasValidAutomationToken,
  isApiRequest,
  isAutomationSyncRequest,
  isProductionLike,
  passwordMatches,
  sendAuthUnavailable,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  wantsHtml,
} from './utils/auth';

const httpLog = createLogger('http');

export function createServer(options?: { includeStatic?: boolean }) {
  const includeStatic = options?.includeStatic ?? true;
  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  const loginShellPath = path.join(publicDir, 'login.html');
  const setupShellPath = path.join(publicDir, 'setup.html');
  const appShellPath = path.join(__dirname, '..', 'templates', 'app.html');

  app.use(cors());
  app.use(express.json());

  // HTTP request logging
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api')) {
      httpLog.debug(`${req.method} ${req.path}`);
    }
    next();
  });

  const allowedPaths = new Set(['/login', '/login.html', '/logout', '/api/login', '/api/logout', '/api/health']);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const config = getAuthConfig();
    const automationConfig = getAutomationConfig();
    const pathName = req.path;
    const apiRequest = isApiRequest(req);
    const htmlRequest = wantsHtml(req);
    const setupPath = pathName === '/setup' || pathName === '/setup.html';
    const setupApiPath = pathName === '/api/setup/status' || pathName === '/api/setup/config';
    const loginPath = pathName === '/login' || pathName === '/login.html';
    const logoutPath = pathName === '/logout';
    const automationSyncRequest = isAutomationSyncRequest(req);
    const hasAutomationHeader = Boolean(req.header(AUTOMATION_TOKEN_HEADER));

    if (automationSyncRequest && hasAutomationHeader) {
      if (automationConfig && hasValidAutomationToken(req, automationConfig)) {
        res.locals.authMode = 'automation';
        next();
        return;
      }

      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const authenticated = config ? hasValidSession(req, config) : false;

    if (setupPath || setupApiPath) {
      if (!config) {
        next();
        return;
      }

      if (authenticated) {
        res.locals.authMode = 'session';
        next();
        return;
      }

      if (setupApiPath) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/setup')}`);
      return;
    }

    if (!config) {
      if (!isProductionLike()) {
        next();
        return;
      }

      if (pathName === '/api/health') {
        next();
        return;
      }

      if (htmlRequest && !apiRequest) {
        res.redirect('/setup');
        return;
      }

      sendAuthUnavailable(res, apiRequest || !htmlRequest);
      return;
    }

    if (loginPath && authenticated) {
      res.redirect('/');
      return;
    }

    if (allowedPaths.has(pathName)) {
      next();
      return;
    }

    if (authenticated) {
      res.locals.authMode = 'session';
      next();
      return;
    }

    if (apiRequest) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (logoutPath) {
      next();
      return;
    }

    res.redirect('/login');
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/connections') && !req.path.startsWith('/api/sync')) {
      next();
      return;
    }

    const databaseStatus = getDatabaseStatus();
    if (databaseStatus.initialized) {
      next();
      return;
    }

    const message = databaseStatus.configured
      ? `Database is unavailable${databaseStatus.error ? `: ${databaseStatus.error}` : ''}`
      : 'Database is not configured. Complete setup first.';
    res.status(503).json({ error: message });
  });

  app.post('/api/login', (req, res) => {
    const config = getAuthConfig();
    if (!config) {
      sendAuthUnavailable(res, true);
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!passwordMatches(password, config.password)) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    res.setHeader('Set-Cookie', serializeSessionCookie(createSessionToken(config.sessionSecret), req));
    res.json({ ok: true });
  });

  app.all('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', serializeClearedSessionCookie());
    if (req.method === 'GET' || wantsHtml(req)) {
      res.redirect('/login');
      return;
    }
    res.json({ ok: true });
  });

  if (includeStatic) {
    app.get('/login', (_req, res) => {
      res.sendFile(loginShellPath);
    });

    app.get('/setup', (_req, res) => {
      res.sendFile(setupShellPath);
    });

    app.get('/logout', (_req, res) => {
      res.setHeader('Set-Cookie', serializeClearedSessionCookie());
      res.redirect('/login');
    });
  }

  if (includeStatic) {
    app.use(express.static(publicDir));
  }

  // API routes
  app.use('/api/connections', connectionsRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/discover', discoveryRouter);
  app.use('/api/setup', setupRouter);

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  if (includeStatic) {
    app.get('*', (_req, res) => {
      void import('./utils/setup')
        .then(({ getSetupStatus }) => getSetupStatus())
        .then(status => {
          if (!status.fullyConfigured) {
            res.redirect('/setup');
            return;
          }

          res.sendFile(appShellPath);
        })
        .catch(() => {
          res.sendFile(appShellPath);
        });
    });
  }

  return app;
}
