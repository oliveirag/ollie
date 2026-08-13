import type { PrismaClient, Signal } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { newRunLogger } from '../logger.js';
import {
  DuplicateSignalError,
  countSignalsSince,
  findExistingDedupeKeys,
  insertSignal,
  listExpiredPendingSignals,
  listPendingSignals,
  transitionSignal,
} from '../db/signals.js';
import { getAppSettings } from '../db/settings.js';
import { listOpenLots } from '../db/trackRecord.js';
import { generateThesis as defaultGenerateThesis } from './anthropic/thesis.js';
import type { ThesisInput, ThesisResult } from './anthropic/thesis.js';
import { paperPositions } from './paperPositions.js';
import { applyRiskCaps, type RiskRejection } from './risk.js';
import type { Notifier } from './push/notify.js';
import { buildReviewSnapshot } from './reviewSnapshot.js';
import type { BrokerAdapter, Candle } from './robinhood/client.js';
import { dedupeKeyFor, evaluateExit, evaluateTechnical, requiredBars } from './strategy/index.js';
import type { CandidateSignal } from './strategy/index.js';

/**
 * generate -> decide -> execute.
 *
 * This module is the "generate" half and the seam itself. Deciding is a human
 * (the CLI in Phase 1, the iOS app in Phase 2) and executing is the executor,
 * so a run of this pipeline can only ever produce *proposals*. Nothing here
 * can move money, and that is enforced by what it has access to: no executor,
 * and a broker interface whose only write method throws.
 *
 * Every dependency is injected so the whole thing runs against a mock broker
 * and a fake clock in tests.
 */

export interface PipelineDeps {
  broker: BrokerAdapter;
  config: Config;
  logger: Logger;
  /** Injected so tests can pin "now" and so nothing here reads a clock twice. */
  clock?: () => Date;
  prisma?: PrismaClient;
  generateThesis?: (input: ThesisInput) => Promise<ThesisResult>;
  /** Absent means no push, which is the default and not an error. */
  notifier?: Notifier;
}

export interface PipelineResult {
  runId: string;
  status: 'completed' | 'halted_kill_switch';
  symbolsEvaluated: number;
  candidates: number;
  duplicatesSkipped: number;
  riskRejections: RiskRejection[];
  reviewFailures: number;
  signals: Signal[];
}

