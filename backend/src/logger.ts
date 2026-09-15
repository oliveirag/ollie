import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { getConfig } from './config/index.js';
import { REDACT } from './redaction.js';

export { REDACT };

const isDev = process.env.NODE_ENV !== 'production';

/**
 * A process logger with the shared redaction rules. The signal service builds
 * its own through this rather than importing `logger` below, because that
 * one reads the orchestrator's config at import time.
 */
export function buildLogger(service: string, level: string): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: [...REDACT.paths], censor: REDACT.censor },
    ...(isDev
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }
      : {}),
  });
}

export const logger: Logger = buildLogger('ollie-orchestrator', getConfig().logLevel);

export type RunLogger = Logger & { runId: string };

/**
 * One child logger per pipeline run. Every line a run emits carries the same
 * run_id, which is how a run is reconstructed from Railway logs after the fact.
 */
export function newRunLogger(kind: string, parent: Logger = logger): RunLogger {
  const runId = randomUUID();
  const child = parent.child({ run_id: runId, run_kind: kind }) as RunLogger;
  child.runId = runId;
  return child;
}
