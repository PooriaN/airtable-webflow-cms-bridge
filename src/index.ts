import dotenv from 'dotenv';
dotenv.config();

import { createServer } from './server';
import { initializeDatabase, closeDatabase } from './config/database';
import cron from 'node-cron';
import { listConnections } from './models/connection';
import { runSync } from './services/sync-engine';
import { createLogger } from './utils/logger';

const log = createLogger('app');
const PORT = parseInt(process.env.PORT || '3456', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap() {
  const app = createServer();
  const server = app.listen(PORT, HOST, () => {
    log.info(`CMS Bridge running at http://${HOST}:${PORT}`);
    log.info(`Dashboard: http://${HOST}:${PORT}`);
    log.info(`API:       http://${HOST}:${PORT}/api`);
  });

  const scheduledTasks = new Map<string, cron.ScheduledTask>();
  let schedulerRefreshTask: cron.ScheduledTask | undefined;

  async function setupScheduledSyncs() {
    for (const task of scheduledTasks.values()) {
      task.stop();
    }
    scheduledTasks.clear();

    const connections = await listConnections();
    for (const conn of connections) {
      if (conn.is_active && conn.cron_schedule && cron.validate(conn.cron_schedule)) {
        const task = cron.schedule(conn.cron_schedule, async () => {
          log.info('Scheduled sync triggered', { name: conn.name, id: conn.id });
          try {
            await runSync(conn, { direction: 'airtable_to_webflow' });
            await runSync(conn, { direction: 'webflow_to_airtable' });
          } catch (err) {
            log.error(
              'Scheduled sync threw an unhandled error',
              err instanceof Error ? err : new Error(String(err))
            );
          }
        });
        scheduledTasks.set(conn.id, task);
        log.info('Scheduled sync registered', { name: conn.name, schedule: conn.cron_schedule });
      }
    }
  }

  async function initializeRuntime() {
    try {
      await initializeDatabase();
      log.info('Database initialized');
      await setupScheduledSyncs();
      if (!schedulerRefreshTask) {
        schedulerRefreshTask = cron.schedule('*/5 * * * *', () => {
          void setupScheduledSyncs().catch(err => {
            log.error(
              'Failed to refresh scheduled syncs',
              err instanceof Error ? err : new Error(String(err))
            );
          });
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn(`Starting in setup mode: ${error.message}`);
    }
  }

  await initializeRuntime();

  function shutdown() {
    log.info('Shutting down...');
    schedulerRefreshTask?.stop();
    for (const task of scheduledTasks.values()) {
      task.stop();
    }
    server.close(() => {
      void closeDatabase()
        .then(() => {
          log.info('Goodbye');
          process.exit(0);
        })
        .catch(err => {
          log.error(
            'Failed to close database cleanly',
            err instanceof Error ? err : new Error(String(err))
          );
          process.exit(1);
        });
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void bootstrap().catch(err => {
  log.error('Failed to start application', err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});
