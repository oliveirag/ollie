/**
 * Run the pipeline exactly once and print what it did.
 *
 *   npm run pipeline:once -- --broker=mock    # fixtures, no network
 *   npm run pipeline:once -- --broker=real    # live Robinhood MCP
 *
 * The mock broker replays checked-in AAPL bars that are known to fire a MACD
 * bullish cross on their final bar, so a mock run is expected to produce
 * exactly one signal. It never reaches the network and never sees an account.
 *
 * A real run is read-only apart from `review_equity_order`, which simulates an
 * order without placing one. `place_equity_order` is not reachable from here.
 */
import { getConfig } from '../src/config/index.js';
import { disconnectPrisma } from '../src/db/client.js';
import { logger } from '../src/logger.js';
import { runPipeline, sweepExpiredSignals } from '../src/orchestrator/pipeline.js';
import type { BrokerAdapter, Candle } from '../src/orchestrator/robinhood/client.js';
import { McpBrokerAdapter } from '../src/orchestrator/robinhood/mcpClient.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import fixture from '../test/fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

function flagValue(name: string, fallback: string): string {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function mockBroker(): BrokerAdapter {
  const bars: Candle[] = fixture.results[0]!.bars.map((bar) => ({
    t: bar.begins_at,
    o: bar.open_price,
    h: bar.high_price,
    l: bar.low_price,
    c: bar.close_price,
    v: bar.volume,
  }));
  // Truncated at the bullish MACD cross so a mock run has something to show.
  const throughCross = bars.slice(
    0,
    bars.findIndex((bar) => bar.t.startsWith('2026-07-02')) + 1,
  );

  return new MockBrokerAdapter({
    candles: { AAPL: throughCross, MSFT: throughCross, SPY: throughCross },
    quotes: {
      AAPL: {
        symbol: 'AAPL',
        lastTradePrice: '308.630000',
        bidPrice: '308.620000',
        askPrice: '308.640000',
        previousClose: '294.380000',
        officialClose: '294.380000',
        hasTraded: true,
        state: 'active',
      },
    },
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  const brokerKind = flagValue('broker', 'mock');
  if (brokerKind !== 'mock' && brokerKind !== 'real') {
    throw new Error(`--broker must be "mock" or "real", got "${brokerKind}"`);
  }

  const broker: BrokerAdapter =
    brokerKind === 'real' ? new McpBrokerAdapter({ logger }) : mockBroker();

  console.log(
    `\nrunning pipeline once with the ${brokerKind} broker ` +
      `(symbols: ${config.symbolAllowlist.join(', ')})\n`,
  );

  try {
    const result = await runPipeline({ broker, config, logger });

    console.log('\n--- run summary ---');
    console.table([
      {
        run_id: result.runId,
        status: result.status,
        symbols: result.symbolsEvaluated,
        candidates: result.candidates,
        signals: result.signals.length,
        duplicates: result.duplicatesSkipped,
        risk_rejected: result.riskRejections.length,
        review_failures: result.reviewFailures,
      },
    ]);

    if (result.riskRejections.length > 0) {
      console.log('\nrejected by the risk gate:');
      console.table(
        result.riskRejections.map((r) => ({
          symbol: r.candidate.symbol,
          side: r.candidate.side,
          rule: r.candidate.rule,
          reason: r.reason,
          detail: r.detail,
        })),
      );
    }

    if (result.signals.length > 0) {
      console.log('\npending signals — decide with: npm run signal:decide -- <id> approve|reject');
      console.table(
        result.signals.map((s) => ({
          id: s.id,
          symbol: s.symbol,
          side: s.side,
          quantity: s.quantity.toString(),
          mode: s.executionMode,
          thesis_source: s.thesisSource,
        })),
      );
      for (const signal of result.signals) {
        console.log(`\n${signal.symbol} ${signal.side}: ${signal.thesis}`);
      }
    }

    const expired = await sweepExpiredSignals({ config, logger });
    if (expired.length > 0) {
      console.log(`\nexpired ${expired.length} signal(s) past the approval window`);
    }
  } finally {
    await broker.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error('\npipeline run failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
