import type { Logger } from 'pino';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, type Config } from '../src/config/index.js';
import { insertSignal } from '../src/db/signals.js';
import { setKillSwitch } from '../src/db/settings.js';
import { appendTrackRecord, closeLots, listTrackRecord } from '../src/db/trackRecord.js';
import { runMarkToMarket } from '../src/orchestrator/marks.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import type { Quote } from '../src/orchestrator/robinhood/client.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();
const logger: Logger = pino({ level: 'silent' });

const DAY = new Date('2026-08-13T20:15:00Z');

function quote(symbol: string, price: string): Quote {
  return {
    symbol,
    lastTradePrice: price,
    bidPrice: price,
    askPrice: price,
    previousClose: price,
    officialClose: price,
    hasTraded: true,
    state: 'active',
  };
}

async function seedLot(symbol: string, quantity: string, entryPrice: string) {
  const signal = await insertSignal(
    {
      symbol,
      side: 'buy',
      signalType: 'technical',
      quantity,
      thesis: null,
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: { estimated_price: entryPrice },
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(symbol),
    },
    db,
  );
  await appendTrackRecord(
    { signalId: signal.id, entryPrice, status: 'open', recordedAt: new Date('2026-08-01T00:00:00Z') },
    db,
  );
  return signal;
}

const config = (): Config =>
  buildConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    SYMBOL_ALLOWLIST: 'AAPL',
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv);

const run = (quotes: Record<string, Quote>, now = DAY) =>
  runMarkToMarket({
    broker: new MockBrokerAdapter({ quotes }),
    config: config(),
    prisma: db,
    logger,
    now: () => now,
  });

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('the daily mark', () => {
  it('appends one row per open lot carrying the quote it used', async () => {
    const signal = await seedLot('AAPL', '2', '100.00');

    await run({ AAPL: quote('AAPL', '106.00') });

    const rows = await listTrackRecord(signal.id, db);
    expect(rows).toHaveLength(2);
    const mark = rows.at(-1)!;
    expect(mark.status).toBe('open');
    expect(mark.markPrice?.toString()).toBe('106');
    // (106 - 100) x 2. The curve sums these, so the arithmetic is the product.
    expect(mark.unrealizedPnl?.toString()).toBe('12');
  });

  it('records a loss as a negative mark rather than skipping it', async () => {
    const signal = await seedLot('AAPL', '2', '100.00');

    await run({ AAPL: quote('AAPL', '90.00') });

    expect((await listTrackRecord(signal.id, db)).at(-1)!.unrealizedPnl?.toString()).toBe('-20');
  });

  it('writes only one mark per lot per day however often it runs', async () => {
    const signal = await seedLot('AAPL', '2', '100.00');

    await run({ AAPL: quote('AAPL', '106.00') });
    await run({ AAPL: quote('AAPL', '107.00') });

    // A restart, an overlapping firing, or a manual run must not double-count
    // the lot in that day's curve point. These rows can never be deleted.
    expect(await listTrackRecord(signal.id, db)).toHaveLength(2);
  });

  it('marks again on the next day', async () => {
    const signal = await seedLot('AAPL', '2', '100.00');

    await run({ AAPL: quote('AAPL', '106.00') });
    await run({ AAPL: quote('AAPL', '108.00') }, new Date('2026-08-14T20:15:00Z'));

    expect(await listTrackRecord(signal.id, db)).toHaveLength(3);
  });

  it('leaves a gap rather than guessing when a quote is missing', async () => {
    const signal = await seedLot('AAPL', '2', '100.00');

    const quoteless = {
      ...new MockBrokerAdapter({}),
      getQuotes: async () => ({}),
    } as unknown as MockBrokerAdapter;
    const result = await runMarkToMarket({
      broker: quoteless,
      config: config(),
      prisma: db,
      logger,
      now: () => DAY,
    });

    // A fabricated mark would be indistinguishable from a real one forever.
    // An absent day is honest and the curve reports it as withheld.
    expect(await listTrackRecord(signal.id, db)).toHaveLength(1);
    expect(result.gaps).toEqual(['AAPL']);
  });

  it('stops marking a lot once it is closed', async () => {
    const entry = await seedLot('AAPL', '2', '100.00');
    const exit = await seedLot('AAPL', '2', '110.00');
    await closeLots(
      { signalIds: [entry.id], exitPrice: '110.00', closedBySignalId: exit.id },
      db,
    );

    await run({ AAPL: quote('AAPL', '106.00') });

    // Two rows: the open and the close. No mark after the close.
    const rows = await listTrackRecord(entry.id, db);
    expect(rows.map((r) => r.status)).toEqual(['open', 'closed']);
  });

  it('writes nothing while the database kill switch is engaged', async () => {
    const signal = await seedLot('AAPL', '2', '100.00');
    await setKillSwitch(true, db);

    const result = await run({ AAPL: quote('AAPL', '106.00') });

    // The switch means stop, with no exceptions. Marks are permanent rows, and
    // an incident is exactly when you least want them accruing: a curve gap
    // saying "halted" is more honest than marks taken in a known-bad state.
    expect(await listTrackRecord(signal.id, db)).toHaveLength(1);
    expect(result.status).toBe('halted_kill_switch');
    expect(result.marked).toBe(0);
  });

  it('writes nothing while the environment override is engaged', async () => {
    const signal = await seedLot('AAPL', '2', '100.00');

    const result = await runMarkToMarket({
      broker: new MockBrokerAdapter({ quotes: { AAPL: quote('AAPL', '106.00') } }),
      config: { ...config(), killSwitchEnv: true },
      prisma: db,
      logger,
      now: () => DAY,
    });

    // Both halves, same as the pipeline and the executor. Checking only the
    // database flag would leave the redeploy-required override unenforced here.
    expect(await listTrackRecord(signal.id, db)).toHaveLength(1);
    expect(result.status).toBe('halted_kill_switch');
  });
});
