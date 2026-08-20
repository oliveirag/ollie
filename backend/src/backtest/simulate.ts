import { dec, applySlippage } from '../money.js';
import { applyRiskCaps, type RiskRejectionReason } from '../orchestrator/risk.js';
import type { RiskConfig } from '../config/index.js';
import type { Position } from '../orchestrator/robinhood/client.js';
import { evaluateExit, evaluateTechnical, requiredBars } from '../orchestrator/strategy/index.js';
import type { Candle, CandidateSignal, SignalRule, StrategyConfig } from '../orchestrator/strategy/index.js';

/**
 * The strategy, replayed over history.
 *
 * This is a measuring instrument, not a second implementation. Every decision
 * it makes is delegated to the same modules production calls — `evaluateTechnical`,
 * `evaluateExit`, `applyRiskCaps`, `applySlippage` — so what it reports is what
 * the deployed pipeline would have done, not what a parallel model of it thinks.
 * Nothing here may encode a rule; if a question cannot be answered by calling
 * production code, the answer belongs in production code first.
 *
 * Three things it deliberately does *not* reproduce, because none of them move
 * the dates a rule fires on:
 *
 * - **The review snapshot and the thesis.** A `review_equity_order` call and an
 *   LLM paragraph are preconditions for a signal *existing*, and both are
 *   unavailable for a bar in 2019. Their absence cannot change which bar a
 *   crossing lands on.
 * - **Broker-side rejections.** `reviewEquityOrder` can fail and drop a
 *   candidate. Unknowable in replay, and rare enough that assuming success is
 *   the honest upper bound rather than a flattering one.
 * - **Intraday everything.** Daily bars are the strategy's whole universe, so
 *   the finest resolution any answer can have is one bar.
 *
 * Where a proxy is unavoidable it is chosen to be conservative:
 *
 * - **Fills land on the next bar's open.** Production evaluates yesterday's
 *   close at 9:35am and executes minutes later, so the bar after the signal is
 *   the one the owner actually trades into — never the signal bar's own close,
 *   which would let the simulation buy at a price the rule needed to exist.
 * - **The risk gate marks at the signal bar's close.** Production asks for a
 *   live quote; the close of the bar the decision was made on is the only
 *   contemporaneous price a replay has.
 */

export interface BacktestInput {
  /** Daily bars per symbol, oldest first. */
  bars: Readonly<Record<string, readonly Candle[]>>;
  strategy: StrategyConfig;
  risk: RiskConfig;
  slippageBps: number;
  /**
   * Fraction of proposed signals the owner approves inside the window; the
   * rest expire. 1 approves every one, which is the upper bound on how much
   * the strategy can do, and the default because it isolates the strategy's
   * behavior from the owner's.
   */
  approvalRate?: number;
  /** Seeds the approval draw, so a run below 1.0 is still reproducible. */
  seed?: number;
}

export interface BacktestTrade {
  symbol: string;
  quantity: string;
  entryBarTime: string;
  entryPrice: string;
  entryRule: SignalRule;
  exitBarTime: string | null;
  exitPrice: string | null;
  exitRule: SignalRule | null;
  realizedPnl: string | null;
  /** Bars the lot was held, entry bar excluded. Null while still open. */
  holdingBars: number | null;
}

export interface BacktestDay {
  /** The bar's own timestamp, so a day is identified the way a signal is. */
  barTime: string;
  /** Lots open at this bar's close, across every symbol. */
  openLots: number;
  /**
   * Whether any symbol had enough history for a rule to fire. Warmup bars are
   * not days the strategy declined to trade — they are days it could not, and
   * counting them against coverage would understate it.
   */
  evaluable: boolean;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  days: BacktestDay[];
  signalsProposed: number;
  /** Approved signals with no later bar to fill against, at the end of the data. */
  unfilled: number;
  /** Signals the owner let expire, when `approvalRate` is below 1. */
  expired: number;
  rejections: Record<RiskRejectionReason, number>;
}

interface Lot {
  symbol: string;
  quantity: string;
  entryPrice: string;
  entryBarTime: string;
  entryRule: SignalRule;
  /** Index into the timeline, for counting bars held. */
  entryDayIndex: number;
}

interface QueuedOrder {
  candidate: CandidateSignal;
}

