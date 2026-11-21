/**
 * Compare strategy variants against the production configuration.
 *
 *   npm run backtest:compare -- --variants=variants.json --cache=.backtest-cache.json
 *   npm run backtest:compare -- --variants=v.json --cache=a.json,b.json --approval-rate=0.5
 *
 * `variants.json` is a list of `{ "name": ..., "strategy": {...}, "risk": {...} }`.
 * The first entry is the baseline the others are measured against; an entry
 * with no overrides is the configuration this process would run with today.
 *
 * Each cache is a file written by `npm run backtest` (raw broker bars). Every
 * variant runs through `simulate`, so the numbers are what the deployed
 * pipeline would have done under that configuration. Read-only: no broker, no
 * database, no orders.
 */
import { readFileSync } from 'node:fs';
import { getConfig } from '../src/config/index.js';
import {
  bootstrapMeanDifference,
  runVariant,
  supportedWindows,
  windowStats,
  type Variant,
  type WindowStats,
} from '../src/backtest/compare.js';
import type { Candle } from '../src/orchestrator/robinhood/client.js';

function flagValue(name: string, fallback: string): string {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const money = (value: number | null, digits = 2): string => (value === null ? 'n/a' : value.toFixed(digits));
const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

function row(name: string, stats: WindowStats, baseline: WindowStats | null): string {
  const interval = baseline ? bootstrapMeanDifference(stats.pnls, baseline.pnls) : null;
  return [
    name.padEnd(34),
    String(stats.trades).padStart(5),
    pct(stats.winRate).padStart(7),
    money(stats.expectancy).padStart(8),
    money(stats.totalPnl, 0).padStart(8),
    money(stats.profitFactor).padStart(6),
    money(stats.maxDrawdown, 0).padStart(7),
    pct(stats.worstReturn).padStart(8),
    interval ? `  [${interval[0].toFixed(2)}, ${interval[1].toFixed(2)}]` : '',
  ].join(' ');
}

function main(): void {
  const config = getConfig();
  const variants = JSON.parse(readFileSync(flagValue('variants', ''), 'utf8')) as Variant[];
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error('--variants must name a JSON file holding a non-empty list');
  }
  const caches = flagValue('cache', '.backtest-cache.json').split(',').filter(Boolean);
  const approvalRate = Number(flagValue('approval-rate', '1'));
  const seed = Number(flagValue('seed', '1'));

  for (const cachePath of caches) {
    const bars = (JSON.parse(readFileSync(cachePath, 'utf8')) as { bars: Record<string, Candle[]> }).bars;
    const symbols = Object.keys(bars).filter((symbol) => (bars[symbol]?.length ?? 0) > 0);
    const inputs = {
      bars: Object.fromEntries(symbols.map((symbol) => [symbol, bars[symbol]!])),
      strategy: config.strategy,
      // The allowlist has to be the simulated basket, or the gate rejects
      // every candidate outside it and the comparison measures nothing.
      risk: { ...config.risk, symbolAllowlist: symbols },
      slippageBps: config.slippageBps,
      approvalRate,
      seed,
      lookbackDays: config.candleLookbackDays,
    };

    console.log(`\n=== ${cachePath}: ${symbols.join(', ')} (approval rate ${approvalRate}) ===`);
    for (const window of supportedWindows(inputs.bars)) {
      console.log(`\n-- ${window.label} --`);
      console.log(
        `${'variant'.padEnd(34)} ${'n'.padStart(5)} ${'win'.padStart(7)} ${'exp $'.padStart(8)} ` +
          `${'pnl $'.padStart(8)} ${'PF'.padStart(6)} ${'maxDD'.padStart(7)} ${'worst'.padStart(8)}  exp diff vs first, 90%`,
      );
      let baseline: WindowStats | null = null;
      for (const variant of variants) {
        const stats = windowStats(runVariant(inputs, variant, window), window);
        console.log(row(variant.name, stats, baseline));
        baseline ??= stats;
      }
    }
  }
}

main();
