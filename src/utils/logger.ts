/**
 * Lightweight structured logger.
 *
 * Log levels (ascending priority):  debug < info < warn < error
 * Control the minimum level via the LOG_LEVEL environment variable (default: info).
 *
 * Usage:
 *   import { createLogger } from '../utils/logger';
 *   const log = createLogger('sync:MyConnection');
 *   log.info('Starting sync');
 *   log.debug('Record %s skipped', recordId);
 *   log.warn('No linked connection found', { fieldSlug });
 *   log.error('API error', err);
 *
 * Child loggers inherit the parent prefix:
 *   const childLog = log.child('record');  // prefix becomes "sync:MyConnection:record"
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

// ANSI colour codes — only applied when stdout is a real TTY
const C = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
} as const;

const LEVEL_COLOR: Record<Level, string> = {
  debug: C.cyan,
  info:  C.green,
  warn:  C.yellow,
  error: C.red,
};

const isTTY = Boolean(process.stdout.isTTY);

function getMinLevel(): number {
  const env = ((process.env.LOG_LEVEL ?? 'info').toLowerCase()) as Level;
  return LEVELS[env] ?? LEVELS.info;
}

function timestamp(): string {
  // "2026-03-15 22:19:30"
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level: Level, prefix: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < getMinLevel()) return;

  const ts    = timestamp();
  const lvlPad = level.toUpperCase().padEnd(5);
  const tag   = prefix ? ` [${prefix}]` : '';

  let line: string;
  if (isTTY) {
    const col = LEVEL_COLOR[level];
    line = `${C.dim}${ts}${C.reset} ${col}${C.bold}${lvlPad}${C.reset}${C.dim}${tag}${C.reset} ${msg}`;
  } else {
    line = `${ts} ${lvlPad}${tag} ${msg}`;
  }

  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(line + '\n');

  // Print extra context (Error stack or serialised object) indented
  if (extra !== undefined && extra !== null) {
    if (extra instanceof Error) {
      out.write(`  ${extra.stack ?? extra.message}\n`);
    } else if (typeof extra === 'object') {
      out.write(`  ${JSON.stringify(extra)}\n`);
    } else {
      out.write(`  ${String(extra)}\n`);
    }
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info (msg: string, extra?: unknown): void;
  warn (msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  /** Create a child logger that prepends `sub` to this logger's prefix */
  child(sub: string): Logger;
}

export function createLogger(prefix = ''): Logger {
  return {
    debug: (msg, extra) => emit('debug', prefix, msg, extra),
    info:  (msg, extra) => emit('info',  prefix, msg, extra),
    warn:  (msg, extra) => emit('warn',  prefix, msg, extra),
    error: (msg, extra) => emit('error', prefix, msg, extra),
    child: (sub)        => createLogger(prefix ? `${prefix}:${sub}` : sub),
  };
}

/** Root application logger (no prefix) */
export const log = createLogger();
