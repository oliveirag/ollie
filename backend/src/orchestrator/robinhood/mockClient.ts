import {
  BrokerError,
  estimateFillPrice,
  type BrokerAdapter,
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

  /**
   * Throws, always. The mock is used by the integration tests, and a mock that
   * quietly succeeded here would let a test pass while proving the opposite of
   * what it claims.
   */
  async placeEquityOrder(request: PlaceOrderRequest): Promise<PlaceResult> {
    this.record('placeEquityOrder', request);
    throw new BrokerError('MockBrokerAdapter refuses to place orders');
  }

  async close(): Promise<void> {
    this.record('close', {});
  }
}
