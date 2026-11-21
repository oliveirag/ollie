import { dec } from '../../money.js';
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
    signalType: 'time_stop',
    quantity: lot.quantity,
    rule: 'max_holding_period',
    indicators: { barsHeld, maxHoldingDays },
    barTime: latest.t,
    referenceClose: latest.c,
  };
}

/**
 * The stop loss: close the whole position when a daily close lands a fixed
 * fraction below its average cost.
 *
 * Without it a losing position has no floor. The MACD exit fires only above
 * cost, so a position underwater waits for an RSI overbought cross or the
 * time stop, and over 2019 to 2026 daily bars that let single trades fall
 * 30 to 49% before the time stop closed them.
 *
 * Like the time stop it reads the append-only position record as well as the
 * bars, so it is replayable the same way. It acts on the close, not intraday:
 * the strategy only ever sees daily bars, and the exit fills at the next
 * session's open, so a gap down fills below the stop price. That is the
 * honest version; a resting broker stop order would be a different system.
 *
 * The condition stays true on every later bar while the position is under
 * the stop, so an exit the owner never got to is proposed again tomorrow.
 */
export interface StopPosition {
  /** The whole position, as a decimal string: exits are never partial. */
  quantity: string;
  /** Quantity-weighted entry price of the open lots, decimal string. */
  averageEntryPrice: string;
}

export function evaluateStopLoss(
  symbol: string,
  candles: readonly Candle[],
  position: StopPosition,
  stopLossPct: number | undefined,
): CandidateSignal | null {
  if (!(stopLossPct !== undefined && stopLossPct > 0)) return null;

  const latest = candles.filter((candle) => candle.interpolated !== true).at(-1);
  if (!latest) return null;

  const stopPrice = dec(position.averageEntryPrice).times(dec(1).minus(stopLossPct));
  if (dec(latest.c).greaterThan(stopPrice)) return null;

  return {
    symbol,
    side: 'sell',
    // The API's signal_type has no stop-loss value, and adding one would
    // break decoding in app builds already installed. The rule, the
    // indicators and the thesis all say it is a stop.
    signalType: 'technical',
    quantity: position.quantity,
    rule: 'stop_loss',
    indicators: {
      close: Number(latest.c),
      averageEntryPrice: Number(position.averageEntryPrice),
      stopLossPct,
      stopPrice: stopPrice.toDecimalPlaces(6).toNumber(),
    },
    barTime: latest.t,
    referenceClose: latest.c,
  };
}