export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const { broker, config } = deps;
  const prisma = deps.prisma;
  const clock = deps.clock ?? (() => new Date());
  const thesisFor = deps.generateThesis ?? defaultGenerateThesis;
  const log = newRunLogger('pipeline', deps.logger);
  const now = clock();

  const empty = (status: PipelineResult['status']): PipelineResult => ({
    runId: log.runId,
    status,
    symbolsEvaluated: 0,
    candidates: 0,
    duplicatesSkipped: 0,
    riskRejections: [],
    reviewFailures: 0,
    signals: [],
  });

  // ---- 1. Kill switch ------------------------------------------------------
  // Two independent switches, either of which halts the run: the database flag
  // (flippable at runtime, from the app in Phase 2) and the environment
  // override (requires a deploy). The executor re-checks both before acting.
  const settings = await getAppSettings(prisma);
  if (config.killSwitchEnv || settings.killSwitch) {
    log.warn(
      { kill_switch_env: config.killSwitchEnv, kill_switch_db: settings.killSwitch },
      'kill switch engaged; no signals will be generated',
    );
    return empty('halted_kill_switch');
  }

  log.info(
    {
      symbols: config.symbolAllowlist,
      execution_mode: settings.executionMode,
      started_at: now.toISOString(),
    },
    'pipeline run started',
  );

  // ---- 2. Fetch ------------------------------------------------------------
  const startTime = new Date(
    now.getTime() - config.candleLookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const rawCandles = await broker.getHistoricals({
    symbols: config.symbolAllowlist,
    startTime,
    interval: 'day',
  });

  // ---- 3. Generate ---------------------------------------------------------
  //
  // Positions are read here, before generation, not at the risk gate where they
  // are also used. The exit rules size a sell to the shares held, so the
  // holding has to be known while candidates are being produced rather than
  // when they are being filtered.
  //
  // The source follows the execution mode, because the two modes hold positions
  // in different places. A paper fill is a track-record row and never reaches
  // the brokerage account, so asking the broker in paper mode reports an empty
  // portfolio: every exit would be sized to nothing and rejected as
  // `sell_without_position`, leaving a paper position that can be opened and
  // never closed.
  const positions =
    settings.executionMode === 'paper' ? await paperPositions(prisma) : await broker.getPositions();
  const heldBySymbol = new Map(positions.map((p) => [p.symbol, p.sharesAvailableForSells]));

  // When each symbol's oldest lot was opened, for the time stop. Paper only:
  // a broker position carries no lot-open date, so in live mode the time stop
  // stays silent rather than guessing an age from data it does not have.
  const openedBySymbol = new Map<string, Date>();
  if (settings.executionMode === 'paper') {
    for (const lot of await listOpenLots(prisma)) {
      const existing = openedBySymbol.get(lot.symbol);
      if (!existing || lot.recordedAt < existing) openedBySymbol.set(lot.symbol, lot.recordedAt);
    }
  }

  const candidates: CandidateSignal[] = [];

  for (const symbol of config.symbolAllowlist) {
    const bars = rawCandles[symbol] ?? [];
    const usable = dropInterpolated(bars);
    const dropped = bars.length - usable.length;

    const held = heldBySymbol.get(symbol);
    const result = evaluateTechnical(
      symbol,
      usable,
      config.strategy,
      held === undefined ? undefined : { openQuantity: held },
    );

    // PRD §11: log every strategy input and output, fired or not. A quiet run
    // has to be explainable from the logs alone.
    log.info(
      {
        symbol,
        bars: usable.length,
        bars_dropped_interpolated: dropped,
        bars_required: requiredBars(config.strategy),
        bar_time: result.barTime,
        indicators: result.indicators,
        skip_reason: result.skipReason,
        rule: result.candidate?.rule ?? null,
      },
      result.candidate ? 'candidate generated' : 'no candidate',
    );

    if (result.candidate) {
      candidates.push(result.candidate);
      continue;
    }

    // The time stop is a backstop, so it is consulted only when no rule fired.
    // A crossing that already proposes an exit does not need a second opinion,
    // and two exit candidates for one position would race each other.
    const openedAt = openedBySymbol.get(symbol);
    if (held !== undefined && openedAt !== undefined) {
      const timeStop = evaluateExit(
        symbol,
        usable,
        { openedAt, quantity: held },
        config.strategy.maxHoldingDays,
      );
      if (timeStop) {
        log.info(
          {
            symbol,
            bar_time: timeStop.barTime,
            rule: timeStop.rule,
            indicators: timeStop.indicators,
          },
          'time stop proposes an exit',
        );
        candidates.push(timeStop);
      }
    }
  }

  if (candidates.length === 0) {
    log.info('pipeline run finished with no candidates');
    return { ...empty('completed'), symbolsEvaluated: config.symbolAllowlist.length };
  }

  // ---- 4. Dedupe -----------------------------------------------------------
  // Cheap pre-filter; the unique constraint on dedupe_key is the race-proof
  // backstop that actually guarantees it.
  const existingKeys = await findExistingDedupeKeys(
    candidates.map(dedupeKeyFor),
    prisma,
  );
  const fresh = candidates.filter((c) => !existingKeys.has(dedupeKeyFor(c)));
  let duplicatesSkipped = candidates.length - fresh.length;

  if (duplicatesSkipped > 0) {
    log.info({ count: duplicatesSkipped }, 'skipped candidates already proposed for this bar');
  }

  // ---- 5. Risk gate --------------------------------------------------------
  const pendingSignals = await listPendingSignals(prisma);

  const pricedSymbols = [
    ...new Set([
      ...config.symbolAllowlist,
      ...positions.map((p) => p.symbol),
      ...pendingSignals.map((s) => s.symbol),
    ]),
  ];
  const quotes = await broker.getQuotes(pricedSymbols);
  const prices = Object.fromEntries(
    Object.entries(quotes).map(([symbol, quote]) => [symbol, quote.lastTradePrice]),
  );

  // "Today" is the UTC day. The scheduler thinks in America/New_York but every
  // stored timestamp is UTC, and a cap that shifts twice a year with daylight
  // saving would be worse than one that is merely arbitrary.
  const signalsToday = await countSignalsSince(startOfUtcDay(now), prisma);

  const decision = applyRiskCaps({
    candidates: fresh,
    account: { positions, prices },
    pendingSignals: pendingSignals.map((s) => ({
      symbol: s.symbol,
      quantity: s.quantity.toString(),
    })),
    signalsToday,
    config: config.risk,
  });

  for (const rejection of decision.rejected) {
    // Rejected candidates are logged, never persisted: `signals` holds what was
    // proposed to the owner, and these never were.
    log.info(
      {
        symbol: rejection.candidate.symbol,
        side: rejection.candidate.side,
        rule: rejection.candidate.rule,
        reason: rejection.reason,
        detail: rejection.detail,
      },
      'candidate rejected by risk gate',
    );
  }

  // ---- 6-8. Review, thesis, persist ---------------------------------------
  const signals: Signal[] = [];
  let reviewFailures = 0;

  for (const candidate of decision.accepted) {
    // No snapshot, no signal. The PRD makes the pre-trade review a precondition
    // for a signal existing at all, so a failure here drops the candidate
    // rather than producing a signal with a gap where its evidence should be.
    let review;
    try {
      review = await broker.reviewEquityOrder({
        symbol: candidate.symbol,
        side: candidate.side,
        quantity: candidate.quantity,
        type: 'market',
      });
    } catch (error) {
      reviewFailures += 1;
      log.error(
        { symbol: candidate.symbol, rule: candidate.rule, err: error },
        'pre-trade review failed; candidate dropped',
      );
      continue;
    }

    const snapshot = buildReviewSnapshot(review, candidate, now);
    const warnings = review.alerts.map((alert) => alert.type);

    const thesis = await thesisFor({
      candidate,
      estimatedPrice: review.estimatedPrice,
      reviewWarnings: warnings,
    });

    try {
      const signal = await insertSignal(
        {
          symbol: candidate.symbol,
          side: candidate.side,
          signalType: candidate.signalType,
          quantity: candidate.quantity,
          thesis: thesis.text,
          thesisSource: thesis.source,
          indicators: candidate.indicators,
          reviewSnapshot: snapshot,
          executionMode: settings.executionMode,
          dedupeKey: dedupeKeyFor(candidate),
        },
        prisma,
      );

      signals.push(signal);

      // The Phase 2 notification. Until APNs exists, a pending signal announces
      // itself as a log line — the owner still has to decide, and the expiry
      // sweep will close it out if nobody does.
      log.info(
        {
          signal_id: signal.id,
          symbol: signal.symbol,
          side: signal.side,
          quantity: signal.quantity.toString(),
          rule: candidate.rule,
          estimated_price: review.estimatedPrice,
          review_alerts: warnings,
          thesis_source: thesis.source,
          thesis: thesis.text,
          execution_mode: signal.executionMode,
          expires_at: new Date(
            now.getTime() + config.signalExpiryMinutes * 60_000,
          ).toISOString(),
        },
        'SIGNAL PENDING — awaiting owner decision',
      );

      // Push, after the signal is durable and never in its way.
      //
      // The try/catch is not redundant with the notifier's own error handling.
      // This call sits inside the block that rethrows anything that is not a
      // duplicate, so an implementation that throws — a future notifier, a
      // test double, a bug — would abort the whole run and cost the owner the
      // remaining candidates. The signal above is already committed; nothing
      // that happens here is allowed to matter.
      try {
        await deps.notifier?.notifyNewSignal(signal);
      } catch (error) {
        log.error({ err: error, signal_id: signal.id }, 'push failed; signal is unaffected');
      }
    } catch (error) {
      if (error instanceof DuplicateSignalError) {
        // Another run won the race between the dedupe check and this insert.
        duplicatesSkipped += 1;
        log.info({ dedupe_key: error.dedupeKey }, 'duplicate signal rejected by the database');
        continue;
      }
      throw error;
    }
  }

  log.info(
    {
      candidates: candidates.length,
      signals: signals.length,
      duplicates_skipped: duplicatesSkipped,
      risk_rejections: decision.rejected.length,
      review_failures: reviewFailures,
    },
    'pipeline run finished',
  );

  return {
    runId: log.runId,
    status: 'completed',
    symbolsEvaluated: config.symbolAllowlist.length,
    candidates: candidates.length,
    duplicatesSkipped,
    riskRejections: decision.rejected,
    reviewFailures,
    signals,
  };
}

