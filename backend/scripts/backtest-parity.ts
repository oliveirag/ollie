/**
 * Check that the replay proposes what production proposed.
 *
 *   npm run backtest:parity -- --cache=.bt-prod.json \
 *     --signals=.parity-signals-decided.json,.parity-signals-pending.json \
 *     --from=2026-09-24 [--to=2026-11-20]
 *
 * `--signals` takes the JSON bodies of GET /v1/signals (decided and pending),
 * saved to files. The cache must cover the window plus the indicator warm-up.
 * Read-only: no broker, no database, no orders.
 */
import { readFileSync } from 'node:fs';
import { getConfig } from '../src/config/index.js';
import { checkParity, type ParityRow, type ProductionSignal } from '../src/backtest/parity.js';
import type { Candle } from '../src/orchestrator/robinhood/client.js';

function flagValue(name: string, fallback: string): string {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const show = (rows: ParityRow[]): string =>
  rows.length === 0
    ? '  none'
    : rows
        .sort((a, b) => a.barDate.localeCompare(b.barDate) || a.symbol.localeCompare(b.symbol))
        .map(
          (r) =>
            `  ${r.barDate}  ${r.symbol.padEnd(5)} ${r.side.padEnd(4)}  ` +
            `${r.replayRule ? `replay: ${r.replayRule}` : ''}${r.productionStatus ? `  production: ${r.productionStatus}` : ''}`,
        )
        .join('\n');

function main(): void {
  const config = getConfig();
  const cache = JSON.parse(readFileSync(flagValue('cache', '.backtest-cache.json'), 'utf8')) as {
    bars: Record<string, Candle[]>;
  };
  const signals = flagValue('signals', '')
    .split(',')
    .filter(Boolean)
    .flatMap((path) => (JSON.parse(readFileSync(path, 'utf8')) as { signals: ProductionSignal[] }).signals);

  const lastBar = Object.values(cache.bars)
    .map((bars) => bars.at(-1)?.t.slice(0, 10) ?? '')
    .sort()
    .at(0)!;
  const from = flagValue('from', '2026-09-24');
  const to = flagValue('to', lastBar);

  const report = checkParity({
    bars: cache.bars,
    strategy: config.strategy,
    risk: config.risk,
    signals,
    from,
    to,
    lookbackDays: config.candleLookbackDays,
  });

  console.log(`
--- parity, ${from} to ${to} (${report.daysChecked} trading days, ${signals.length} production signals read) ---
matched          ${report.matched.length}
production only  ${report.productionOnly.length}
replay only      ${report.replayOnly.length}

matched:
${show(report.matched)}

production proposed, replay would not:
${show(report.productionOnly)}

replay would propose, production did not:
${show(report.replayOnly)}
`);
}

main();
