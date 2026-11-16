import { describe, expect, it, vi } from 'vitest';
import { BrokerError } from '../src/orchestrator/robinhood/client.js';
import {
  McpBrokerAdapter,
  ToolResultError,
  isRetryable,
} from '../src/orchestrator/robinhood/mcpClient.js';
import quotesFixture from './fixtures/mcp/quotes.json' with { type: 'json' };

/**
 * The trading MCP retry loop. A retry that resends a rejected live order, or
 * one that never retries a real outage, is a money bug either way; these pin
 * which failures get a second attempt and that the old session is closed.
 */

function textResult(payload: unknown, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

interface FakeClient {
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeClient(...results: Array<unknown | Error>): FakeClient {
  const callTool = vi.fn();
  for (const result of results) {
    if (result instanceof Error) callTool.mockRejectedValueOnce(result);
    else callTool.mockResolvedValueOnce(result);
  }
  return { callTool, close: vi.fn().mockResolvedValue(undefined) };
}

/**
 * An adapter whose connection is a fake. `openConnection` is the seam: the
 * real `connect` (shared attempt, caching) still runs around it.
 */
function adapterWith(...connections: Array<FakeClient | Error>) {
  const adapter = new McpBrokerAdapter({ url: 'http://broker.test/mcp', authToken: 'test-token', accountNumber: 'ACCT1' });
  const internals = adapter as unknown as {
    openConnection: () => Promise<unknown>;
    toolNames: Map<string, string>;
    accountNumber: string | null;
  };
  internals.accountNumber = 'ACCT1';
  for (const name of ['get_equity_quotes', 'place_equity_order']) internals.toolNames.set(name, name);
  const open = vi.spyOn(internals, 'openConnection');
  for (const connection of connections) {
    if (connection instanceof Error) open.mockRejectedValueOnce(connection);
    else open.mockResolvedValueOnce(connection);
  }
  return { adapter, open };
}

function connectRefused(): BrokerError {
  const fetchFailed = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }) });
  return new BrokerError('failed to connect to http://broker.test/mcp', fetchFailed);
}

describe('isRetryable', () => {
  it('does not mistake a price in a rejection for a 5xx', () => {
    for (const message of [
      'review_equity_order returned an error: limit 512.30 is outside the band',
      'quoted $503 at the open',
      'quantity 15000 exceeds the cap',
    ]) {
      expect(isRetryable(new BrokerError(message)), message).toBe(false);
    }
  });

  it('still retries a status code standing alone', () => {
    expect(isRetryable(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isRetryable(new Error('status 429'))).toBe(true);
  });

  it("reads the SDK's numeric HTTP status", () => {
    const sdkError = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: upstream'), { code: 502 });
    expect(isRetryable(sdkError)).toBe(true);
    const unauthorized = Object.assign(new Error('Streamable HTTP error: Server returned 401'), { code: 401 });
    expect(isRetryable(unauthorized)).toBe(false);
  });

  it('looks through the cause chain of a connect failure', () => {
    // The top message names only the URL; the reason is two causes down.
    expect(isRetryable(connectRefused())).toBe(true);
  });

  it('never retries an answer from the server to place_equity_order', () => {
    const rejected = new ToolResultError('place_equity_order', [{ type: 'text', text: 'rate limit: order rejected' }]);
    expect(isRetryable(rejected, 'place_equity_order')).toBe(false);
    // The same text on a read is worth another try.
    expect(isRetryable(new ToolResultError('get_equity_quotes', 'rate limit'), 'get_equity_quotes')).toBe(true);
  });

  it('never retries a missing credential', () => {
    expect(isRetryable(new BrokerError('no Robinhood credential configured; timeout'))).toBe(false);
  });
});

describe('the retry loop', () => {
  it('sends a rejected order exactly once, even when the rejection quotes a 5xx-looking price', async () => {
    const client = fakeClient(textResult({ detail: 'Order rejected: price 512.30 outside the collar' }, true));
    const { adapter } = adapterWith(client);

    await expect(
      adapter.placeEquityOrder({ symbol: 'AAPL', side: 'buy', quantity: '1', type: 'market', refId: 'ref-1' }),
    ).rejects.toThrow(/Order rejected/);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('retries a connection that was refused, then succeeds', async () => {
    const client = fakeClient(textResult({ data: quotesFixture }));
    const { adapter, open } = adapterWith(connectRefused(), client);

    const quotes = await adapter.getQuotes(['AAPL']);

    expect(open).toHaveBeenCalledTimes(2);
    expect(quotes['AAPL']?.lastTradePrice).toBe('308.320000');
  });

  it('closes the old session before reconnecting', async () => {
    const first = fakeClient(new Error('socket hang up'));
    const second = fakeClient(textResult({ data: quotesFixture }));
    const { adapter } = adapterWith(first, second);

    await adapter.getQuotes(['AAPL']);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.callTool).toHaveBeenCalledTimes(1);
  });
});