const NO_REJECTIONS: Record<RiskRejectionReason, number> = {
  symbol_not_allowlisted: 0,
  no_price_available: 0,
  sell_without_position: 0,
  position_size_cap: 0,
  daily_trade_cap: 0,
  total_exposure_cap: 0,
};

export function simulate(input: BacktestInput): BacktestResult {
  const symbols = Object.keys(input.bars).sort();
  const approvalRate = input.approvalRate ?? 1;
  const nextRandom = seededRandom(input.seed ?? 1);

  // One timeline across every symbol, because the risk gate's daily trade cap
  // and total exposure are portfolio-wide: a bar has to be evaluated for all
  // symbols at once or the caps bind in the wrong order.
  const timeline = [...new Set(symbols.flatMap((s) => input.bars[s]!.map((b) => b.t)))].sort();

  const barAt = new Map<string, Map<string, Candle>>();
  for (const symbol of symbols) {
    barAt.set(symbol, new Map(input.bars[symbol]!.map((bar) => [bar.t, bar])));
  }

  const warmup = requiredBars(input.strategy);
  const lots: Lot[] = [];
  const trades: BacktestTrade[] = [];
  const days: BacktestDay[] = [];
  const rejections = { ...NO_REJECTIONS };

  let queued: QueuedOrder[] = [];
  let signalsProposed = 0;
  let unfilled = 0;
  let expired = 0;

  for (const [dayIndex, barTime] of timeline.entries()) {
    // ---- 1. Fill what yesterday proposed --------------------------------
    // Production proposes at 9:35am against yesterday's close and executes
    // minutes later, so an order queued on the previous bar trades into this
    // one's open.
    const carried = queued;
    queued = [];

    for (const order of carried) {
      const bar = barAt.get(order.candidate.symbol)?.get(barTime);
      if (!bar) {
        // No bar for this symbol today — a halt or a listing gap. The order is
        // not carried forward: production's signal would have expired in its
        // 15-minute window, unfilled.
        unfilled += 1;
        continue;
      }

      const fillPrice = applySlippage(bar.o, order.candidate.side, input.slippageBps);

      if (order.candidate.side === 'buy') {
        lots.push({
          symbol: order.candidate.symbol,
          quantity: order.candidate.quantity,
          entryPrice: fillPrice,
          entryBarTime: barTime,
          entryRule: order.candidate.rule,
          entryDayIndex: dayIndex,
        });
        continue;
      }

      closeLotsFifo(order.candidate, fillPrice, barTime, dayIndex, lots, trades);
    }

    // ---- 2. Evaluate the rules on bars through today ---------------------
    const candidates: CandidateSignal[] = [];
    let evaluable = false;

    for (const symbol of symbols) {
      const through = barsThrough(input.bars[symbol]!, barTime);
      if (through.length === 0) continue;
      if (through.length >= warmup) evaluable = true;

      const held = heldQuantity(lots, symbol);
      const { candidate } = evaluateTechnical(
        symbol,
        through,
        input.strategy,
        held === null ? undefined : { openQuantity: held },
      );

      if (candidate) {
        candidates.push(candidate);
        continue;
      }

      // The time stop is a backstop, consulted only when no rule fired —
      // the same precedence the pipeline applies.
      const oldest = oldestLot(lots, symbol);
      if (held !== null && oldest) {
        const timeStop = evaluateExit(
          symbol,
          through,
          { openedAt: new Date(oldest.entryBarTime), quantity: held },
          input.strategy.maxHoldingDays,
        );
        if (timeStop) candidates.push(timeStop);
      }
    }

    if (candidates.length > 0) {
      // ---- 3. Risk gate -------------------------------------------------
      const prices: Record<string, string> = {};
      for (const symbol of symbols) {
        const bar = barAt.get(symbol)?.get(barTime);
        if (bar) prices[symbol] = bar.c;
      }

      const decision = applyRiskCaps({
        candidates,
        account: { positions: positionsFrom(lots), prices },
        // A signal lives 15 minutes and this loop steps a day at a time, so
        // nothing proposed on an earlier bar is still pending on this one.
        pendingSignals: [],
        signalsToday: 0,
        config: input.risk,
      });

      for (const rejection of decision.rejected) rejections[rejection.reason] += 1;

      // ---- 4. The owner decides ----------------------------------------
      for (const candidate of decision.accepted) {
        signalsProposed += 1;
        if (approvalRate < 1 && nextRandom() >= approvalRate) {
          expired += 1;
          continue;
        }
        queued.push({ candidate });
      }
    }

    days.push({ barTime, openLots: lots.length, evaluable });
  }

  // Anything still queued when the data runs out never had a bar to fill on.
  unfilled += queued.length;

  for (const lot of lots) trades.push(openTradeFrom(lot));

  trades.sort((a, b) => a.entryBarTime.localeCompare(b.entryBarTime) || a.symbol.localeCompare(b.symbol));

  return { trades, days, signalsProposed, unfilled, expired, rejections };
}

