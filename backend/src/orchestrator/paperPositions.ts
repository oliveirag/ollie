import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrisma } from '../db/client.js';
import { listOpenLots } from '../db/trackRecord.js';
import type { Position } from './robinhood/client.js';

/**
 * The paper portfolio, shaped like a broker position list.
 *
 * The risk gate's long-only check asks "how many shares of this symbol can I
 * sell right now". In paper mode the honest answer is not in the brokerage
 * account — paper fills never reach it — but in the append-only track record.
 * Reading the broker there means every paper sell is rejected as
 * `sell_without_position`, so a paper position can be opened and never closed,
 * which is precisely the record Phase 3 exists to accrue.
 *
 * Returning the broker's `Position` shape keeps the gate itself unchanged: the
 * check was always right, only its source was wrong.
 */
export async function paperPositions(prisma: PrismaClient = getPrisma()): Promise<Position[]> {
  const lots = await listOpenLots(prisma);

  const bySymbol = new Map<string, { quantity: Prisma.Decimal; cost: Prisma.Decimal }>();
  for (const lot of lots) {
    const quantity = new Prisma.Decimal(lot.quantity);
    const entry = new Prisma.Decimal(lot.entryPrice);
    const running = bySymbol.get(lot.symbol) ?? {
      quantity: new Prisma.Decimal(0),
      cost: new Prisma.Decimal(0),
    };
    bySymbol.set(lot.symbol, {
      quantity: running.quantity.plus(quantity),
      // Cost, not a running mean: averaging the averages would weight a 1-share
      // lot the same as a 100-share one.
      cost: running.cost.plus(entry.times(quantity)),
    });
  }

  return [...bySymbol.entries()].map(([symbol, { quantity, cost }]) => ({
    symbol,
    quantity: quantity.toString(),
    // Every paper share is sellable. Settlement periods and share holds are
    // broker facts with no simulated counterpart, and inventing one would block
    // exits for a reason that does not exist here.
    sharesAvailableForSells: quantity.toString(),
    averageBuyPrice: quantity.isZero() ? null : cost.dividedBy(quantity).toString(),
  }));
}
