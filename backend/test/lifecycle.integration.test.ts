import type { Logger } from 'pino';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getSignal, transitionSignal } from '../src/db/signals.js';
import {
  listAllTrackRecordRows,
  listOpenLots,
  listTrackRecord,
} from '../src/db/trackRecord.js';
import { PaperExecutor } from '../src/orchestrator/executor.js';
import { runMarkToMarket } from '../src/orchestrator/marks.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import { computeTrackRecord } from '../src/orchestrator/trackRecordStats.js';
import { closeTestPrisma, resetDatabase, testPrisma } from './helpers/db.js';
import { barsThrough, pipelineConfig as config, quote } from './helpers/factories.js';

/**
 * One trade, start to finish, through every seam Phase 3 added.
 *
 * Each piece has its own unit tests. This exists because the pipeline is about
 * to start writing rows that can never be deleted or corrected, and a bug that
 * only appears when the parts are wired together would be discovered *in the
 * permanent record*. Cheaper to find here.
 */
const db = testPrisma();
const logger: Logger = pino({ level: 'silent' });

const stubThesis = async () => ({
  text: 'Stubbed.',
  source: 'fallback_template' as const,
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('a trade from proposal to published statistics', () => {
  it('opens, marks, exits on the crossing, closes, and reports', async () => {
    const cfg = config();
    const executor = (at: string) =>
      new PaperExecutor({ config: cfg, logger, prisma: db, now: () => new Date(at) });

    // --- Entry: the bullish MACD cross on 2026-07-02 ------------------------
    const entryRun = await runPipeline({
      broker: new MockBrokerAdapter({
        candles: { AAPL: barsThrough('2026-07-02') },
        quotes: { AAPL: quote('AAPL', '308.630000') },
      }),
      config: cfg,
      logger,
      prisma: db,
      clock: () => new Date('2026-07-02T13:35:00Z'),
      generateThesis: stubThesis,
    });

    expect(entryRun.signals).toHaveLength(1);
    const entry = entryRun.signals[0]!;
    expect(entry.side).toBe('buy');
    expect(entry.quantity.toString()).toBe('3');

    await transitionSignal(entry.id, 'approved', 'owner approved', { prisma: db });
    await executor('2026-07-02T13:36:00Z').execute((await getSignal(entry.id, db))!);

    // Buy slippage is against the trader: 308.63 x 1.001.
    const opened = (await listTrackRecord(entry.id, db)).at(-1)!;
    expect(opened.status).toBe('open');
    expect(opened.entryPrice.toString()).toBe('308.93863');

    // --- A day's mark -------------------------------------------------------
    await runMarkToMarket({
      broker: new MockBrokerAdapter({ quotes: { AAPL: quote('AAPL', '320.000000') } }),
      config: cfg,
      logger,
      prisma: db,
      // Monday 2026-07-06: the Friday before was the observed Independence
      // Day closure, which the mark job now skips.
      now: () => new Date('2026-07-06T20:15:00Z'),
    });

    const marked = (await listTrackRecord(entry.id, db)).at(-1)!;
    expect(marked.markPrice?.toString()).toBe('320');
    // (320 - 308.93863) x 3, to six places.
    expect(marked.unrealizedPnl?.toString()).toBe('33.18411');

    // --- Exit: the bearish MACD cross on 2026-07-31 -------------------------
    const exitRun = await runPipeline({
      broker: new MockBrokerAdapter({
        candles: { AAPL: barsThrough('2026-07-31') },
        quotes: { AAPL: quote('AAPL', '330.000000') },
      }),
      config: cfg,
      logger,
      prisma: db,
      clock: () => new Date('2026-07-31T13:35:00Z'),
      generateThesis: stubThesis,
    });

    const exit = exitRun.signals.find((s) => s.side === 'sell');
    expect(exit).toBeDefined();
    // Sized to the position, not the notional — three shares held, three sold.
    expect(exit!.quantity.toString()).toBe('3');

    await transitionSignal(exit!.id, 'approved', 'owner approved', { prisma: db });
    await executor('2026-07-31T13:36:00Z').execute((await getSignal(exit!.id, db))!);

    // --- The lot is closed and attributed -----------------------------------
    const closed = (await listTrackRecord(entry.id, db)).at(-1)!;
    expect(closed.status).toBe('closed');
    expect(closed.closedBySignalId).toBe(exit!.id);
    // Sell slippage is also against the trader: 330 x 0.999 = 329.67.
    expect(closed.exitPrice?.toString()).toBe('329.67');
    // (329.67 - 308.93863) x 3.
    expect(closed.realizedPnl?.toString()).toBe('62.19411');
    expect(await listOpenLots(db)).toHaveLength(0);

    // --- The published numbers ----------------------------------------------
    const stats = computeTrackRecord(await listAllTrackRecordRows(db));
    expect(stats.closedTrades).toBe(1);
    expect(stats.openPositions).toBe(0);
    expect(stats.wins).toBe(1);
    expect(stats.winRate).toBe(1);
    expect(stats.totalRealizedPnl.toNumber()).toBeCloseTo(62.19411, 5);
    // 62.19411 / (308.93863 x 3) = 6.71%.
    expect(stats.averageReturn).toBeCloseTo(0.0671, 4);
  });

  it('exits on the time stop when no crossing obliges', async () => {
    // The reason the time stop exists: a position that never gets a bearish
    // cross would otherwise stay open forever and never enter the record as a
    // closed trade, leaving a sustained run with nothing to publish.
    const cfg = config({ MAX_HOLDING_DAYS: '5' });
    const executor = (at: string) =>
      new PaperExecutor({ config: cfg, logger, prisma: db, now: () => new Date(at) });

    const entryRun = await runPipeline({
      broker: new MockBrokerAdapter({
        candles: { AAPL: barsThrough('2026-07-02') },
        quotes: { AAPL: quote('AAPL', '308.630000') },
      }),
      config: cfg,
      logger,
      prisma: db,
      clock: () => new Date('2026-07-02T13:35:00Z'),
      generateThesis: stubThesis,
    });
    const entry = entryRun.signals[0]!;
    await transitionSignal(entry.id, 'approved', 'ok', { prisma: db });
    await executor('2026-07-02T13:36:00Z').execute((await getSignal(entry.id, db))!);

    // A daily mark in between. Each mark appends a newer open row for the lot,
    // so the holding period must count from the lot's first row, not its latest.
    await runMarkToMarket({
      broker: new MockBrokerAdapter({ quotes: { AAPL: quote('AAPL', '312.000000') } }),
      config: cfg,
      logger,
      prisma: db,
      now: () => new Date('2026-07-09T20:15:00Z'),
    });

    // Five bars on, at a bar where no crossing fires — verified against the
    // fixture, so the time stop is the only thing that can propose this exit.
    const exitRun = await runPipeline({
      broker: new MockBrokerAdapter({
        candles: { AAPL: barsThrough('2026-07-10') },
        quotes: { AAPL: quote('AAPL', '315.000000') },
      }),
      config: cfg,
      logger,
      prisma: db,
      clock: () => new Date('2026-07-10T13:35:00Z'),
      generateThesis: stubThesis,
    });

    const exit = exitRun.signals.find((s) => s.side === 'sell');
    expect(exit).toBeDefined();
    // Labelled honestly: it read the holding period, not an indicator.
    expect(exit!.signalType).toBe('time_stop');
    expect(exit!.quantity.toString()).toBe('3');

    await transitionSignal(exit!.id, 'approved', 'ok', { prisma: db });
    await executor('2026-07-10T13:36:00Z').execute((await getSignal(exit!.id, db))!);

    expect(await listOpenLots(db)).toHaveLength(0);
    expect(computeTrackRecord(await listAllTrackRecordRows(db)).closedTrades).toBe(1);
  });
});
