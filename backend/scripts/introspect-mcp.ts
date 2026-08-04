/**
 * Milestone 1.1 spike: connect to the Robinhood Trading MCP and dump what it
 * actually returns.
 *
 * The input schemas were known before this existed; the output shapes were not,
 * and guessing them is how an adapter ends up confidently wrong. Everything
 * here is read-only. review_equity_order simulates an order and does not place
 * one; place_equity_order is never called and is not reachable from this file.
 *
 *   npm run introspect:mcp                 # tools/list plus read-only calls
 *   npm run introspect:mcp -- --review     # also simulate a 1-share market buy
 *   npm run introspect:mcp -- --out ./out  # write raw JSON per call
 *
 * Re-run this whenever the server might have changed, and update
 * src/orchestrator/robinhood/types.ts and test/fixtures/mcp/ together with it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../src/config/index.js';
import { unwrapToolResult } from '../src/orchestrator/robinhood/mcpClient.js';

const has = (flag: string) => process.argv.includes(`--${flag}`);
const value = (flag: string): string | undefined => {
  const index = process.argv.indexOf(`--${flag}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const outDir = value('out');

function summarise(node: unknown, depth = 0): string {
  const pad = '  '.repeat(depth);
  if (node === null) return 'null';
  if (Array.isArray(node)) {
    if (node.length === 0) return 'array (empty — shape unverified)';
    return `array[${node.length}] of\n${pad}  ${summarise(node[0], depth + 1)}`;
  }
  if (typeof node === 'object') {
    const entries = Object.entries(node as Record<string, unknown>);
    return entries
      .map(([key, child]) => {
        const kind =
          child === null
            ? 'null'
            : Array.isArray(child)
              ? `array[${child.length}]`
              : typeof child === 'object'
                ? 'object'
                : `${typeof child} = ${JSON.stringify(child)}`;
        return `\n${pad}  ${key}: ${kind}`;
      })
      .join('');
  }
  return typeof node;
}

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.robinhood.authToken) {
    throw new Error('RH_MCP_AUTH_TOKEN is not set; nothing to introspect');
  }

  const client = new Client({ name: 'ollie-introspect', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(config.robinhood.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${config.robinhood.authToken}` } },
  });

  // Cast for the same upstream typing mismatch documented in mcpClient.ts.
  await client.connect(transport as Parameters<Client['connect']>[0]);
  console.log(`connected to ${config.robinhood.mcpUrl}\n`);

  if (outDir) await mkdir(outDir, { recursive: true });

  const dump = async (name: string, payload: unknown): Promise<void> => {
    if (!outDir) return;
    await writeFile(join(outDir, `${name}.json`), JSON.stringify(payload, null, 2));
  };

  // 1. Tool names. The direct endpoint and a connector expose different names
  // for the same tools, so this is what the adapter's suffix resolution keys on.
  const { tools } = await client.listTools();
  console.log(`tools/list returned ${tools.length} tools:`);
  for (const tool of tools) console.log(`  ${tool.name}`);
  await dump('tools-list', tools);

  const shortNames = new Map(tools.map((t) => [t.name.split('__').pop() ?? t.name, t.name]));
  const call = async (short: string, args: Record<string, unknown>): Promise<unknown> => {
    const name = shortNames.get(short);
    if (!name) throw new Error(`this server does not expose ${short}`);
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${short}: ${JSON.stringify(result.content)}`);
    const data = unwrapToolResult(result.content, short);
    console.log(`\n--- ${short} ---${summarise(data)}`);
    await dump(short, data);
    return data;
  };

  // 2. Which account may this agent trade in? Everything else needs the answer.
  const accounts = (await call('get_accounts', {})) as {
    accounts: Array<{ account_number: string; agentic_allowed: boolean; nickname?: string }>;
  };
  const agentic = accounts.accounts.filter((a) => a.agentic_allowed);
  console.log(
    `\nagentic_allowed accounts: ${agentic.length}` +
      agentic.map((a) => ` (…${a.account_number.slice(-4)}${a.nickname ? ` "${a.nickname}"` : ''})`).join(''),
  );
  if (agentic.length === 0) throw new Error('no agentic_allowed account on this connection');
  const accountNumber = agentic[0]!.account_number;

  await call('get_portfolio', { account_number: accountNumber });
  await call('get_equity_positions', { account_number: accountNumber });
  await call('get_equity_quotes', { symbols: ['AAPL'] });

  const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await call('get_equity_historicals', {
    symbols: ['AAPL'],
    start_time: start,
    interval: 'day',
    bounds: 'regular',
    adjustment_type: 'split',
  });

  // 3. The broker's own indicator values, used once as an independent check on
  // our RSI and MACD implementations rather than as a runtime dependency.
  await call('get_equity_technical_indicators', {
    symbol: 'AAPL',
    type: 'rsi',
    interval: 'day',
    start_time: start,
    period: 14,
    output: 'last:5',
  });
  await call('get_equity_technical_indicators', {
    symbol: 'AAPL',
    type: 'macd',
    interval: 'day',
    start_time: start,
    output: 'last:5',
  });

  // 4. The pre-trade review. Simulation only — it returns a preview and places
  // nothing. Opt in explicitly, since it is the one call that names a side and
  // a quantity.
  if (has('review')) {
    await call('review_equity_order', {
      account_number: accountNumber,
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      quantity: '1',
      time_in_force: 'gfd',
      market_hours: 'regular_hours',
    });
  } else {
    console.log('\nskipping review_equity_order (pass --review to include it)');
  }

  await client.close();
  console.log(
    `\ndone.${outDir ? ` raw responses written to ${outDir}` : ''}\n` +
      'Update src/orchestrator/robinhood/types.ts and test/fixtures/mcp/ if any shape moved.',
  );
}

main().catch((error: unknown) => {
  console.error('\nintrospect-mcp failed:', error);
  process.exit(1);
});