/**
 * Oldest lot first, up to the signal's quantity — the executor's rule, for the
 * same reason it has one: the exit was sized when it was proposed, so a lot
 * opened after that is not part of what this sell is closing.
 */
function closeLotsFifo(
  candidate: CandidateSignal,
  fillPrice: string,
  barTime: string,
  dayIndex: number,
  lots: Lot[],
  trades: BacktestTrade[],
): void {
  let remaining = dec(candidate.quantity);

  while (remaining.greaterThan(0)) {
    const index = lots.findIndex((lot) => lot.symbol === candidate.symbol);
    if (index === -1) break;

    const lot = lots[index]!;
    if (dec(lot.quantity).greaterThan(remaining)) {
      // Lot boundaries align by construction: an exit is sized to the whole
      // position. If they ever did not, refusing loudly beats writing a
      // partial-lot trade the executor would never have produced.
      throw new Error(
        `exit of ${candidate.quantity} ${candidate.symbol} would split a lot of ${lot.quantity}`,
      );
    }

    lots.splice(index, 1);
    remaining = remaining.minus(lot.quantity);

    trades.push({
      symbol: lot.symbol,
      quantity: lot.quantity,
      entryBarTime: lot.entryBarTime,
      entryPrice: lot.entryPrice,
      entryRule: lot.entryRule,
      exitBarTime: barTime,
      exitPrice: fillPrice,
      exitRule: candidate.rule,
      realizedPnl: dec(fillPrice).minus(lot.entryPrice).times(lot.quantity).toFixed(2),
      holdingBars: dayIndex - lot.entryDayIndex,
    });
  }
}

function openTradeFrom(lot: Lot): BacktestTrade {
  return {
    symbol: lot.symbol,
    quantity: lot.quantity,
    entryBarTime: lot.entryBarTime,
    entryPrice: lot.entryPrice,
    entryRule: lot.entryRule,
    exitBarTime: null,
    exitPrice: null,
    exitRule: null,
    realizedPnl: null,
    holdingBars: null,
  };
}

function barsThrough(bars: readonly Candle[], barTime: string): readonly Candle[] {
  const index = bars.findIndex((bar) => bar.t > barTime);
  return index === -1 ? bars : bars.slice(0, index);
}

/** Total shares held, as the decimal string the strategy expects, or null. */
function heldQuantity(lots: readonly Lot[], symbol: string): string | null {
  const held = lots
    .filter((lot) => lot.symbol === symbol)
    .reduce((sum, lot) => sum.plus(lot.quantity), dec(0));
  return held.greaterThan(0) ? held.toString() : null;
}

function oldestLot(lots: readonly Lot[], symbol: string): Lot | undefined {
  return lots.filter((lot) => lot.symbol === symbol).sort((a, b) => a.entryDayIndex - b.entryDayIndex)[0];
}

function positionsFrom(lots: readonly Lot[]): Position[] {
  const bySymbol = new Map<string, string>();
  for (const lot of lots) {
    bySymbol.set(lot.symbol, dec(bySymbol.get(lot.symbol) ?? 0).plus(lot.quantity).toString());
  }
  return [...bySymbol].map(([symbol, quantity]) => ({
    symbol,
    quantity,
    sharesAvailableForSells: quantity,
    averageBuyPrice: null,
  }));
}

/**
 * A small deterministic generator, so an `approvalRate` below 1 produces the
 * same run every time. `Math.random()` would make the report unreproducible,
 * which is the one property the whole exercise depends on.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
