import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import pino from 'pino';
import { buildConfig, type Config } from '../src/config/index.js';
import { listExecutions } from '../src/db/executions.js';
import { getSignal, insertSignal, listSignalEvents, transitionSignal } from '../src/db/signals.js';
import { setExecutionMode, setKillSwitch } from '../src/db/settings.js';
import { appendTrackRecord, listTrackRecord } from '../src/db/trackRecord.js';
import {
  KillSwitchEngagedError,
  LiveExecutor,
  LiveModeNotEnabledError,
  PaperExecutor,
} from '../src/orchestrator/executor.js';
import { runPipeline, sweepExpiredSignals } from '../src/orchestrator/pipeline.js';
import { parseReviewSnapshot } from '../src/orchestrator/reviewSnapshot.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import type { Candle, Quote } from '../src/orchestrator/robinhood/client.js';
import type { ThesisResult } from '../src/orchestrator/anthropic/thesis.js';
import { closeTestPrisma, resetDatabase, testPrisma } from './helpers/db.js';
import fixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

const db = testPrisma();
const logger: Logger = pino({ level: 'silent' });

const ALL_BARS: Candle[] = fixture.results[0]!.bars.map((bar) => ({
  t: bar.begins_at,
  o: bar.open_price,
  h: bar.high_price,
  l: bar.low_price,
  c: bar.close_price,
  v: bar.volume,
}));

/** Bars through 2026-07-02, the bar where MACD crosses bullish on real data. */
const THROUGH_BULLISH_CROSS = ALL_BARS.slice(
  0,
  ALL_BARS.findIndex((b) => b.t.startsWith('2026-07-02')) + 1,
);

const NOW = new Date('2026-07-02T13:35:00Z');
const clock = () => NOW;

