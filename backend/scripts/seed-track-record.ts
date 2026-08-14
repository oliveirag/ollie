/**
 * Seed a multi-trade track record for the iOS record screen.
 *
 *   npm run seed:track-record
 *
 * Produces every state the screen has to render honestly: a winning closed
 * trade, a losing one, an open position, and a day withheld because a lot was
 * open with no mark. Without the last two the screen looks correct while its
 * hardest cases go untested.
 *
 * Local only, and it refuses to run against anything else — these rows cannot
 * be deleted, so seeding fabricated trades into the real record would corrupt
 * the one thing the product sells.
 */
import { getPrisma } from '../src/db/client.js';
import { insertSignal } from '../src/db/signals.js';
import { appendTrackRecord, closeLots } from '../src/db/trackRecord.js';
import { getConfig } from '../src/config/index.js';

function assertLocal(): void {
  const url = getConfig().databaseUrl;
  const local = /(@|\/\/)(localhost|127\.0\.0\.1)(:|\/)/.test(url);
  if (!local) {
    throw new Error(
      'refusing to seed: DATABASE_URL does not point at localhost. These rows are permanent.',
    );
  }
}

const day = (n: number) => new Date(Date.UTC(2026, 7, n, 20, 15, 0));

/**
 * A signal with no track-record row.
 *
 * Exit signals must not get one: a sell closes a lot, it does not open one.
 * Giving them an open row — as the first draft of this script did — invents
 * positions that were never held, and since every day then has an unmarked lot,
 * it withholds the entire curve.
 */
async function signalOnly(
  symbol: string,
  side: 'buy' | 'sell',
  quantity: string,
  price: string,
  on: number,
) {
  return insertSignal(
    {
      symbol,
      side,
      signalType: 'technical',
      quantity,
      thesis: `Seeded ${symbol} ${side} for the record screen.`,
      thesisSource: 'fallback_template',
      indicators: { rsi: 28.4, rsiPeriod: 14 },
      reviewSnapshot: {
        schema_version: 1,
        estimated_price: price,
        requested: { symbol, side, quantity, type: 'market' },
        captured_at: day(on).toISOString(),
        raw: { _seed: true },
      },
      executionMode: 'paper',
      dedupeKey: `seed:${symbol}:${side}:${on}:${Date.now()}`,
    },
    getPrisma(),
  );
}

/** An entry: a buy signal *and* the open lot it filled. */
async function entry(symbol: string, quantity: string, price: string, openedOn: number) {
  const signal = await signalOnly(symbol, 'buy', quantity, price, openedOn);
  await appendTrackRecord(
    { signalId: signal.id, entryPrice: price, status: 'open', recordedAt: day(openedOn) },
    getPrisma(),
  );
  return signal;
}

async function mark(signalId: string, entryPrice: string, quantity: string, price: string, on: number) {
  const pnl = (Number(price) - Number(entryPrice)) * Number(quantity);
  await appendTrackRecord(
    {
      signalId,
      entryPrice,
      unrealizedPnl: pnl.toFixed(6),
      markPrice: price,
      status: 'open',
      recordedAt: day(on),
    },
    getPrisma(),
  );
}

async function main(): Promise<void> {
  assertLocal();
  const prisma = getPrisma();

  // A winner: opened the 3rd, marked twice, closed the 6th.
  const winner = await entry('AAPL', '3', '100.000000', 3);
  await mark(winner.id, '100.000000', '3', '104.000000', 4);
  await mark(winner.id, '100.000000', '3', '107.000000', 5);
  const winnerExit = await signalOnly('AAPL', 'sell', '3', '112.000000', 6);
  await closeLots(
    { signalIds: [winner.id], exitPrice: '112.000000', closedBySignalId: winnerExit.id, recordedAt: day(6) },
    prisma,
  );

  // A loser, so the win rate is not a trivially perfect number.
  const loser = await entry('MSFT', '2', '400.000000', 4);
  await mark(loser.id, '400.000000', '2', '388.000000', 5);
  const loserExit = await signalOnly('MSFT', 'sell', '2', '381.000000', 7);
  await closeLots(
    { signalIds: [loser.id], exitPrice: '381.000000', closedBySignalId: loserExit.id, recordedAt: day(7) },
    prisma,
  );

  // Still open, and deliberately unmarked on the 9th: that day has a lot open
  // with no mark, which is exactly the withheld case the screen must surface
  // rather than interpolate across.
  const open = await entry('SPY', '1', '700.000000', 8);
  await mark(open.id, '700.000000', '1', '706.000000', 8);

  console.log('Seeded:');
  console.log('  1 winning closed trade   (AAPL, +36.00)');
  console.log('  1 losing closed trade    (MSFT, -38.00)');
  console.log('  1 open position          (SPY, unmarked after Aug 8 — a withheld day)');
  console.log('\nWin rate should read 50%, and the curve should report at least one withheld day.');
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
