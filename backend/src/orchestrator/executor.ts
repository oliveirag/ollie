import { Prisma, type Execution, type LiveOrder, type PrismaClient, type Signal, type TrackRecord } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { getPrisma, type Db } from '../db/client.js';
import { recordExecution, type RecordExecutionInput } from '../db/executions.js';
import { recordPlacedOrder } from '../db/liveOrders.js';
import { getAppSettings } from '../db/settings.js';
import { appendTrackRecord, closeLots, openLotsForSymbol } from '../db/trackRecord.js';
import { applySlippage } from '../money.js';
import { parseReviewSnapshot } from './reviewSnapshot.js';
import type { BrokerAdapter } from './robinhood/client.js';

/**
 * The execute seam (PRD §3.3).
 *
 * Switching Ollie from paper to live money is meant to be a mode flag rather
 * than a rewrite, so both implementations exist behind one interface. Since
 * Phase 5 the live one places a real order — and only that. A live fill is
 * asynchronous: the executor returns `placed`, and the order poll job
 * (orders.ts) writes the execution row when the broker reports the fill.
 */

export interface FilledOutcome {
  kind: 'filled';
  execution: Execution;
  /** The opened lot on a buy; the first closed lot on a sell. */
  trackRecord: TrackRecord;
  /** Every lot a sell consumed, oldest first. Absent on a buy. */
  closedLots?: TrackRecord[];
}

export interface PlacedOutcome {
  kind: 'placed';
  order: LiveOrder;
}

export type ExecutionOutcome = FilledOutcome | PlacedOutcome;

/**
 * An approved exit had no open lot to close by the time it executed.
 *
 * Surfaced as its own error so the decision route can pre-flight it and answer
 * 409 with the signal still pending, rather than transitioning it to approved
 * and then failing — which would strand it approved with no fill and no way
 * back, the exact hazard the Phase 2 pre-flight doctrine exists to avoid.
 */
export class NoOpenPositionError extends Error {
  constructor(symbol: string) {
    super(`no open ${symbol} lot to close`);
    this.name = 'NoOpenPositionError';
  }
}

export interface ExecuteOptions {
  /**
   * Paper only: the price to fill at, from a review taken at approval time
   * (`paperFillPrice`). Ignored by LiveExecutor, which reviews for itself.
   */
  fillBasis?: string;
}

export interface Executor {
  execute(signal: Signal, options?: ExecuteOptions): Promise<ExecutionOutcome>;
}

/**
 * A paper approval arrived with no fresh price and the proposal-time estimate
 * is too old to stand in for one. Thrown before any write.
 */
export class StaleFillPriceError extends Error {
  constructor(signalId: string, capturedAt: string) {
    super(
      `signal ${signalId}: the review estimate from ${capturedAt} is too old to fill at ` +
        'and no fresh price was supplied',
    );
    this.name = 'StaleFillPriceError';
  }
}

/**
 * The price a paper approval fills at: a fresh `review_equity_order` on the
 * signal's own terms, taken now.
 *
 * A signal can wait hours for a decision now (it lives until the close, see
 * expiry.ts), so the proposal's 09:35 estimate is no longer the price an
 * approval at 14:00 would get. Filling at it would put fills in the paper
 * record that the market never offered. The live path already reviews again
 * before placing; this is the paper half of the same rule.
 *
 * Callers take it *before* transitioning the signal, so a broker that cannot
 * price leaves the signal pending and still decidable instead of approved with
 * no fill. A review is read-only; this cannot place anything.
 */
