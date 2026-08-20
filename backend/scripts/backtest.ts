/**
 * Replay the strategy over history and report what it would have done.
 *
 *   npm run backtest                                  # allowlist, cached bars
 *   npm run backtest -- --symbols=AAPL,MSFT,SPY,QQQ   # a wider basket
 *   npm run backtest -- --from=2019-01-01 --refetch   # pull fresh history
 *   npm run backtest -- --approval-rate=0.7 --seed=3  # an imperfect owner
 *
 * The first run fetches daily bars through the same Robinhood MCP the pipeline
 * uses and caches them; later runs read the cache and need no network. The
 * cache is raw broker output, never simulation results, so re-running can
 * change the answer only if the code changed.
 *
 * Read-only: this script has no executor, and the adapter's only write method
 * throws. It cannot propose, decide, or place anything.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../src/config/index.js';
import { logger } from '../src/logger.js';
import { simulate } from '../src/backtest/simulate.js';
import { summarize } from '../src/backtest/summarize.js';
import type { Candle } from '../src/orchestrator/robinhood/client.js';
import { McpBrokerAdapter } from '../src/orchestrator/robinhood/mcpClient.js';

const DEFAULT_CACHE = '.backtest-cache.json';

function flagValue(name: string, fallback: string): string {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const hasFlag = (name: string): boolean =>
  process.argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));

interface Cache {
  fetchedAt: string;
  startTime: string;
  bars: Record<string, Candle[]>;
}

async function loadBars(
  symbols: string[],
  startTime: string,
  endTime: string | undefined,
  cachePath: string,
  refetch: boolean,
): Promise<Record<string, Candle[]>> {
  if (!refetch && existsSync(cachePath)) {
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Cache;
    const missing = symbols.filter((symbol) => !cache.bars[symbol]);

    // A cache that starts later than asked for would silently shorten the
    // window and quietly change every rate in the report.
    const staleWindow = cache.startTime > startTime;

    if (missing.length === 0 && !staleWindow) {
      console.log(`using cached bars from ${cachePath} (fetched ${cache.fetchedAt})`);
      return Object.fromEntries(symbols.map((symbol) => [symbol, cache.bars[symbol]!]));
    }

    console.log(
      missing.length > 0
        ? `cache is missing ${missing.join(', ')}; refetching`
        : `cache starts at ${cache.startTime}, after the requested ${startTime}; refetching`,
    );
  }

  console.log(`fetching daily bars for ${symbols.join(', ')} from ${startTime}...`);
  const broker = new McpBrokerAdapter({ logger });
  const bars = await broker.getHistoricals({
    symbols,
    startTime,
    ...(endTime ? { endTime } : {}),
    interval: 'day',
  });

  mkdirSync(dirname(cachePath) || '.', { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), startTime, bars } satisfies Cache, null, 2),
  );
  console.log(`cached to ${cachePath}`);

  return bars;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const config = getConfig();

  const symbols = flagValue('symbols', config.symbolAllowlist.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const from = flagValue('from', '2019-01-01');
  const to = flagValue('to', '');
  const approvalRate = Number(flagValue('approval-rate', '1'));
  const seed = Number(flagValue('seed', '1'));
  const maxHoldingDays = Number(flagValue('max-holding-days', String(config.strategy.maxHoldingDays)));

  if (!(approvalRate >= 0 && approvalRate <= 1)) {
    throw new Error(`--approval-rate must be between 0 and 1, got "${approvalRate}"`);
  }

  const bars = await loadBars(
    symbols,
    new Date(from).toISOString(),
    to ? new Date(to).toISOString() : undefined,
    flagValue('cache', DEFAULT_CACHE),
    hasFlag('refetch'),
  );

  const present = symbols.filter((symbol) => (bars[symbol]?.length ?? 0) > 0);
  const absent = symbols.filter((symbol) => !present.includes(symbol));
  if (absent.length > 0) console.log(`no bars returned for ${absent.join(', ')}; skipping`);
  if (present.length === 0) throw new Error('no bars for any requested symbol');

  const result = simulate({
    bars: Object.fromEntries(present.map((symbol) => [symbol, bars[symbol]!])),
    strategy: { ...config.strategy, maxHoldingDays },
    // The allowlist has to be the simulated basket, or the gate rejects every
    // candidate outside it and the wider sweep measures nothing.
    risk: { ...config.risk, symbolAllowlist: present },
    slippageBps: config.slippageBps,
    approvalRate,
    seed,
  });

  const summary = summarize(result);
  const first = result.days.find((day) => day.evaluable)?.barTime.slice(0, 10) ?? 'n/a';
  const last = result.days.at(-1)?.barTime.slice(0, 10) ?? 'n/a';

  console.log(`
--- backtest ---
symbols            ${present.join(', ')}
window             ${first} to ${last} (${summary.evaluableDays} evaluable bars)
slippage           ${config.slippageBps} bps        approval rate  ${pct(approvalRate)}
order notional     ${(config.strategy.orderNotionalCents / 100).toFixed(2)}     max holding    ${maxHoldingDays} bars

--- how often it trades ---
entries            ${summary.entries} (${summary.entriesPerMonth.toFixed(2)} per 21-bar month)
signals proposed   ${result.signalsProposed}
expired unapproved ${result.expired}
unfilled at end    ${result.unfilled}
median holding     ${summary.medianHoldingBars ?? 'n/a'} bars

--- position coverage (milestone 3.8) ---
covered days       ${summary.coveredDays} of ${summary.evaluableDays} (${pct(summary.coverageFraction)})
longest streak     ${summary.longestCoveredStreak} consecutive days with a position open
streaks of 20+     ${summary.streaksReaching20} (median streak ${summary.coveredStreaks.length === 0 ? 'n/a' : summary.coveredStreaks[Math.floor(summary.coveredStreaks.length / 2)]} days, ${summary.coveredStreaks.length} in all)

--- the record it would have built ---
closed trades      ${summary.closedTrades}      still open  ${summary.openPositions}
win rate           ${summary.winRate === null ? 'n/a (nothing closed)' : pct(summary.winRate)}
average return     ${summary.averageReturn === null ? 'n/a' : pct(summary.averageReturn)}
realized pnl       ${summary.totalRealizedPnl}

--- risk gate rejections ---
${Object.entries(result.rejections)
  .filter(([, count]) => count > 0)
  .map(([reason, count]) => `${reason.padEnd(19)}${count}`)
  .join('\n') || 'none'}
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
