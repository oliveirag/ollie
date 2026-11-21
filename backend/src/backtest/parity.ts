import { dec } from '../money.js';
import type { RiskConfig } from '../config/index.js';
import { applyRiskCaps } from '../orchestrator/risk.js';
import {
  evaluateExit,
  evaluateStopLoss,
  evaluateTechnical,
  type Candle,
  type CandidateSignal,
  type StrategyConfig,
} from '../orchestrator/strategy/index.js';

/**
 * Parity: would the replay have proposed what production actually proposed?
 *
 * Every backtest number assumes the simulator and the deployed pipeline make
 * the same decisions on the same bars. This checks that assumption against
 * the real record. It walks the production window bar by bar, holding exactly
 * the positions production held (rebuilt from approved signals), asks the
 * production decision functions what they would propose, and lines that up
 * against the signals production wrote.
 *
 * A mismatch is not automatically a bug. Production skips days it did not run
 * (an outage, a holiday), and the risk gate sees live quotes rather than the
 * close. But every mismatch has to have an explanation like that, and the
 * report lists them so each one gets looked at.
 */

/** What the owner API's signal list returns, reduced to what parity reads. */
export interface ProductionSignal {
  created_at: string;
  symbol: string;
  side: 'buy' | 'sell';
  signal_type: string;
  status: string;
  quantity: string;
  /** From the review snapshot; the paper fill is close to it. */
  estimated_price: string | null;
}

export interface ParityRow {
  symbol: string;
  side: 'buy' | 'sell';
  /** The trading day whose bar the decision was made on, YYYY-MM-DD. */
  barDate: string;
  /** Replay's rule, when the replay proposed it. */
  replayRule?: string;
  /** Production's status, when production proposed it. */
  productionStatus?: string;
}

export interface ParityReport {
  matched: ParityRow[];
  /** Production proposed it, the replay would not have. */
  productionOnly: ParityRow[];
  /** The replay would have proposed it, production did not. */
  replayOnly: ParityRow[];
  /** Trading days in the window, for scale. */
  daysChecked: number;
}

export interface ParityInput {
  bars: Readonly<Record<string, readonly Candle[]>>;
  strategy: StrategyConfig;
  risk: RiskConfig;
  signals: readonly ProductionSignal[];
  /** First and last bar dates to check, YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  /** CANDLE_LOOKBACK_DAYS, so the rules see the history production fetched. */
  lookbackDays?: number;
}

const ET = 'America/New_York';

