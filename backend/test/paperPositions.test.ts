import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { insertSignal } from '../src/db/signals.js';
import { appendTrackRecord, closeLots } from '../src/db/trackRecord.js';
import { paperPositions } from '../src/orchestrator/paperPositions.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();

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
  await appendTrackRecord({ signalId: signal.id, entryPrice, status: 'open' }, db);
  return signal;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('paperPositions', () => {
  it('aggregates open lots into one position per symbol', async () => {
    await seedLot('AAPL', '2', '100.00');
    await seedLot('AAPL', '3', '110.00');

    const positions = await paperPositions(db);

    // The risk gate reasons about a symbol's total holding, not lot by lot.
    expect(positions).toHaveLength(1);
    expect(positions[0]?.symbol).toBe('AAPL');
    expect(positions[0]?.quantity).toBe('5');
  });

  it('treats every paper share as sellable', async () => {
    await seedLot('AAPL', '2', '100.00');

    const positions = await paperPositions(db);

    // Settlement and holds are broker facts with no paper equivalent. Reporting
    // anything less than the full holding would block exits for a reason that
    // does not exist in a simulation.
    expect(positions[0]?.sharesAvailableForSells).toBe('2');
  });

  it('reports the size-weighted average entry as the average buy price', async () => {
    await seedLot('AAPL', '1', '100.00');
    await seedLot('AAPL', '3', '200.00');

    const positions = await paperPositions(db);

    // (1x100 + 3x200) / 4 = 175. Weighted, because two lots of different sizes
    // at different prices do not average to their midpoint.
    expect(positions[0]?.averageBuyPrice).toBe('175');
  });

  it('drops a symbol once its lots are closed', async () => {
    const signal = await seedLot('AAPL', '2', '100.00');
    const exit = await insertSignal(
      {
        symbol: 'AAPL',
        side: 'sell',
        signalType: 'technical',
        quantity: '2',
        thesis: null,
        thesisSource: 'llm',
        indicators: {},
        reviewSnapshot: { estimated_price: '110.00' },
        executionMode: 'paper',
        dedupeKey: uniqueDedupeKey('exit'),
      },
      db,
    );
    // A second later than the open. Both rows default to `new Date()`, and in
    // the same millisecond "latest row per signal" falls to the uuid
    // tiebreak — a coin flip, which is not what this test is about.
    await closeLots(
      {
        signalIds: [signal.id],
        exitPrice: '110.00',
        closedBySignalId: exit.id,
        recordedAt: new Date(Date.now() + 1000),
      },
      db,
    );

    expect(await paperPositions(db)).toEqual([]);
  });
});
