/**
 * The broker seam.
 *
 * Everything upstream of this interface deals in domain types with decimal
 * strings; everything downstream deals in whatever the MCP server sends. Two
 * implementations exist: mcpClient (real) and mockClient (fixtures). The
 * pipeline is constructed with one of them and cannot tell which.
 */

/** One OHLCV bar. Prices are decimal strings; only volume is a number. */
export interface Candle {
  /** Bar start, RFC3339 UTC, left-edge labelled. */
  t: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: number;
  /** True only for synthesized gap-fill bars, which must never reach a rule. */
  interpolated?: boolean;
}

export interface Quote {
  symbol: string;
  lastTradePrice: string;
  bidPrice: string | null;
  askPrice: string | null;
  previousClose: string | null;
  /** Official settled close of the prior session, when the server supplied it. */
  officialClose: string | null;
  hasTraded: boolean;
  state: string;
}

export interface Portfolio {
  totalValue: string;
  equityValue: string | null;
  cash: string | null;
  buyingPower: string;
  currency: string;
}

export interface Position {
  symbol: string;
  quantity: string;
  /** Sellable now — the number a long-only sell must be checked against. */
  sharesAvailableForSells: string;
  averageBuyPrice: string | null;
}

export type OrderSide = 'buy' | 'sell';

export interface ReviewOrderRequest {
  symbol: string;
  side: OrderSide;
  quantity: string;
  /** Phase 1 reviews market orders only; limit support arrives with live mode. */
  type?: 'market';
}

export interface ReviewAlert {
  type: string;
  details: unknown;
}

export interface ReviewResult {
  symbol: string;
  side: OrderSide;
  quantity: string;
  /**
   * What a market order would realistically fill at right now: the ask for a
   * buy, the bid for a sell, falling back to the last trade when a side of the
   * book is missing. The broker returns no estimate of its own — this is
   * derived, which is exactly why the raw response travels with it.
   */
  estimatedPrice: string;
  /** Empty when the broker raised nothing. Never a reason to place an order. */
  alerts: ReviewAlert[];
  /** The untouched response, persisted as the signal's review_snapshot. */
  raw: unknown;
}

export interface PlaceOrderRequest extends ReviewOrderRequest {
  /** Idempotency key. Every signal carries one from the moment it is created. */
  refId: string;
}

export interface PlaceResult {
  brokerOrderId: string;
  /** The broker's state at placement; fills arrive later, via getEquityOrder. */
  state: string;
  raw: unknown;
}

/** The broker's current view of one order, as the poll job reads it. */
export interface BrokerOrder {
  brokerOrderId: string;
  state: string;
  /** Decimal string. '0' until something fills. */
  cumulativeQuantity: string;
  /** Decimal string, or null while nothing has filled. */
  averagePrice: string | null;
  raw: unknown;
}

/** States after which an order will never fill further. */
export const ORDER_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'filled',
  'cancelled',
  'rejected',
  'failed',
  'voided',
]);

export function isTerminalOrderState(state: string): boolean {
  return ORDER_TERMINAL_STATES.has(state);
}

export interface HistoricalsRequest {
  symbols: readonly string[];
  /** RFC3339 UTC. Required by the server. */
  startTime: string;
  endTime?: string;
  interval?: 'day' | 'hour' | 'minute';
}

export interface BrokerAdapter {
  /** Cached after the first call. Asserts the account is agentic_allowed. */
  getAccountNumber(): Promise<string>;
  getHistoricals(request: HistoricalsRequest): Promise<Record<string, Candle[]>>;
  getQuotes(symbols: readonly string[]): Promise<Record<string, Quote>>;
  getPortfolio(): Promise<Portfolio>;
  getPositions(): Promise<Position[]>;
  reviewEquityOrder(request: ReviewOrderRequest): Promise<ReviewResult>;
  /**
   * The one write. Its sole caller is `LiveExecutor`, behind three gates, and
   * a test asserts that by grep. `refId` is the broker idempotency key: a
   * retried call with the same key is the same order, not a second one.
   */
  placeEquityOrder(request: PlaceOrderRequest): Promise<PlaceResult>;
  /** Null when the broker knows no such order. */
  getEquityOrder(brokerOrderId: string): Promise<BrokerOrder | null>;
  close(): Promise<void>;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

/** No account on this connection may be traded by this agent. */
export class NoAgenticAccountError extends BrokerError {
  constructor() {
    super(
      'no agentic_allowed account is reachable on this connection; the orchestrator ' +
        'trades only in the separate Agentic account',
    );
    this.name = 'NoAgenticAccountError';
  }
}

/**
 * Derives the price a market order would realistically fill at. Kept here
 * rather than inside the MCP client so the mock and the real adapter cannot
 * drift on the one number that becomes the paper fill.
 */
export function estimateFillPrice(
  side: OrderSide,
  quote: {
    lastTradePrice: string;
    bidPrice?: string | null | undefined;
    askPrice?: string | null | undefined;
  },
): string {
  const book = side === 'buy' ? quote.askPrice : quote.bidPrice;
  // A zero or missing side of the book is not a price; the tool guidance says
  // to drop bid/ask when zero, so fall back to the last trade.
  if (book && Number(book) > 0) return book;
  return quote.lastTradePrice;
}