export async function paperFillPrice(
  signal: Signal,
  broker: Pick<BrokerAdapter, 'reviewEquityOrder'>,
): Promise<string> {
  const review = await broker.reviewEquityOrder({
    symbol: signal.symbol,
    side: signal.side,
    quantity: signal.quantity.toString(),
    type: 'market',
  });
  return review.estimatedPrice;
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

export interface FillInput {
  fillPrice: string;
  quantity: string;
  filledAt: Date;
}

/**
 * Turn a fill into track-record rows: open a lot on a buy, close lots FIFO on
 * a sell. Shared by the paper executor (synchronous fill) and the order poll
 * job (the broker's fill), so both modes write the record the same way.
 *
 * Throws `NoOpenPositionError` on a sell with nothing to close. Callers run
 * this inside the same transaction as the execution row (`recordFill`), so
 * the fill and its lots land together or not at all.
 */
export async function settleLots(
  signal: Signal,
  fill: FillInput,
  prisma?: Db,
): Promise<{ trackRecord: TrackRecord; closedLots?: TrackRecord[] }> {
  if (signal.side === 'sell') {
    const consumed = await selectLotsToClose(signal.symbol, fill.quantity, prisma);
    if (consumed.length === 0) throw new NoOpenPositionError(signal.symbol);
    const closedLots = await closeLots(
      {
        signalIds: consumed,
        exitPrice: fill.fillPrice,
        closedBySignalId: signal.id,
        recordedAt: fill.filledAt,
      },
      prisma,
    );
    return { trackRecord: closedLots[0]!, closedLots };
  }

  const trackRecord = await appendTrackRecord(
    {
      signalId: signal.id,
      entryPrice: fill.fillPrice,
      // Null when the fill matches the signal, so a paper lot's row looks
      // exactly as it did before Phase 5; set when a live order filled short.
      quantity: fill.quantity === signal.quantity.toString() ? null : fill.quantity,
      status: 'open',
      recordedAt: fill.filledAt,
    },
    prisma,
  );
  return { trackRecord };
}

export interface RecordedFill {
  execution: Execution;
  /** Null when a sell filled with no open lot to close (`keepUnmatchedSell`). */
  settled: { trackRecord: TrackRecord; closedLots?: TrackRecord[] } | null;
}

/**
 * Write the execution row and settle its lots in one transaction.
 *
 * Both tables are append-only, so a crash between two separate writes would
 * be permanent: an execution whose lot never opened or closed, and — on the
 * live path, which only settles when no execution exists yet — no later run
 * that would ever repair it. In one transaction either both rows exist or
 * neither does, and the next attempt starts clean.
 *
 * `keepUnmatchedSell` is for the live path: a broker fill is a fact the record
 * must contain even when there is no lot to close (the owner sold by hand), so
 * the execution commits and `settled` is null. The paper path leaves it off,
 * and a sell with nothing to close rolls back without a trace.
 */
export async function recordFill(
  signal: Signal,
  execution: RecordExecutionInput & { filledAt: Date },
  options: { prisma?: PrismaClient; keepUnmatchedSell?: boolean } = {},
): Promise<RecordedFill> {
  const prisma = options.prisma ?? getPrisma();
  return prisma.$transaction(async (tx) => {
    const recorded = await recordExecution(execution, tx);
    const fill = {
      fillPrice: execution.fillPrice,
      quantity: execution.quantity,
      filledAt: execution.filledAt,
    };
    try {
      return { execution: recorded, settled: await settleLots(signal, fill, tx) };
    } catch (error) {
      // Thrown before any write in settleLots, so the transaction is still
      // usable and the execution can commit on its own.
      if (options.keepUnmatchedSell && error instanceof NoOpenPositionError) {
        return { execution: recorded, settled: null };
      }
      throw error;
    }
  });
}

/**
 * Simulated fills. Never touches the broker — there is no adapter reference in
 * this class, so "approving a paper signal cannot place an order" is a
 * structural fact rather than a rule someone has to remember. The fresh price
 * it fills at arrives as a string (`fillBasis`), taken by the caller.
 */
export class PaperExecutor implements Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(signal: Signal, options: ExecuteOptions = {}): Promise<ExecutionOutcome> {
    await assertKillSwitchOff(this.deps);

    if (signal.executionMode !== 'paper') {
      throw new Error(
        `PaperExecutor refuses signal ${signal.id}: execution_mode is ${signal.executionMode}`,
      );
    }

    const snapshot = parseReviewSnapshot(signal.reviewSnapshot);
    const quantity = signal.quantity.toString();
    const filledAt = (this.deps.now ?? (() => new Date()))();

    // The fill basis is the approval-time review when the caller took one
    // (every production caller does). Without one, the proposal's estimate is
    // accepted only while it is as young as the floor window, the age at which
    // it always was the fill price; anything older is refused rather than
    // filled at a price from hours ago.
    let basis = options.fillBasis;
    if (basis === undefined) {
      const ageMs = filledAt.getTime() - new Date(snapshot.captured_at).getTime();
      if (ageMs > this.deps.config.signalExpiryMinutes * 60_000) {
        throw new StaleFillPriceError(signal.id, snapshot.captured_at);
      }
      basis = snapshot.estimated_price;
    }

    // Slippage is applied against the trader in both directions, so paper
    // results never flatter the strategy (PRD §11).
    const fillPrice = applySlippage(basis, signal.side, this.deps.config.slippageBps);

    // A sell is always a close, never a new position. The execution and its
    // lots commit together, so an exit with nothing to close rolls back and
    // leaves no trace at all rather than a fill against a position that does
    // not exist.
    const { execution, settled } = await recordFill(
      signal,
      { signalId: signal.id, mode: 'paper', fillPrice, quantity, filledAt, brokerOrderId: null },
      this.deps.prisma ? { prisma: this.deps.prisma } : {},
    );
    if (!settled) throw new NoOpenPositionError(signal.symbol);

    this.deps.logger.info(
      {
        signal_id: signal.id,
        symbol: signal.symbol,
        side: signal.side,
        quantity,
        estimated_price: snapshot.estimated_price,
        fill_basis: basis,
        fill_basis_source: options.fillBasis === undefined ? 'proposal_review' : 'approval_review',
        fill_price: fillPrice,
        slippage_bps: this.deps.config.slippageBps,
        lots_closed: settled.closedLots?.length ?? 0,
      },
      'paper fill recorded',
    );

    return { kind: 'filled', execution, ...settled };
  }
}

