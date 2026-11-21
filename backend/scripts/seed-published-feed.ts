/**
 * Seed a small published feed for the subscriber app's screenshots.
 *
 *   npx tsx scripts/seed-published-feed.ts
 *
 * The subscriber side only ever sees published signals, and a signal is only
 * published once it was approved and filled, so this walks each one through
 * the real path: insert, approve, fill, open or close a lot, publish, with the
 * daily marks in between. The result is deliberately unremarkable, one win,
 * one loss and one position still open, slightly negative overall, because
 * store screenshots must not suggest a performance the strategy has not shown.
 *
 * Local only, and it refuses to run against anything else: these rows cannot
 * be deleted, and fabricated trades in the real record would corrupt the one
 * thing the product publishes.
 */
import { getPrisma } from '../src/db/client.js';
import { recordExecution } from '../src/db/executions.js';
import { publishSignal, transitionSignal } from '../src/db/signals.js';
import { appendTrackRecord, closeLots } from '../src/db/trackRecord.js';
import { getConfig } from '../src/config/index.js';

function assertLocal(): void {
  const url = getConfig().databaseUrl;
  if (!/(@|\/\/)(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
    throw new Error(
      'refusing to seed: DATABASE_URL does not point at localhost. These rows are permanent.',
    );
  }
}

/**
 * The weekday `n` trading days before today (weekends skipped, holidays not),
 * at the given UTC time. 14:35 UTC is the 9:35 ET proposal and 21:15 UTC the
 * 16:15 ET mark while New York is on standard time.
 */
function tradingDaysAgo(n: number, hourUtc: number, minute: number): Date {
  const date = new Date();
  date.setUTCHours(hourUtc, minute, 0, 0);
  let left = n;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() - 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return date;
}

const proposedAt = (n: number) => tradingDaysAgo(n, 14, 35);
const markedAt = (n: number) => tradingDaysAgo(n, 21, 15);
const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

const THESES: Record<'buy' | 'sell', (symbol: string, rsi: number) => string> = {
  buy: (symbol, rsi) =>
    `${symbol} closed with RSI(14) at ${rsi.toFixed(1)}, below the 30 threshold, while price held ` +
    'above its 200-day average. The oversold-in-uptrend rule calls for an entry at the open.',
  sell: (symbol, rsi) =>
    `${symbol}'s RSI(14) recovered to ${rsi.toFixed(1)}, above the 55 exit level. The mean-reversion ` +
    'rule closes the position.',
};

/**
 * One signal through the real path: proposed at 9:35, approved and filled two
 * minutes later, published by the next five-minute sweep. `created_at` is set
 * explicitly because the default would stamp every row with the time the
 * script ran, and "fired" would then come after "published".
 */
async function published(
  symbol: string,
  side: 'buy' | 'sell',
  quantity: string,
  price: string,
  daysAgo: number,
  rsi: number,
) {
  const prisma = getPrisma();
  const at = proposedAt(daysAgo);
  const signal = await prisma.signal.create({
    data: {
      symbol,
      side,
      signalType: 'technical',
      quantity,
      thesis: THESES[side](symbol, rsi),
      thesisSource: 'llm',
      indicators: { rsi, rsiPeriod: 14 },
      reviewSnapshot: {
        schema_version: 1,
        estimated_price: price,
        requested: { symbol, side, quantity, type: 'market' },
        captured_at: at.toISOString(),
        raw: { _seed: true },
      },
      executionMode: 'paper',
      dedupeKey: `seed-feed:${symbol}:${side}:${at.toISOString()}:${Date.now()}`,
      createdAt: at,
    },
  });
  const filledAt = minutesAfter(at, 2);
  await transitionSignal(signal.id, 'approved', 'approved', { prisma, now: filledAt });
  await recordExecution(
    { signalId: signal.id, mode: 'paper', fillPrice: price, quantity, filledAt },
    prisma,
  );
  if (side === 'buy') {
    await appendTrackRecord(
      { signalId: signal.id, entryPrice: price, status: 'open', recordedAt: filledAt },
      prisma,
    );
  }
  await publishSignal(signal.id, { prisma, now: minutesAfter(at, 5) });
  return signal;
}

/** The 16:15 ET mark on every trading day from `fromDaysAgo` down to `toDaysAgo`. */
async function markDaily(
  signalId: string,
  entryPrice: string,
  quantity: string,
  closes: string[],
  fromDaysAgo: number,
) {
  for (const [i, close] of closes.entries()) {
    const pnl = (Number(close) - Number(entryPrice)) * Number(quantity);
    await appendTrackRecord(
      {
        signalId,
        entryPrice,
        markPrice: close,
        unrealizedPnl: pnl.toFixed(2),
        status: 'open',
        recordedAt: markedAt(fromDaysAgo - i),
      },
      getPrisma(),
    );
  }
}

async function main(): Promise<void> {
  assertLocal();
  const prisma = getPrisma();

  // A win: JPM, 2 shares, 301.40 to 309.90, +17.00 (+2.82%).
  const jpm = await published('JPM', 'buy', '2', '301.40', 12, 28.1);
  await markDaily(jpm.id, '301.40', '2', ['302.15', '300.80', '303.60', '305.95'], 12);
  const jpmExit = await published('JPM', 'sell', '2', '309.90', 8, 57.4);
  await closeLots(
    { signalIds: [jpm.id], exitPrice: '309.90', closedBySignalId: jpmExit.id, recordedAt: minutesAfter(proposedAt(8), 2) },
    prisma,
  );

  // A loss: XLE, 5 shares, 92.15 to 88.40, -18.75 (-4.07%).
  const xle = await published('XLE', 'buy', '5', '92.15', 9, 27.6);
  await markDaily(xle.id, '92.15', '5', ['91.70', '90.95', '91.20', '89.85', '89.10', '88.75'], 9);
  const xleExit = await published('XLE', 'sell', '5', '88.40', 3, 55.8);
  await closeLots(
    { signalIds: [xle.id], exitPrice: '88.40', closedBySignalId: xleExit.id, recordedAt: minutesAfter(proposedAt(3), 2) },
    prisma,
  );

  // Still open: AAPL, 3 shares from 228.60, marked once.
  const aapl = await published('AAPL', 'buy', '3', '228.60', 1, 29.3);
  await markDaily(aapl.id, '228.60', '3', ['229.85'], 1);

  console.log('Seeded a published feed: JPM win, XLE loss, AAPL open. Net realized -1.75.');
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
