/**
 * Seed a small published feed for the subscriber app's screenshots.
 *
 *   npx tsx scripts/seed-published-feed.ts
 *
 * The subscriber side only ever sees published signals, and a signal is only
 * published once it was approved and filled, so this walks each one through
 * the real path: insert, approve, fill, open or close a lot, publish. The
 * result is deliberately unremarkable, one win, one loss and one position
 * still open, because store screenshots must not suggest a performance the
 * strategy has not shown.
 *
 * Local only, and it refuses to run against anything else: these rows cannot
 * be deleted, and fabricated trades in the real record would corrupt the one
 * thing the product publishes.
 */
import { getPrisma } from '../src/db/client.js';
import { recordExecution } from '../src/db/executions.js';
import { insertSignal, publishSignal, transitionSignal } from '../src/db/signals.js';
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

/** n trading-ish days ago at 9:35 ET (13:35 UTC outside DST is close enough). */
function daysAgo(n: number, hourUtc = 14, minute = 35): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - n);
  date.setUTCHours(hourUtc, minute, 0, 0);
  return date;
}

const THESES: Record<string, string> = {
  buy: 'RSI(14) closed below 30 while price held above the 200-day average. Entry per the oversold-in-uptrend rule.',
  sell: 'RSI(14) recovered above 55. Exit per the mean-reversion target.',
};

async function published(
  symbol: string,
  side: 'buy' | 'sell',
  quantity: string,
  price: string,
  at: Date,
  rsi: number,
) {
  const prisma = getPrisma();
  const signal = await insertSignal(
    {
      symbol,
      side,
      signalType: 'technical',
      quantity,
      thesis: THESES[side]!,
      thesisSource: 'fallback_template',
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
    },
    prisma,
  );
  await transitionSignal(signal.id, 'approved', 'approved', { prisma, now: at });
  await recordExecution(
    { signalId: signal.id, mode: 'paper', fillPrice: price, quantity, filledAt: at },
    prisma,
  );
  if (side === 'buy') {
    await appendTrackRecord(
      { signalId: signal.id, entryPrice: price, status: 'open', recordedAt: at },
      prisma,
    );
  }
  await publishSignal(signal.id, { prisma, now: new Date(at.getTime() + 5 * 60_000) });
  return signal;
}

async function main(): Promise<void> {
  assertLocal();
  const prisma = getPrisma();

  const jpm = await published('JPM', 'buy', '2', '301.400000', daysAgo(12), 28.1);
  const jpmExit = await published('JPM', 'sell', '2', '309.900000', daysAgo(6), 57.4);
  await closeLots(
    { signalIds: [jpm.id], exitPrice: '309.900000', closedBySignalId: jpmExit.id, recordedAt: daysAgo(6, 20, 15) },
    prisma,
  );

  const xle = await published('XLE', 'buy', '5', '92.150000', daysAgo(9), 27.6);
  const xleExit = await published('XLE', 'sell', '5', '89.020000', daysAgo(3), 55.8);
  await closeLots(
    { signalIds: [xle.id], exitPrice: '89.020000', closedBySignalId: xleExit.id, recordedAt: daysAgo(3, 20, 15) },
    prisma,
  );

  const aapl = await published('AAPL', 'buy', '3', '228.600000', daysAgo(1), 29.3);
  await appendTrackRecord(
    {
      signalId: aapl.id,
      entryPrice: '228.600000',
      markPrice: '230.100000',
      unrealizedPnl: '4.500000',
      status: 'open',
      recordedAt: daysAgo(1, 21, 15),
    },
    prisma,
  );

  console.log('Seeded a published feed: JPM win, XLE loss, AAPL open.');
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
