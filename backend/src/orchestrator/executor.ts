import type { Execution, PrismaClient, Signal, TrackRecord } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { recordExecution } from '../db/executions.js';
import { getAppSettings } from '../db/settings.js';
import { appendTrackRecord } from '../db/trackRecord.js';
import { applySlippage } from '../money.js';
import { parseReviewSnapshot } from './reviewSnapshot.js';
import type { BrokerAdapter } from './robinhood/client.js';

/**
 * The execute seam (PRD §3.3).
 *
 * Switching Ollie from paper to live money is meant to be a mode flag rather
 * than a rewrite, so both implementations exist behind one interface from day
 * one — and the live one throws. That is the whole point: the shape is real,
 * the capability is not, and there is no half-built order path to reach by
 * accident.
 */

export interface ExecutionOutcome {
  execution: Execution;
  trackRecord: TrackRecord;
}

export interface Executor {
  execute(signal: Signal): Promise<ExecutionOutcome>;
}

/** The kill switch was on at execution time. Nothing was sent anywhere. */
export class KillSwitchEngagedError extends Error {
  constructor() {
    super('kill switch is engaged; execution refused');
    this.name = 'KillSwitchEngagedError';
  }
}

export class LiveModeNotEnabledError extends Error {
  constructor(reason: string) {
    super(`live execution is not enabled: ${reason}`);
    this.name = 'LiveModeNotEnabledError';
  }
}

export interface ExecutorDeps {
  config: Config;
  logger: Logger;
  prisma?: PrismaClient;
  now?: () => Date;
}

/**
 * Re-read the kill switch immediately before acting, even though the pipeline
 * already checked it. The two checks are seconds to minutes apart — a signal
 * sits pending until the owner taps approve — and the whole purpose of the
 * switch is to stop things that are already in flight.
 */
async function assertKillSwitchOff(deps: ExecutorDeps): Promise<void> {
  if (deps.config.killSwitchEnv) throw new KillSwitchEngagedError();
  const settings = await getAppSettings(deps.prisma);
  if (settings.killSwitch) throw new KillSwitchEngagedError();
}

/**
 * Simulated fills. Never touches the broker — there is no adapter reference in
 * this class, so "approving a paper signal cannot place an order" is a
 * structural fact rather than a rule someone has to remember.
 */
export class PaperExecutor implements Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(signal: Signal): Promise<ExecutionOutcome> {
    await assertKillSwitchOff(this.deps);

    if (signal.executionMode !== 'paper') {
      throw new Error(
        `PaperExecutor refuses signal ${signal.id}: execution_mode is ${signal.executionMode}`,
      );
    }

    const snapshot = parseReviewSnapshot(signal.reviewSnapshot);
    const quantity = signal.quantity.toString();

    // Slippage is applied against the trader in both directions, so paper
    // results never flatter the strategy (PRD §11).
    const fillPrice = applySlippage(
      snapshot.estimated_price,
      signal.side,
      this.deps.config.slippageBps,
    );
    const filledAt = (this.deps.now ?? (() => new Date()))();

    const execution = await recordExecution(
      {
        signalId: signal.id,
        mode: 'paper',
        fillPrice,
        quantity,
        filledAt,
        brokerOrderId: null,
      },
      this.deps.prisma,
    );

    const trackRecord = await appendTrackRecord(
      {
        signalId: signal.id,
        entryPrice: fillPrice,
        status: 'open',
        recordedAt: filledAt,
      },
      this.deps.prisma,
    );

    this.deps.logger.info(
      {
        signal_id: signal.id,
        symbol: signal.symbol,
        side: signal.side,
        quantity,
        estimated_price: snapshot.estimated_price,
        fill_price: fillPrice,
        slippage_bps: this.deps.config.slippageBps,
      },
      'paper fill recorded',
    );

    return { execution, trackRecord };
  }
}

/**
 * Live execution, deliberately unreachable in Phases 0-1.
 *
 * Two independent gates must both be open: `app_settings.execution_mode` set
 * to live in the database, and `LIVE_TRADING_ENABLED=true` in the environment.
 * One is flippable at runtime and one requires a deploy, so neither an
 * application bug nor a stray config change can open the path alone.
 *
 * Even with both open this throws, because the body is Phase 5 work: a fresh
 * review re-check, then `placeEquityOrder` with the signal's persisted
 * `ref_id` as the idempotency key.
 */
export class LiveExecutor implements Executor {
  constructor(
    private readonly deps: ExecutorDeps,
    private readonly broker: BrokerAdapter,
  ) {}

  async execute(signal: Signal): Promise<ExecutionOutcome> {
    await assertKillSwitchOff(this.deps);

    if (!this.deps.config.liveTradingEnabled) {
      throw new LiveModeNotEnabledError('LIVE_TRADING_ENABLED is not set');
    }

    const settings = await getAppSettings(this.deps.prisma);
    if (settings.executionMode !== 'live') {
      throw new LiveModeNotEnabledError('app_settings.execution_mode is not live');
    }
    if (signal.executionMode !== 'live') {
      throw new LiveModeNotEnabledError(
        `signal ${signal.id} was created in ${signal.executionMode} mode`,
      );
    }

    void this.broker;
    throw new LiveModeNotEnabledError(
      'the live order path is not implemented until Phase 5, after a track record and legal review',
    );
  }
}

/**
 * Picks the executor for a signal from the mode it was created in. A signal
 * created in paper mode is settled in paper mode even if the account has since
 * been switched to live — the record and its settlement always agree.
 */
export function executorFor(
  signal: Signal,
  deps: ExecutorDeps,
  broker: BrokerAdapter,
): Executor {
  return signal.executionMode === 'live'
    ? new LiveExecutor(deps, broker)
    : new PaperExecutor(deps);
}
