import { Cron } from 'croner';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { sweepAutonomy } from './autonomy.js';
import { runMarkToMarket } from './marks.js';
import { pollOpenOrders } from './orders.js';
import { runPipeline, sweepExpiredSignals } from './pipeline.js';
import { sweepUnpublishedSignals } from './publish.js';
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
  nextRuns(): {
    pipeline: Date | null;
    expiry: Date | null;
    mark: Date | null;
    publish: Date | null;
    orders: Date | null;
    autonomy: Date | null;
  };
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

  // Gated on the kill switch like everything else — see the header of marks.ts
  // for why the exemption the plan proposed was rejected.
  const markJob = new Cron(
    config.markCron,
    { timezone: config.timezone, protect: true, name: 'mark' },
    () => {
      void runMarkToMarket({
        broker: deps.broker,
        config,
        logger,
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      }).catch((error: unknown) => {
        log.error({ err: error }, 'mark-to-market failed');
      });
    },
  );

  // Publishes any filled signal the decision route failed to flip. Not gated
  // on the kill switch — see the header of publish.ts for why.
  const publishJob = new Cron(
    config.publishSweepCron,
    { timezone: config.timezone, protect: true, name: 'publish' },
    () => {
      void sweepUnpublishedSignals({
        logger,
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      }).catch((error: unknown) => {
        log.error({ err: error }, 'publish sweep failed');
      });
    },
  );

  // Phase 5. Reads open live orders back and records fills. Observes, never
  // acts, so it runs with the kill switch on — see orders.ts.
  const ordersJob = new Cron(
    config.orderPollCron,
    { timezone: config.timezone, protect: true, name: 'orders' },
    () => {
      void pollOpenOrders({
        broker: deps.broker,
        logger,
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      }).catch((error: unknown) => {
        log.error({ err: error }, 'order poll failed');
      });
    },
  );

  // Phase 5. Approves signals whose veto window closed, while both halves of
  // the autonomy gate are on and the kill switch is off.
  const autonomyJob = new Cron(
    config.autonomySweepCron,
    { timezone: config.timezone, protect: true, name: 'autonomy' },
    () => {
      void sweepAutonomy({
        broker: deps.broker,
        config,
        logger,
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      }).catch((error: unknown) => {
        log.error({ err: error }, 'autonomy sweep failed');
      });
    },
  );

  log.info(
    {
      pipeline_cron: config.pipelineCron,
      order_poll_cron: config.orderPollCron,
      autonomy_cron: config.autonomySweepCron,
      autonomy_enabled: config.autonomyEnabled,
      mark_cron: config.markCron,
      expiry_cron: config.expirySweepCron,
      publish_cron: config.publishSweepCron,
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
      publishJob.stop();
      ordersJob.stop();
      autonomyJob.stop();
      log.info('scheduler stopped');
    },
    nextRuns() {
      return {
        pipeline: pipelineJob.nextRun(),
        expiry: expiryJob.nextRun(),
        mark: markJob.nextRun(),
        publish: publishJob.nextRun(),
        orders: ordersJob.nextRun(),
        autonomy: autonomyJob.nextRun(),
      };
    },
  };
}