/**
 * Live execution (Phase 5, decision 1).
 *
 * Two independent gates must both be open: `app_settings.execution_mode` set
 * to live in the database, and `LIVE_TRADING_ENABLED=true` in the environment.
 * One is flippable at runtime and one requires a deploy, so neither an
 * application bug nor a stray config change can open the path alone. The
 * decision route adds a third — the per-approval confirmation — before it
 * ever constructs this class.
 *
 * With the gates open: a fresh `review_equity_order` on the same terms (PRD
 * §3.5, review before place, every time), then `place_equity_order` with the
 * signal's `ref_id`, then a `live_orders` row. No execution row is written
 * here: the fill is the broker's to report, and the poll job records it.
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

    // The stored snapshot is the proof a review preceded the signal; parsing
    // it here is what refuses to act on a signal whose evidence is unreadable.
    const snapshot = parseReviewSnapshot(signal.reviewSnapshot);
    const quantity = signal.quantity.toString();

    // The same whole-lot selection the fill will settle against. Checking
    // only that *some* lot exists would place a real sell whose fill then
    // closes nothing, when the oldest lot is bigger than this exit.
    if (signal.side === 'sell') {
      const consumed = await selectLotsToClose(signal.symbol, quantity, this.deps.prisma);
      if (consumed.length === 0) throw new NoOpenPositionError(signal.symbol);
    }

    // Review again, now, on the exact terms about to be sent. The original
    // snapshot is minutes to hours old; this one describes this order.
    const review = await this.broker.reviewEquityOrder({
      symbol: signal.symbol,
      side: signal.side,
      quantity,
      type: 'market',
    });
    if (review.alerts.length > 0) {
      this.deps.logger.warn(
        { signal_id: signal.id, alerts: review.alerts.map((a) => a.type) },
        'broker raised alerts on the execution-time review; placing anyway, the broker decides',
      );
    }

    const placed = await this.broker.placeEquityOrder({
      symbol: signal.symbol,
      side: signal.side,
      quantity,
      type: 'market',
      refId: signal.refId,
    });

    const order = await recordPlacedOrder(
      {
        signalId: signal.id,
        brokerOrderId: placed.brokerOrderId,
        refId: signal.refId,
        state: placed.state,
        raw: placed.raw,
        placedAt: (this.deps.now ?? (() => new Date()))(),
      },
      this.deps.prisma,
    );

    this.deps.logger.warn(
      {
        signal_id: signal.id,
        symbol: signal.symbol,
        side: signal.side,
        quantity,
        proposal_estimate: snapshot.estimated_price,
        execution_estimate: review.estimatedPrice,
        broker_order_id: placed.brokerOrderId,
        state: placed.state,
      },
      'live order placed; awaiting the broker\'s fill',
    );

    return { kind: 'placed', order };
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

/**
 * The lots a sell consumes, oldest first, up to its quantity.
 *
 * Whole lots only (Phase 3 plan, decision 4): a lot that would overshoot the
 * exit's quantity is left open rather than split. Entry sizing is one notional
 * unit and the position cap is 2x that, so a position is at most a couple of
 * lots and partial-exit bookkeeping buys nothing at this scale.
 *
 * FIFO earns its place in exactly one race — a buy on the same symbol approved
 * *after* this exit was proposed. The exit's quantity was fixed at proposal
 * time, so the newer lot is simply not covered and stays open.
 *
 * Exported because every pre-flight (decision route, autonomy sweep,
 * LiveExecutor) must ask the same question the fill will: an empty result
 * means the exit would close nothing, even when some lot is open.
 */
export async function selectLotsToClose(
  symbol: string,
  quantity: string,
  prisma?: Db,
): Promise<string[]> {
  const lots = await openLotsForSymbol(symbol, prisma);
  const wanted = new Prisma.Decimal(quantity);

  const chosen: string[] = [];
  let running = new Prisma.Decimal(0);
  const oldestFirst = [...lots].sort(
    (a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.signalId.localeCompare(b.signalId),
  );
  for (const lot of oldestFirst) {
    const next = running.plus(lot.quantity);
    if (next.greaterThan(wanted)) break;
    chosen.push(lot.signalId);
    running = next;
  }
  return chosen;
}
