import { Prisma } from '@prisma/client';

/**
 * Every arithmetic operation on money in this service goes through here.
 *
 * The rule the codebase enforces: prices and quantities are decimal strings
 * everywhere except inside these functions, which use `Prisma.Decimal`
 * (arbitrary precision) and hand back strings. `parseFloat` on a price is a
 * defect — 0.1 + 0.2 is not 0.3, and a fill price that is almost right is
 * wrong in a record that can never be edited.
 *
 * Indicator math is exempt and deliberately uses doubles: RSI and MACD are
 * unitless statistics compared against thresholds, not amounts of money, and
 * they are deterministic for identical inputs either way.
 */

export type Decimal = Prisma.Decimal;

export function dec(value: string | number | Decimal): Decimal {
  return new Prisma.Decimal(value);
}

/** Integer cents, rounded half-up. Used for the risk caps, which are in cents. */
export function toCents(price: string | Decimal): number {
  return dec(price).times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

export function centsToPrice(cents: number): string {
  return dec(cents).dividedBy(100).toFixed(2);
}

/** Notional value of `quantity` shares at `price`, in integer cents. */
export function notionalCents(quantity: string | Decimal, price: string | Decimal): number {
  return dec(quantity)
    .times(dec(price))
    .times(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

/**
 * Whole shares affordable at `price` for a target notional. Floored, never
 * rounded: overshooting the configured order size is the one direction that
 * matters, and whole shares sidestep the broker's fractional-share rules
 * (market orders, regular hours only).
 */
export function sharesForNotional(notionalTargetCents: number, price: string | Decimal): number {
  const priceCents = dec(price).times(100);
  if (priceCents.lessThanOrEqualTo(0)) return 0;
  return dec(notionalTargetCents).dividedBy(priceCents).floor().toNumber();
}

/**
 * Applies a conservative slippage assumption to a reference price: worse for
 * the trader in both directions, so paper results never flatter the strategy
 * (PRD §11).
 */
export function applySlippage(
  price: string | Decimal,
  side: 'buy' | 'sell',
  slippageBps: number,
): string {
  const factor = dec(slippageBps).dividedBy(10_000);
  const multiplier = side === 'buy' ? dec(1).plus(factor) : dec(1).minus(factor);
  return dec(price).times(multiplier).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toFixed(6);
}
