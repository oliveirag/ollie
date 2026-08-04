import { notionalCents } from '../money.js';
import type { RiskConfig } from '../config/index.js';
import type { Position } from './robinhood/client.js';
import type { CandidateSignal } from './strategy/index.js';

/**
 * The risk gate. Pure, like the strategy engine, and for the same reason: these
 * caps are the thing standing between a bug upstream and a real order, so they
 * have to be exhaustively testable without a broker or a database.
 *
 * PRD §8 requires these to be enforced from day one even though execution is
 * paper and human-approved. The point is that paper runs exercise the identical
 * guardrails live runs will, so the caps are proven by the time they matter
 * rather than switched on the day real money starts moving.
 */

export type RiskRejectionReason =
  | 'symbol_not_allowlisted'
  | 'no_price_available'
  | 'sell_without_position'
  | 'position_size_cap'
  | 'daily_trade_cap'
  | 'total_exposure_cap';

export interface AccountSnapshot {
  positions: readonly Position[];
  /** Mark price per symbol, decimal strings. Used for all exposure arithmetic. */
  prices: Readonly<Record<string, string>>;
}

/** A pending signal is committed exposure: the owner may still approve it. */
export interface PendingExposure {
  symbol: string;
  quantity: string;
}

export interface RiskInputs {
  candidates: readonly CandidateSignal[];
  account: AccountSnapshot;
  pendingSignals: readonly PendingExposure[];
  /** Signals already proposed in the current UTC day, however they were decided. */
  signalsToday: number;
  config: RiskConfig;
}

export interface RiskRejection {
  candidate: CandidateSignal;
  reason: RiskRejectionReason;
  /** Human-readable specifics, logged verbatim. Rejections are never persisted. */
  detail: string;
}

export interface RiskDecision {
  accepted: CandidateSignal[];
  rejected: RiskRejection[];
}

export function applyRiskCaps(inputs: RiskInputs): RiskDecision {
  const { account, config } = inputs;
  const allowlist = new Set(config.symbolAllowlist);

  const accepted: CandidateSignal[] = [];
  const rejected: RiskRejection[] = [];

  // Candidates are evaluated in a fixed order rather than whatever order they
  // arrived in. Under a binding cap, *which* candidate gets the last remaining
  // slot would otherwise depend on symbol iteration order — a real decision
  // being made by an implementation detail.
  const ordered = [...inputs.candidates].sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || a.rule.localeCompare(b.rule),
  );

  const priceFor = (symbol: string, fallback?: string): string | null =>
    account.prices[symbol] ?? fallback ?? null;

  const sellableBySymbol = new Map<string, number>();
  for (const position of account.positions) {
    sellableBySymbol.set(position.symbol, Number(position.sharesAvailableForSells));
  }

  const openExposureCents = sumExposure(
    account.positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity })),
    account.prices,
  );
  const pendingExposureCents = sumExposure(inputs.pendingSignals, account.prices);

  let committedExposureCents = openExposureCents + pendingExposureCents;
  let acceptedToday = inputs.signalsToday;

  const positionCentsBySymbol = new Map<string, number>();
  for (const position of account.positions) {
    const price = account.prices[position.symbol];
    if (price) {
      positionCentsBySymbol.set(position.symbol, notionalCents(position.quantity, price));
    }
  }

  const reject = (candidate: CandidateSignal, reason: RiskRejectionReason, detail: string) => {
    rejected.push({ candidate, reason, detail });
  };

  for (const candidate of ordered) {
    if (!allowlist.has(candidate.symbol)) {
      reject(
        candidate,
        'symbol_not_allowlisted',
        `${candidate.symbol} is not in the allowlist [${config.symbolAllowlist.join(', ')}]`,
      );
      continue;
    }

    const price = priceFor(candidate.symbol, candidate.referenceClose);
    if (!price) {
      reject(
        candidate,
        'no_price_available',
        `no mark price for ${candidate.symbol}; exposure cannot be evaluated`,
      );
      continue;
    }

    const candidateCents = notionalCents(candidate.quantity, price);

    // Long-only. A sell is only ever an exit, and only for shares that are
    // actually sellable right now — held or unsettled shares are not.
    if (candidate.side === 'sell') {
      const sellable = sellableBySymbol.get(candidate.symbol) ?? 0;
      if (sellable < Number(candidate.quantity)) {
        reject(
          candidate,
          'sell_without_position',
          `${candidate.symbol}: ${sellable} shares sellable, signal wants ${candidate.quantity}`,
        );
        continue;
      }
    }

    if (acceptedToday >= config.maxDailyTrades) {
      reject(
        candidate,
        'daily_trade_cap',
        `${acceptedToday} signals already proposed today, cap is ${config.maxDailyTrades}`,
      );
      continue;
    }

    if (candidate.side === 'buy') {
      const existingCents = positionCentsBySymbol.get(candidate.symbol) ?? 0;
      const resultingCents = existingCents + candidateCents;
      if (resultingCents > config.maxPositionCents) {
        reject(
          candidate,
          'position_size_cap',
          `${candidate.symbol} would reach ${resultingCents} cents, cap is ${config.maxPositionCents}`,
        );
        continue;
      }

      const resultingExposure = committedExposureCents + candidateCents;
      if (resultingExposure > config.maxTotalExposureCents) {
        reject(
          candidate,
          'total_exposure_cap',
          `total exposure would reach ${resultingExposure} cents, cap is ${config.maxTotalExposureCents}`,
        );
        continue;
      }

      committedExposureCents = resultingExposure;
      positionCentsBySymbol.set(candidate.symbol, resultingCents);
    }

    // A sell reduces exposure, so it is not checked against the exposure or
    // position caps — but it still consumes a slot against the daily cap,
    // which limits how often the owner is asked to decide anything at all.
    acceptedToday += 1;
    accepted.push(candidate);
  }

  return { accepted, rejected };
}

function sumExposure(
  holdings: readonly { symbol: string; quantity: string }[],
  prices: Readonly<Record<string, string>>,
): number {
  let total = 0;
  for (const holding of holdings) {
    const price = prices[holding.symbol];
    // A holding with no price is not silently valued at zero — it is skipped,
    // and the candidate that needs that price is rejected separately.
    if (price) total += notionalCents(holding.quantity, price);
  }
  return total;
}