/** YYYY-MM-DD and hour in New York for an instant. */
function easternParts(iso: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * The bar a production signal was decided on. The pipeline runs in the
 * morning against the last completed daily bar, so a signal created during
 * or before a session belongs to the previous trading day's bar; one created
 * after the 16:00 close can already see that day's bar.
 */
export function decisionBarDate(createdAt: string, tradingDays: readonly string[]): string | null {
  const { date, hour } = easternParts(createdAt);
  const includeToday = hour >= 16;
  let found: string | null = null;
  for (const day of tradingDays) {
    if (day < date || (includeToday && day === date)) found = day;
    else break;
  }
  return found;
}

interface HeldLot {
  quantity: string;
  entryPrice: string;
  openedAt: Date;
}

export function checkParity(input: ParityInput): ParityReport {
  const symbols = input.risk.symbolAllowlist.filter((s) => (input.bars[s]?.length ?? 0) > 0);
  const tradingDays = [
    ...new Set(symbols.flatMap((s) => input.bars[s]!.map((bar) => bar.t.slice(0, 10)))),
  ].sort();
  const window = tradingDays.filter((day) => day >= input.from && day <= input.to);

  // Production's signals, each placed on the bar it was decided on.
  const production = input.signals
    .map((signal) => ({ signal, barDate: decisionBarDate(signal.created_at, tradingDays) }))
    .filter((p): p is { signal: ProductionSignal; barDate: string } => p.barDate !== null)
    .sort((a, b) => a.signal.created_at.localeCompare(b.signal.created_at));

  const approved = production.filter((p) => p.signal.status === 'approved');
  const lots = new Map<string, HeldLot[]>();
  let applied = 0;

  const key = (symbol: string, side: string, barDate: string) => `${symbol}:${side}:${barDate}`;
  const replay = new Map<string, ParityRow>();

  for (const day of window) {
    // Fills from signals decided on earlier bars have happened by now.
    while (applied < approved.length && approved[applied]!.barDate < day) {
      const { signal } = approved[applied]!;
      const held = lots.get(signal.symbol) ?? [];
      if (signal.side === 'buy') {
        held.push({
          quantity: signal.quantity,
          entryPrice: signal.estimated_price ?? '0',
          openedAt: new Date(signal.created_at),
        });
        lots.set(signal.symbol, held);
      } else {
        lots.delete(signal.symbol);
      }
      applied += 1;
    }

    const candidates: CandidateSignal[] = [];
    const prices: Record<string, string> = {};

    for (const symbol of symbols) {
      const through = barsThrough(input.bars[symbol]!, day, input.lookbackDays);
      const today = through.at(-1);
      if (!today || today.t.slice(0, 10) !== day) continue;
      prices[symbol] = today.c;

      const held = lots.get(symbol) ?? [];
      const quantity = held.reduce((sum, lot) => sum.plus(lot.quantity), dec(0));
      const holding = quantity.greaterThan(0);
      const averageEntry = holding
        ? held
            .reduce((sum, lot) => sum.plus(dec(lot.entryPrice).times(lot.quantity)), dec(0))
            .dividedBy(quantity)
            .toFixed(6)
        : undefined;

      if (holding) {
        const stop = evaluateStopLoss(
          symbol,
          through,
          { quantity: quantity.toString(), averageEntryPrice: averageEntry! },
          input.strategy.stopLossPct,
        );
        if (stop) {
          candidates.push(stop);
          continue;
        }
      }

      const { candidate } = evaluateTechnical(
        symbol,
        through,
        input.strategy,
        holding ? { openQuantity: quantity.toString(), averageEntryPrice: averageEntry! } : undefined,
      );
      if (candidate) {
        candidates.push(candidate);
        continue;
      }

      if (holding) {
        const openedAt = held.reduce((min, lot) => (lot.openedAt < min ? lot.openedAt : min), held[0]!.openedAt);
        const timeStop = evaluateExit(
          symbol,
          through,
          { openedAt, quantity: quantity.toString() },
          input.strategy.maxHoldingDays,
        );
        if (timeStop) candidates.push(timeStop);
      }
    }

    if (candidates.length === 0) continue;

    const positions = [...lots].map(([symbol, held]) => {
      const quantity = held.reduce((sum, lot) => sum.plus(lot.quantity), dec(0)).toString();
      return { symbol, quantity, sharesAvailableForSells: quantity, averageBuyPrice: null };
    });
    const { accepted } = applyRiskCaps({
      candidates,
      account: { positions, prices },
      pendingSignals: [],
      signalsToday: 0,
      config: { ...input.risk, symbolAllowlist: symbols },
    });
    for (const candidate of accepted) {
      replay.set(key(candidate.symbol, candidate.side, day), {
        symbol: candidate.symbol,
        side: candidate.side,
        barDate: day,
        replayRule: candidate.rule,
      });
    }
  }

  const matched: ParityRow[] = [];
  const productionOnly: ParityRow[] = [];
  const seen = new Set<string>();

  for (const { signal, barDate } of production) {
    if (barDate < input.from || barDate > input.to) continue;
    const k = key(signal.symbol, signal.side, barDate);
    if (seen.has(k)) continue;
    seen.add(k);
    const row: ParityRow = {
      symbol: signal.symbol,
      side: signal.side,
      barDate,
      productionStatus: signal.status,
    };
    const fromReplay = replay.get(k);
    if (fromReplay) matched.push({ ...row, replayRule: fromReplay.replayRule! });
    else productionOnly.push(row);
  }

  const replayOnly = [...replay.entries()].filter(([k]) => !seen.has(k)).map(([, row]) => row);

  return { matched, productionOnly, replayOnly, daysChecked: window.length };
}

function barsThrough(bars: readonly Candle[], day: string, lookbackDays?: number): readonly Candle[] {
  const end = bars.findIndex((bar) => bar.t.slice(0, 10) > day);
  const upTo = end === -1 ? bars : bars.slice(0, end);
  if (lookbackDays === undefined || upTo.length === 0) return upTo;
  const last = new Date(upTo.at(-1)!.t).getTime();
  const cutoff = new Date(last - lookbackDays * 86_400_000).toISOString();
  return upTo.filter((bar) => bar.t >= cutoff);
}
