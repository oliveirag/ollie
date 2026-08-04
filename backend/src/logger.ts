import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { getConfig } from './config/index.js';

const isDev = process.env.NODE_ENV !== 'production';

export const logger: Logger = pino({
  level: getConfig().logLevel,
  base: { service: 'ollie-orchestrator' },
  // PRD §11: every strategy input and output is logged, so redaction has to be
  // narrow — only secrets, never market data or decisions.
  redact: {
    paths: [
      'authToken',
      'apiKey',
      '*.authToken',
      '*.apiKey',
      'headers.authorization',
      'req.headers.authorization',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }
    : {}),
});

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
