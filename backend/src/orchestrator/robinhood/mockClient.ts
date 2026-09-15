import {
  BrokerError,
  estimateFillPrice,
  type BrokerAdapter,
  type BrokerOrder,
  type Candle,
  type HistoricalsRequest,
  type PlaceOrderRequest,
  type PlaceResult,
  type Portfolio,
  type Position,
  type Quote,
  type ReviewAlert,
  type ReviewOrderRequest,
  type ReviewResult,
} from './client.js';

/**
 * Fixture-driven broker. Used by tests and by `run-pipeline-once --broker=mock`,
 * which is how the pipeline gets exercised end to end without touching a real
 * account or depending on what the market happens to be doing.
 *
 * It records every call so tests can assert on what the pipeline asked for —
 * in particular that a review preceded every signal, and that placeEquityOrder
 * was never reached.
 */

export interface MockBrokerState {
  accountNumber?: string;
  candles?: Record<string, Candle[]>;
  quotes?: Record<string, Quote>;
  portfolio?: Portfolio;
  positions?: Position[];
  /** Alerts to attach to every review, e.g. an unfunded-account warning. */
  reviewAlerts?: ReviewAlert[];
  /** Symbols whose review should fail, to exercise "no snapshot, no signal". */
  failReviewFor?: readonly string[];
  /**
   * Phase 5: scripted order lifecycles by symbol. Absent, `placeEquityOrder`
   * throws as it always has, so no test reaches a "fill" it did not ask for.
   * Present, placement returns the first state and each poll advances one
   * step, repeating the last forever.
   */
  orderScripts?: Record<string, OrderScript>;
}

export interface OrderScript {
  states: ReadonlyArray<{
    state: string;
    cumulativeQuantity?: string;
    averagePrice?: string | null;
  }>;
}

export interface MockCall {
  method: string;
  args: unknown;
}

const DEFAULT_QUOTE: Omit<Quote, 'symbol'> = {
  lastTradePrice: '100.000000',
  bidPrice: '99.990000',
  askPrice: '100.010000',
  previousClose: '99.500000',
  officialClose: '99.500000',
  hasTraded: true,
  state: 'active',
};

export class MockBrokerAdapter implements BrokerAdapter {
  readonly calls: MockCall[] = [];
  private readonly state: MockBrokerState;

  constructor(state: MockBrokerState = {}) {
    this.state = state;
  }

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args });
  }

  callsTo(method: string): MockCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async getAccountNumber(): Promise<string> {
    this.record('getAccountNumber', {});
    return this.state.accountNumber ?? '100000003';
  }

  async getHistoricals(request: HistoricalsRequest): Promise<Record<string, Candle[]>> {
    this.record('getHistoricals', request);
    const all = this.state.candles ?? {};
    const selected: Record<string, Candle[]> = {};
    for (const symbol of request.symbols) {
      const candles = all[symbol];
      if (candles) selected[symbol] = candles;
    }
    return selected;
  }

  async getQuotes(symbols: readonly string[]): Promise<Record<string, Quote>> {
    this.record('getQuotes', { symbols });
    const quotes: Record<string, Quote> = {};
    for (const symbol of symbols) {
      quotes[symbol] = this.state.quotes?.[symbol] ?? { symbol, ...DEFAULT_QUOTE };
    }
    return quotes;
  }

  async getPortfolio(): Promise<Portfolio> {
    this.record('getPortfolio', {});
    return (
      this.state.portfolio ?? {
        totalValue: '10000.00',
        equityValue: '0.00',
        cash: '10000.00',
        buyingPower: '10000.0000',
        currency: 'USD',
      }
    );
  }

  async getPositions(): Promise<Position[]> {
    this.record('getPositions', {});
    return this.state.positions ?? [];
  }

  async reviewEquityOrder(request: ReviewOrderRequest): Promise<ReviewResult> {
    this.record('reviewEquityOrder', request);

    if (this.state.failReviewFor?.includes(request.symbol)) {
      throw new BrokerError(`mock review failure for ${request.symbol}`);
    }

    const quote = this.state.quotes?.[request.symbol] ?? {
      symbol: request.symbol,
      ...DEFAULT_QUOTE,
    };
    const estimatedPrice = estimateFillPrice(request.side, quote);
    const alerts = this.state.reviewAlerts ?? [];

    return {
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      estimatedPrice,
      alerts,
      // Same envelope shape the real adapter persists, so the review_snapshot
      // column holds structurally similar JSON in tests and in production.
      raw: {
        symbol: request.symbol,
        side: request.side,
        type: request.type ?? 'market',
        quantity: request.quantity,
        order_checks: alerts[0] ? { alertType: alerts[0].type } : {},
        quote_data: {
          symbol: quote.symbol,
          last_trade_price: quote.lastTradePrice,
          bid_price: quote.bidPrice,
          ask_price: quote.askPrice,
          previous_close: quote.previousClose,
          has_traded: quote.hasTraded,
          state: quote.state,
        },
        _mock: true,
      },
    };
  }

  private orders = new Map<string, { script: OrderScript; cursor: number; request: PlaceOrderRequest }>();

  /**
   * Throws unless a test scripted an order book for the symbol. A mock that
   * quietly succeeded here would let a test pass while proving the opposite
   * of what it claims — so the default stays a refusal, and a scripted fill
   * is something a test has to ask for by name.
   */
  async placeEquityOrder(request: PlaceOrderRequest): Promise<PlaceResult> {
    this.record('placeEquityOrder', request);
    const script = this.state.orderScripts?.[request.symbol];
    if (!script || script.states.length === 0) {
      throw new BrokerError('MockBrokerAdapter refuses to place orders');
    }

    // Same ref_id, same order: the idempotency the real broker promises.
    const existing = [...this.orders.entries()].find(([, o]) => o.request.refId === request.refId);
    if (existing) {
      return { brokerOrderId: existing[0], state: existing[1].script.states[0]!.state, raw: { _mock: true } };
    }

    const brokerOrderId = `mock-order-${this.orders.size + 1}`;
    this.orders.set(brokerOrderId, { script, cursor: 1, request });
    return { brokerOrderId, state: script.states[0]!.state, raw: { _mock: true, id: brokerOrderId } };
  }

  async getEquityOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    this.record('getEquityOrder', { brokerOrderId });
    const entry = this.orders.get(brokerOrderId);
    if (!entry) return null;
    const step = entry.script.states[Math.min(entry.cursor, entry.script.states.length - 1)]!;
    entry.cursor += 1;

    // A `filled` step with no numbers fills the whole order at the mock's own
    // estimate — what `BROKER=mock` relies on, since it cannot know sizes in
    // advance. Scripts that care about the numbers state them.
    const filledWhole = step.state === 'filled';
    const quote = this.state.quotes?.[entry.request.symbol] ?? {
      symbol: entry.request.symbol,
      ...DEFAULT_QUOTE,
    };
    return {
      brokerOrderId,
      state: step.state,
      cumulativeQuantity: step.cumulativeQuantity ?? (filledWhole ? entry.request.quantity : '0'),
      averagePrice:
        step.averagePrice !== undefined
          ? step.averagePrice
          : filledWhole
            ? estimateFillPrice(entry.request.side, quote)
            : null,
      raw: { _mock: true, id: brokerOrderId, state: step.state },
    };
  }

  async close(): Promise<void> {
    this.record('close', {});
  }
}
