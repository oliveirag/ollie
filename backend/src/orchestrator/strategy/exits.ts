import type { Candle, CandidateSignal } from './types.js';

/**
 * The time stop.
 *
 * Without it Phase 3 can finish its code and still fail its purpose: a
 * sustained paper run in a trending market can end with zero closed trades,
 * and therefore no win rate, no average return, and nothing worth publishing.
 * The crossing rules exit only when the market obliges; this one guarantees
 * every position eventually resolves.
 *
 * It is the deliberate purity drift the Phase 3 plan signs off in decision 3:
 * entries stay a function of OHLCV alone, exits become a function of OHLCV
 * *and* the append-only position record. Replayability survives, because the
 * position record is append-only — the holding at any past moment is
 * reconstructible, so the same bars plus the same record give the same answer.
 *
 * Unlike a crossing, the condition stays true on every later bar. Since the
 * dedupe key carries `barTime`, an exit the owner never got to is proposed
 * again tomorrow rather than lost until the market happens to cross again.
 */
export interface HeldLot {
  /** When the oldest lot for this symbol was opened. */
  openedAt: Date;
  /** The whole position, as a decimal string — exits are never partial. */
  quantity: string;
}

export function evaluateExit(
  symbol: string,
  candles: readonly Candle[],
  lot: HeldLot,
  maxHoldingDays: number,
): CandidateSignal | null {
  // Zero is the off switch. A run that should never time-stop says so, rather
  // than setting a number large enough to hope it never triggers.
  if (maxHoldingDays <= 0) return null;

  // Synthesized gap-fill bars never traded. Counting them would time-stop a
  // position early on any symbol with a hole in its history — the same reason
  // the technical rules drop them before computing anything.
  const bars = candles.filter((candle) => candle.interpolated !== true);
  const latest = bars.at(-1);
  if (!latest) return null;

  const barsHeld = bars.filter((bar) => new Date(bar.t).getTime() > lot.openedAt.getTime()).length;
  if (barsHeld < maxHoldingDays) return null;

  return {
    symbol,
    side: 'sell',
    signalType: 'technical',
    quantity: lot.quantity,
    rule: 'max_holding_period',
    indicators: { barsHeld, maxHoldingDays },
    barTime: latest.t,
    referenceClose: latest.c,
  };
}
