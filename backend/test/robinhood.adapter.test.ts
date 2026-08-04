import { describe, expect, it } from 'vitest';
import { estimateFillPrice } from '../src/orchestrator/robinhood/client.js';
import { toAlerts, unwrapToolResult } from '../src/orchestrator/robinhood/mcpClient.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import {
  GetAccountsSchema,
  GetHistoricalsSchema,
  GetPositionsSchema,
  GetQuotesSchema,
  PortfolioSchema,
  ReviewEquityOrderSchema,
} from '../src/orchestrator/robinhood/types.js';
import accountsFixture from './fixtures/mcp/accounts.json' with { type: 'json' };
import portfolioFixture from './fixtures/mcp/portfolio.json' with { type: 'json' };
import positionsFixture from './fixtures/mcp/positions.json' with { type: 'json' };
import quotesFixture from './fixtures/mcp/quotes.json' with { type: 'json' };
import reviewFixture from './fixtures/mcp/review-equity-order.json' with { type: 'json' };
import historicalsFixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

// These assert our schemas against responses captured from the live server on
// 2026-08-04. If the broker changes a shape, this is where it should surface —
// loudly, in CI, rather than at 9:35 on a weekday morning.
describe('wire schemas match captured responses', () => {
  it('parses get_accounts', () => {
    const parsed = GetAccountsSchema.parse(accountsFixture);
    expect(parsed.accounts).toHaveLength(3);
    expect(parsed.accounts.filter((a) => a.agentic_allowed)).toHaveLength(1);
  });

  it('parses get_portfolio, keeping money as strings', () => {
    const parsed = PortfolioSchema.parse(portfolioFixture);
    expect(parsed.buying_power.buying_power).toBe('0.0000');
    expect(typeof parsed.total_value).toBe('string');
  });

  it('parses an empty get_equity_positions', () => {
    expect(GetPositionsSchema.parse(positionsFixture).positions).toEqual([]);
  });

  it('parses get_equity_quotes with the paired official close', () => {
    const parsed = GetQuotesSchema.parse(quotesFixture);
    expect(parsed.results.map((r) => r.quote.symbol)).toEqual(['AAPL', 'MSFT', 'SPY']);
    expect(parsed.results[0]!.close?.price).toBe('303.42');
  });

  it('parses get_equity_historicals', () => {
    const parsed = GetHistoricalsSchema.parse(historicalsFixture);
    const bars = parsed.results[0]!.bars;
    expect(bars.length).toBeGreaterThan(50);
    expect(bars[0]!.begins_at).toBe('2026-05-01T00:00:00Z');
    expect(bars.at(-1)!.close_price).toBe('303.420000');
    // Volume is the one genuinely numeric field; every price stays a string.
    expect(typeof bars[0]!.volume).toBe('number');
    expect(typeof bars[0]!.close_price).toBe('string');
  });

  it('parses review_equity_order', () => {
    const parsed = ReviewEquityOrderSchema.parse(reviewFixture);
    expect(parsed.symbol).toBe('AAPL');
    expect(parsed.quote_data.ask_price).toBe('308.570000');
    expect(parsed.order_checks['alertType']).toBe('EQUITY_NOT_ENOUGH_BP');
  });

  it('keeps unknown fields rather than dropping them', () => {
    const parsed = ReviewEquityOrderSchema.parse(reviewFixture);
    // market_data_disclosure is a compliance string that must survive into the
    // persisted snapshot even though nothing in the pipeline reads it.
    expect(parsed.market_data_disclosure).toContain('Bid $308.55');
  });
});

describe('tool result envelope', () => {
  it('unwraps the data payload and drops the agent-facing guide', () => {
    const content = [{ type: 'text', text: JSON.stringify({ data: { a: 1 }, guide: 'prose' }) }];
    expect(unwrapToolResult(content, 'test')).toEqual({ a: 1 });
  });

  it('passes through a payload with no data envelope', () => {
    const content = [{ type: 'text', text: JSON.stringify({ a: 1 }) }];
    expect(unwrapToolResult(content, 'test')).toEqual({ a: 1 });
  });

  it('rejects content that is not JSON', () => {
    expect(() => unwrapToolResult([{ type: 'text', text: 'not json' }], 'test')).toThrow(
      /not JSON/,
    );
  });

  it('rejects a result with no text content', () => {
    expect(() => unwrapToolResult([{ type: 'image' }], 'test')).toThrow(/no text content/);
  });
});

describe('pre-trade alerts', () => {
  it('reads an empty order_checks as no alerts', () => {
    expect(toAlerts({})).toEqual([]);
  });

  it('normalises the object form into a list with its detail payload', () => {
    const alerts = toAlerts(reviewFixture.order_checks);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.type).toBe('EQUITY_NOT_ENOUGH_BP');
    expect(alerts[0]!.details).toMatchObject({ depositAmount: { amount: '308.5700' } });
  });
});

describe('market fill estimate', () => {
  const quote = { lastTradePrice: '308.555', bidPrice: '308.550', askPrice: '308.570' };

  it('uses the ask for a buy and the bid for a sell', () => {
    expect(estimateFillPrice('buy', quote)).toBe('308.570');
    expect(estimateFillPrice('sell', quote)).toBe('308.550');
  });

  it('falls back to the last trade when a side of the book is missing or zero', () => {
    expect(estimateFillPrice('buy', { lastTradePrice: '100.00', askPrice: null })).toBe('100.00');
    expect(estimateFillPrice('sell', { lastTradePrice: '100.00', bidPrice: '0.0000' })).toBe(
      '100.00',
    );
  });

  it('returns the quoted string unchanged, never a rounded number', () => {
    expect(estimateFillPrice('buy', { lastTradePrice: '1', askPrice: '308.570000' })).toBe(
      '308.570000',
    );
  });
});

describe('mock adapter', () => {
  it('records what the pipeline asked for', async () => {
    const broker = new MockBrokerAdapter();
    await broker.getQuotes(['AAPL']);
    await broker.reviewEquityOrder({ symbol: 'AAPL', side: 'buy', quantity: '2' });

    expect(broker.callsTo('getQuotes')).toHaveLength(1);
    expect(broker.callsTo('reviewEquityOrder')[0]!.args).toMatchObject({ symbol: 'AAPL' });
  });

  it('refuses to place an order', async () => {
    const broker = new MockBrokerAdapter();
    await expect(
      broker.placeEquityOrder({ symbol: 'AAPL', side: 'buy', quantity: '1', refId: 'x' }),
    ).rejects.toThrow(/refuses to place orders/);
  });

  it('can be told to fail a review, so "no snapshot, no signal" is testable', async () => {
    const broker = new MockBrokerAdapter({ failReviewFor: ['MSFT'] });
    await expect(
      broker.reviewEquityOrder({ symbol: 'MSFT', side: 'buy', quantity: '1' }),
    ).rejects.toThrow(/mock review failure/);
  });

  it('produces a review snapshot shaped like the real one', async () => {
    const broker = new MockBrokerAdapter({
      reviewAlerts: [{ type: 'EQUITY_NOT_ENOUGH_BP', details: {} }],
    });
    const review = await broker.reviewEquityOrder({ symbol: 'AAPL', side: 'buy', quantity: '1' });

    expect(review.estimatedPrice).toBe('100.010000');
    expect(ReviewEquityOrderSchema.safeParse(review.raw).success).toBe(true);
  });
});