function config(overrides: Record<string, string> = {}): Config {
  return buildConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    SYMBOL_ALLOWLIST: 'AAPL',
    ORDER_NOTIONAL_CENTS: '100000',
    MAX_POSITION_CENTS: '200000',
    MAX_DAILY_TRADES: '3',
    MAX_TOTAL_EXPOSURE_CENTS: '500000',
    SLIPPAGE_BPS: '10',
    SIGNAL_EXPIRY_MINUTES: '15',
    LOG_LEVEL: 'silent',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

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

function broker(overrides: Partial<ConstructorParameters<typeof MockBrokerAdapter>[0]> = {}) {
  return new MockBrokerAdapter({
    candles: { AAPL: THROUGH_BULLISH_CROSS },
    quotes: { AAPL: quote('AAPL', '308.630000') },
    ...overrides,
  });
}

const stubThesis = async (): Promise<ThesisResult> => ({
  text: 'Stubbed thesis for the integration test.',
  source: 'fallback_template',
});

function deps(overrides: Partial<Parameters<typeof runPipeline>[0]> = {}) {
  return {
    broker: broker(),
    config: config(),
    logger,
    clock,
    prisma: db,
    generateThesis: stubThesis,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('a run that produces a signal', () => {
  it('lands one pending signal with a review snapshot attached', async () => {
    const result = await runPipeline(deps());

    expect(result.status).toBe('completed');
    expect(result.signals).toHaveLength(1);

    const signal = result.signals[0]!;
    expect(signal.symbol).toBe('AAPL');
    expect(signal.side).toBe('buy');
    expect(signal.status).toBe('pending');
    expect(signal.executionMode).toBe('paper');
    // $1,000 notional at a $308.63 close.
    expect(signal.quantity.toString()).toBe('3');

    const snapshot = parseReviewSnapshot(signal.reviewSnapshot);
    expect(snapshot.estimated_price).toBe('308.630000');
    expect(snapshot.requested).toEqual({
      symbol: 'AAPL',
      side: 'buy',
      quantity: '3',
      type: 'market',
    });
    // The broker's own response travels with the derived fields.
    expect(snapshot.raw).toMatchObject({ symbol: 'AAPL', _mock: true });
  });

  it('reviews before it persists, every time', async () => {
    const mock = broker();
    await runPipeline(deps({ broker: mock }));

    expect(mock.callsTo('reviewEquityOrder')).toHaveLength(1);
    expect(mock.callsTo('placeEquityOrder')).toHaveLength(0);
  });

  it('records the indicators the rule actually used', async () => {
    const result = await runPipeline(deps());
    const indicators = result.signals[0]!.indicators as Record<string, number>;

    expect(indicators['macdHistogram']).toBeGreaterThan(0);
    expect(indicators['macdHistogramPrev']).toBeLessThan(0);
    expect(indicators['rsiPeriod']).toBe(14);
  });

  it('carries the thesis and its provenance', async () => {
    const result = await runPipeline(
      deps({
        generateThesis: async () => ({ text: 'Model wrote this.', source: 'llm' as const }),
      }),
    );

    expect(result.signals[0]!.thesis).toBe('Model wrote this.');
    expect(result.signals[0]!.thesisSource).toBe('llm');
  });
});

describe('the kill switch stops everything', () => {
  it('produces nothing when the database flag is on', async () => {
    await setKillSwitch(true, db);
    const mock = broker();

    const result = await runPipeline(deps({ broker: mock }));

    expect(result.status).toBe('halted_kill_switch');
    expect(result.signals).toHaveLength(0);
    // It halts before reaching the broker at all.
    expect(mock.calls).toHaveLength(0);
  });

  it('produces nothing when the environment override is on', async () => {
    const result = await runPipeline(deps({ config: config({ KILL_SWITCH: 'true' }) }));
    expect(result.status).toBe('halted_kill_switch');
  });

  it('blocks execution of an already-pending signal', async () => {
    const { signals } = await runPipeline(deps());
    await transitionSignal(signals[0]!.id, 'approved', 'owner approved', { prisma: db });

    await setKillSwitch(true, db);
    const executor = new PaperExecutor({ config: config(), logger, prisma: db });

    await expect(executor.execute(signals[0]!)).rejects.toThrow(KillSwitchEngagedError);
    expect(await listExecutions(signals[0]!.id, db)).toHaveLength(0);
  });
});

describe('dedupe', () => {
  it('produces nothing new on a second run over the same bar', async () => {
    const first = await runPipeline(deps());
    expect(first.signals).toHaveLength(1);

    const second = await runPipeline(deps());
    expect(second.signals).toHaveLength(0);
    expect(second.duplicatesSkipped).toBe(1);

    expect(await db.signal.count()).toBe(1);
  });
});

describe('risk caps reject before anything is persisted', () => {
  it('drops a candidate over the position cap and never reviews it', async () => {
    // An existing 3-share position is ~$926; another 3 shares would take AAPL
    // to ~$1,852, past the $1,000 per-symbol cap.
    //
    // Seeded as a paper lot, not a broker position: app_settings defaults to
    // paper, and in paper mode the gate reads the track record because that is
    // where paper fills live. A broker position here would be invisible — which
    // is the whole point of the paper position seam.
    const held = await insertSignal(
      {
        symbol: 'AAPL',
        side: 'buy',
        signalType: 'technical',
        quantity: '3',
        thesis: null,
        thesisSource: 'llm',
        indicators: {},
        reviewSnapshot: { estimated_price: '300.00' },
        executionMode: 'paper',
        dedupeKey: 'held-position-for-cap-test',
      },
      db,
    );
    await appendTrackRecord({ signalId: held.id, entryPrice: '300.00', status: 'open' }, db);

    const mock = broker();
    const result = await runPipeline(
      deps({ broker: mock, config: config({ MAX_POSITION_CENTS: '100000' }) }),
    );

    expect(result.signals).toHaveLength(0);
    expect(result.riskRejections.map((r) => r.reason)).toEqual(['position_size_cap']);
    expect(mock.callsTo('reviewEquityOrder')).toHaveLength(0);
    // The seeded holding is the only row: the rejected candidate added nothing.
    // Asserting the id rather than a count keeps this honest if the fixture
    // ever grows another seeded signal.
    expect(await db.signal.findMany({ select: { id: true } })).toEqual([{ id: held.id }]);
  });

  it('drops a candidate whose symbol is not allowlisted', async () => {
    const mock = new MockBrokerAdapter({
      candles: { MSFT: THROUGH_BULLISH_CROSS },
      quotes: { MSFT: quote('MSFT', '308.630000') },
    });
    // MSFT bars are present, but the allowlist for this run names only AAPL,
    // so the pipeline never even asks for them.
    const result = await runPipeline(deps({ broker: mock }));

    expect(result.candidates).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it('stops proposing once the daily cap is reached', async () => {
    const result = await runPipeline(deps({ config: config({ MAX_DAILY_TRADES: '0' }) }));

    expect(result.signals).toHaveLength(0);
    expect(result.riskRejections[0]!.reason).toBe('daily_trade_cap');
  });
});

describe('no snapshot, no signal', () => {
  it('drops the candidate when the pre-trade review fails', async () => {
    const mock = broker({ failReviewFor: ['AAPL'] });
    const result = await runPipeline(deps({ broker: mock }));

    expect(result.reviewFailures).toBe(1);
    expect(result.signals).toHaveLength(0);
    expect(await db.signal.count()).toBe(0);
  });
});

describe('approval writes a paper fill', () => {
  it('fills at the review estimate moved against the trader by the slippage', async () => {
    const { signals } = await runPipeline(deps());
    const signal = signals[0]!;

    await transitionSignal(signal.id, 'approved', 'owner approved', { prisma: db });
    const approved = (await getSignal(signal.id, db))!;

    const executor = new PaperExecutor({ config: config(), logger, prisma: db, now: clock });
    const { execution, trackRecord } = await executor.execute(approved);

    // 308.63 * (1 + 10/10000) = 308.938630, rounded to six places.
    expect(execution.fillPrice.toString()).toBe('308.93863');
    expect(execution.mode).toBe('paper');
    expect(execution.quantity.toString()).toBe('3');
    // A paper fill has no broker order, because no broker was involved.
    expect(execution.brokerOrderId).toBeNull();

    expect(trackRecord.status).toBe('open');
    expect(trackRecord.entryPrice.toString()).toBe('308.93863');
    expect(trackRecord.exitPrice).toBeNull();
  });

  it('moves a sell fill down rather than up', async () => {
    const { signals } = await runPipeline(deps());
    const signal = signals[0]!;
    await transitionSignal(signal.id, 'approved', 'ok', { prisma: db });

    // Same machinery, opposite side: slippage is always the unfavourable
    // direction, so paper never flatters the strategy.
    const executor = new PaperExecutor({ config: config(), logger, prisma: db, now: clock });

    // Fill the entry first. A sell is a close now, so it needs a lot to close —
    // executing one against an empty position is refused outright.
    const approved = (await getSignal(signal.id, db))!;
    await executor.execute(approved);

    const sellSignal = { ...approved, side: 'sell' as const };
    const { execution } = await executor.execute(sellSignal);

    expect(execution.fillPrice.toString()).toBe('308.32137');
  });

  it('never touches the broker', async () => {
    const mock = broker();
    const { signals } = await runPipeline(deps({ broker: mock }));
    await transitionSignal(signals[0]!.id, 'approved', 'ok', { prisma: db });
    const approved = (await getSignal(signals[0]!.id, db))!;

    const before = mock.calls.length;
    await new PaperExecutor({ config: config(), logger, prisma: db }).execute(approved);

    expect(mock.calls).toHaveLength(before);
    expect(mock.callsTo('placeEquityOrder')).toHaveLength(0);
  });
});

describe('rejection leaves a permanent record', () => {
  it('keeps the signal with its reason and writes no fill', async () => {
    const { signals } = await runPipeline(deps());
    await transitionSignal(signals[0]!.id, 'rejected', 'not convinced', { prisma: db });

    const signal = (await getSignal(signals[0]!.id, db))!;
    expect(signal.status).toBe('rejected');
    expect(signal.decideReason).toBe('not convinced');
    expect(signal.thesis).not.toBeNull();

    expect(await listExecutions(signal.id, db)).toHaveLength(0);
    expect(await listTrackRecord(signal.id, db)).toHaveLength(0);
    expect(await listSignalEvents(signal.id, db)).toHaveLength(1);
  });
});

// The sweep compares against `signals.created_at`, which the database stamps
// itself — so these advance a clock relative to real time rather than the fake
// NOW the rest of the suite uses.
describe('expiry sweep', () => {
  const laterByMinutes = (minutes: number) => () => new Date(Date.now() + minutes * 60_000);

  it('leaves a signal alone inside the approval window', async () => {
    await runPipeline(deps());

    const expired = await sweepExpiredSignals({
      config: config(),
      logger,
      prisma: db,
      clock: laterByMinutes(14),
    });

    expect(expired).toHaveLength(0);
  });

  it('expires it once the window has passed, with a reason', async () => {
    await runPipeline(deps());

    const expired = await sweepExpiredSignals({
      config: config(),
      logger,
      prisma: db,
      clock: laterByMinutes(16),
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe('expired');
    expect(expired[0]!.decideReason).toContain('15 minutes');

    const events = await listSignalEvents(expired[0]!.id, db);
    expect(events[0]!.toStatus).toBe('expired');
  });

  it('does not touch a signal the owner already decided', async () => {
    const { signals } = await runPipeline(deps());
    await transitionSignal(signals[0]!.id, 'approved', 'owner approved', { prisma: db });

    const expired = await sweepExpiredSignals({
      config: config(),
      logger,
      prisma: db,
      clock: laterByMinutes(60),
    });

    expect(expired).toHaveLength(0);
    expect((await getSignal(signals[0]!.id, db))!.status).toBe('approved');
  });
});

// The PRD's hardest guarantee for Phase 1: there is no reachable path to a
// real order. These assert it at the seam rather than trusting a comment.
describe('live execution is unreachable', () => {
  it('throws when the environment gate is closed', async () => {
    const { signals } = await runPipeline(deps());
    const signal = { ...signals[0]!, executionMode: 'live' as const };

    const executor = new LiveExecutor(
      { config: config({ LIVE_TRADING_ENABLED: 'false' }), logger, prisma: db },
      broker(),
    );

    await expect(executor.execute(signal)).rejects.toThrow(LiveModeNotEnabledError);
  });

  it('throws when the database gate is closed even if the env gate is open', async () => {
    const { signals } = await runPipeline(deps());
    const signal = { ...signals[0]!, executionMode: 'live' as const };

    const executor = new LiveExecutor(
      { config: config({ LIVE_TRADING_ENABLED: 'true' }), logger, prisma: db },
      broker(),
    );

    await expect(executor.execute(signal)).rejects.toThrow(/execution_mode is not live/);
  });

  it('still throws with both gates open, because the path does not exist yet', async () => {
    await setExecutionMode('live', db);
    const { signals } = await runPipeline(deps());
    const signal = { ...signals[0]!, executionMode: 'live' as const };

    const mock = broker();
    const executor = new LiveExecutor(
      { config: config({ LIVE_TRADING_ENABLED: 'true' }), logger, prisma: db },
      mock,
    );

    await expect(executor.execute(signal)).rejects.toThrow(/not implemented until Phase 5/);
    expect(mock.callsTo('placeEquityOrder')).toHaveLength(0);
  });

  it('refuses to settle a live signal through the paper executor', async () => {
    const { signals } = await runPipeline(deps());
    const signal = { ...signals[0]!, executionMode: 'live' as const };

    await expect(
      new PaperExecutor({ config: config(), logger, prisma: db }).execute(signal),
    ).rejects.toThrow(/execution_mode is live/);
  });
});

describe('execution mode follows the signal, not the account', () => {
  it('creates signals in whatever mode app_settings names', async () => {
    await setExecutionMode('live', db);
    const { signals } = await runPipeline(deps());
    expect(signals[0]!.executionMode).toBe('live');
  });
});

describe('exits are proposed against a held paper position', () => {
  /** Bars through 2026-07-31, where the MACD histogram turns negative. */
  const THROUGH_BEARISH_CROSS = ALL_BARS.slice(
    0,
    ALL_BARS.findIndex((b) => b.t.startsWith('2026-07-31')) + 1,
  );

  const bearishBroker = () =>
    new MockBrokerAdapter({
      candles: { AAPL: THROUGH_BEARISH_CROSS },
      quotes: { AAPL: quote('AAPL', '308.630000') },
    });

  async function seedPaperLot(quantity: string) {
    const signal = await insertSignal(
      {
        symbol: 'AAPL',
        side: 'buy',
        signalType: 'technical',
        quantity,
        thesis: null,
        thesisSource: 'llm',
        indicators: {},
        reviewSnapshot: { estimated_price: '300.00' },
        executionMode: 'paper',
        dedupeKey: `held-${quantity}`,
      },
      db,
    );
    await appendTrackRecord({ signalId: signal.id, entryPrice: '300.00', status: 'open' }, db);
    return signal;
  }

  it('proposes a sell sized to the shares held', async () => {
    await seedPaperLot('4');

    const result = await runPipeline(
      deps({ broker: bearishBroker(), clock: () => new Date('2026-07-31T13:35:00Z') }),
    );

    const sell = result.signals.find((s) => s.side === 'sell');
    expect(sell).toBeDefined();
    // Four shares held, four shares proposed — not the notional-derived three.
    expect(sell!.quantity.toString()).toBe('4');
    expect(sell!.status).toBe('pending');
  });

  it('proposes nothing on the same bars with no position held', async () => {
    const result = await runPipeline(
      deps({ broker: bearishBroker(), clock: () => new Date('2026-07-31T13:35:00Z') }),
    );

    // Identical bars, identical rules. The only difference is the empty
    // position record, and a long-only exit has nothing to close.
    expect(result.signals.filter((s) => s.side === 'sell')).toHaveLength(0);
  });

  it('proposes an exit even when one share costs more than a whole order', async () => {
    await seedPaperLot('4');

    const result = await runPipeline(
      deps({
        broker: bearishBroker(),
        clock: () => new Date('2026-07-31T13:35:00Z'),
        // A $10 order cannot buy a $308 share; entries are suppressed. Exits
        // must not be, or this position could never be closed by rule.
        config: config({ ORDER_NOTIONAL_CENTS: '1000' }),
      }),
    );

    const sell = result.signals.find((s) => s.side === 'sell');
    expect(sell).toBeDefined();
    expect(sell!.quantity.toString()).toBe('4');
  });
});