export interface ExpirySweepDeps {
  config: Config;
  logger: Logger;
  clock?: () => Date;
  prisma?: PrismaClient;
}

/**
 * Expire pending signals the owner never acted on.
 *
 * An expired signal is still a permanent record with a reason attached (PRD
 * §4.2) — the sweep closes the decision, it does not erase the proposal.
 */
export async function sweepExpiredSignals(deps: ExpirySweepDeps): Promise<Signal[]> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const cutoff = new Date(now.getTime() - deps.config.signalExpiryMinutes * 60_000);

  const stale = await listExpiredPendingSignals(cutoff, deps.prisma);
  if (stale.length === 0) return [];

  const log = newRunLogger('expiry', deps.logger);
  const expired: Signal[] = [];

  for (const signal of stale) {
    try {
      const updated = await transitionSignal(
        signal.id,
        'expired',
        `not decided within ${deps.config.signalExpiryMinutes} minutes`,
        { now, ...(deps.prisma ? { prisma: deps.prisma } : {}) },
      );
      expired.push(updated);
      log.info(
        {
          signal_id: signal.id,
          symbol: signal.symbol,
          created_at: signal.createdAt.toISOString(),
        },
        'signal expired',
      );
    } catch (error) {
      // The owner decided it between the query and the update. Their decision
      // wins; expiry is the fallback, not an override.
      log.info({ signal_id: signal.id, err: error }, 'signal was decided before expiry');
    }
  }

  return expired;
}

function dropInterpolated(candles: readonly Candle[]): Candle[] {
  return candles.filter((candle) => candle.interpolated !== true);
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
