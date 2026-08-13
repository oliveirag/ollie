import { Cron } from 'croner';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { runMarkToMarket } from './marks.js';
import { runPipeline, sweepExpiredSignals } from './pipeline.js';
import type { Notifier } from './push/notify.js';
import type { BrokerAdapter } from './robinhood/client.js';

/**
 * Two cron jobs: propose signals on a schedule, and close out signals nobody
 * decided.
 *
 * Both run with `protect: true`, which skips a firing while the previous one
 * is still running rather than starting a second concurrently. That matters
 * most for the pipeline: two overlapping runs would both pass the in-process
 * dedupe check and race to insert the same signal. The unique constraint would
 * still keep the duplicate out of the database, but only after both had spent
 * broker calls and an LLM call getting there.
 *
 * Cron expressions are interpreted in America/New_York so the schedule tracks
 * market hours through daylight saving; everything persisted stays UTC.
 */

export interface SchedulerDeps {
  broker: BrokerAdapter;
  config: Config;
  logger: Logger;
  /** Absent means no push; the pipeline is unaffected either way. */
  notifier?: Notifier;
  prisma?: PrismaClient;
}

export interface RunningScheduler {
  stop(): void;
  /** Next fire times, for the startup log. */
  nextRuns(): { pipeline: Date | null; expiry: Date | null; mark: Date | null };
}

export function startScheduler(deps: SchedulerDeps): RunningScheduler {
  const { config, logger } = deps;
  const log = logger.child({ component: 'scheduler' });

  const pipelineJob = new Cron(
    config.pipelineCron,
    { timezone: config.timezone, protect: true, name: 'pipeline' },
    () => {
      void runPipeline({
        broker: deps.broker,
        config,
        logger,
        ...(deps.notifier ? { notifier: deps.notifier } : {}),
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      }).catch((error: unknown) => {
        // A failed run must not take the process down — the next firing is a
        // legitimate recovery, and a crashed scheduler stops the expiry sweep
        // too, which would strand pending signals.
        log.error({ err: error }, 'pipeline run failed');
      });
    },
  );

  const expiryJob = new Cron(
    config.expirySweepCron,
    { timezone: config.timezone, protect: true, name: 'expiry' },
    () => {
      void sweepExpiredSignals({
        config,
        logger,
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      }).catch((error: unknown) => {
        log.error({ err: error }, 'expiry sweep failed');
      });
    },
  );

  // Deliberately not gated on the kill switch, unlike the two jobs above. This
  // one observes rather than acts — see the header of marks.ts. Halting it
  // would leave a permanent hole in the published curve to stop trading that
  // the other two jobs have already stopped.
  const markJob = new Cron(
    config.markCron,
    { timezone: config.timezone, protect: true, name: 'mark' },
    () => {
      void runMarkToMarket({
        broker: deps.broker,
        logger,
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      }).catch((error: unknown) => {
        log.error({ err: error }, 'mark-to-market failed');
      });
    },
  );

  log.info(
    {
      pipeline_cron: config.pipelineCron,
      mark_cron: config.markCron,
      expiry_cron: config.expirySweepCron,
      timezone: config.timezone,
      next_pipeline_run: pipelineJob.nextRun()?.toISOString() ?? null,
    },
    'scheduler started',
  );

  return {
    stop() {
      pipelineJob.stop();
      expiryJob.stop();
      markJob.stop();
      log.info('scheduler stopped');
    },
    nextRuns() {
      return {
        pipeline: pipelineJob.nextRun(),
        expiry: expiryJob.nextRun(),
        mark: markJob.nextRun(),
      };
    },
  };
}
