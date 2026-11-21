import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { ZodType } from 'zod';
import type { Logger } from 'pino';
import { getConfig, type Config } from '../../config/index.js';
import { logger as rootLogger } from '../../logger.js';
import { RhOAuthProvider } from './oauth.js';
import { PrismaOAuthStateStore } from '../../db/oauthState.js';
import {
  BrokerError,
  NoAgenticAccountError,
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
import {
  GetAccountsSchema,
  GetEquityOrdersSchema,
  GetHistoricalsSchema,
  PlaceEquityOrderSchema,
  type RawEquityOrder,
  GetPositionsSchema,
  GetQuotesSchema,
  PortfolioSchema,
  ReviewEquityOrderSchema,
} from './types.js';

/** The server caps a historicals request at 10 symbols. */
const MAX_SYMBOLS_PER_HISTORICALS_CALL = 10;
const MAX_ATTEMPTS = 3;

export interface McpBrokerOptions {
  url?: string;
  authToken?: string;
  /**
   * Supplies and refreshes OAuth tokens. When present the transport renews an
   * expired access token itself, so `authToken` is only a fallback for a manual
   * run with a token pasted into the environment.
   */
  authProvider?: OAuthClientProvider;
  /** Pins the account instead of discovering it. Still checked for agentic access. */
  accountNumber?: string | null;
  logger?: Logger;
}

/**
 * Builds an auth provider from a stored refresh token, or returns null when none
 * is configured so the static-token path still works.
 *
 * Note what is *not* here: any way to obtain a first token. That requires a
 * browser (see scripts/authorize-rh.ts), and a server process that could block
 * on one would be a worse failure than a clear error.
 */
function buildConfiguredAuthProvider(config: Config): OAuthClientProvider | null {
  const { oauthClientId, oauthRefreshToken } = config.robinhood;

  // The database is the credential's home, because Robinhood rotates refresh
  // tokens on use and the replacement has to be written somewhere the running
  // process can reach. The environment is only a seed for the first boot; after
  // that `bootstrapOAuthState` leaves the stored value alone.
  //
  // Still gated on the environment carrying *something*, so a deploy with no
  // credential at all keeps failing loudly at startup rather than silently
  // running brokerless.
  if (!oauthClientId && !oauthRefreshToken) return null;

  return new RhOAuthProvider({ store: new PrismaOAuthStateStore() });
}

/**
 * Real Robinhood Trading MCP adapter.
 *
 * Notably absent: any arithmetic. Prices arrive as decimal strings and leave as
 * decimal strings. The one derived number, the market-order fill estimate, is
 * a selection between quoted strings, not a computation.
 */
export class McpBrokerAdapter implements BrokerAdapter {
  private readonly url: string;
  private readonly authToken: string;
  private readonly authProvider: OAuthClientProvider | null;
  private readonly pinnedAccount: string | null;
  private readonly log: Logger;

  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Suffix -> the name this server actually exposes; see resolveToolNames. */
  private toolNames = new Map<string, string>();
  private accountNumber: string | null = null;

  constructor(options: McpBrokerOptions = {}) {
    const config = getConfig();
    this.url = options.url ?? config.robinhood.mcpUrl;
    this.authToken = options.authToken ?? config.robinhood.authToken;
    this.authProvider = options.authProvider ?? buildConfiguredAuthProvider(config);
    this.pinnedAccount = options.accountNumber ?? config.robinhood.accountNumber;
    this.log = (options.logger ?? rootLogger).child({ component: 'rh-mcp' });
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    // Concurrent callers share one connection attempt rather than racing to
    // open several sessions against the broker.
    this.connecting ??= this.openConnection();
    try {
      this.client = await this.connecting;
      return this.client;
    } finally {
      this.connecting = null;
    }
  }

  private async openConnection(): Promise<Client> {
    if (!this.authProvider && !this.authToken) {
      throw new BrokerError(
        'no Robinhood credential configured; set RH_OAUTH_CLIENT_ID and ' +
          'RH_OAUTH_REFRESH_TOKEN (run `npm run rh:authorize` to obtain them), ' +
          'or RH_MCP_AUTH_TOKEN for a one-off manual run',
      );
    }

    const client = new Client(
      { name: 'ollie-orchestrator', version: '0.1.0' },
      { capabilities: {} },
    );
    // With an authProvider the SDK owns the Authorization header and refreshes
    // the token on expiry; the static header is only for the fallback path.
    const transport = new StreamableHTTPClientTransport(
      new URL(this.url),
      this.authProvider
        ? { authProvider: this.authProvider }
        : { requestInit: { headers: { Authorization: `Bearer ${this.authToken}` } } },
    );

    try {
      // The SDK's Transport interface declares `sessionId?: string` while the
      // transport class declares `string | undefined`, which this project's
      // exactOptionalPropertyTypes treats as different types. Upstream typing
      // mismatch, not a real incompatibility.
      await client.connect(transport as Parameters<Client['connect']>[0]);
    } catch (error) {
      throw new BrokerError(`failed to connect to ${this.url}`, error);
    }

    try {
      await this.resolveToolNames(client);
    } catch (error) {
      // Connected but unusable: close it rather than leak an open session.
      await client.close().catch(() => undefined);
      throw error;
    }
    this.log.info({ url: this.url, tools: this.toolNames.size }, 'connected to trading MCP');
    return client;
  }

  /**
   * Tool names differ by how the server is reached: the direct endpoint exposes
   * `get_accounts` while a connector prefixes it. Resolving by suffix once at
   * connect time means the rest of this class names tools the short way and
   * still works through either path.
   */
  private async resolveToolNames(client: Client): Promise<void> {
    const { tools } = await client.listTools();
    this.toolNames = new Map();
    for (const tool of tools) {
      const short = tool.name.split('__').pop() ?? tool.name;
      this.toolNames.set(short, tool.name);
    }
  }

  private toolName(short: string): string {
    const resolved = this.toolNames.get(short);
    if (!resolved) {
      throw new BrokerError(
        `the trading MCP does not expose a tool named ${short}; saw: ` +
          `${[...this.toolNames.keys()].sort().join(', ')}`,
      );
    }
    return resolved;
  }

  /**
   * Calls a tool, unwraps the `{ data, guide }` envelope, and validates `data`.
   * Retries on transient failures with backoff — rate limits on this server are
   * undocumented, so assume they exist.
   */
  private async call<T>(
    short: string,
    args: Record<string, unknown>,
    schema: ZodType<T>,
  ): Promise<{ parsed: T; raw: unknown }> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const client = await this.connect();
        const result = await client.callTool({ name: this.toolName(short), arguments: args });

        if (result.isError) {
          throw new ToolResultError(short, result.content);
        }

        const raw = unwrapToolResult(result.content, short);
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          // A shape change is not retryable and must not be papered over: the
          // adapter's whole job is to be the one place that knows the wire.
          throw new BrokerError(
            `${short} returned an unexpected shape: ${parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          );
        }
        return { parsed: parsed.data, raw };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error, short) || attempt === MAX_ATTEMPTS) break;

        const backoffMs = 500 * 2 ** (attempt - 1);
        this.log.warn(
          { tool: short, attempt, backoff_ms: backoffMs, err: error },
          'trading MCP call failed, retrying',
        );
        // A failed call may have left the session unusable; close it and let
        // the next attempt reconnect. Dropping it unclosed would leave the
        // broker holding a session nobody will ever end.
        await this.dropClient();
        await sleep(backoffMs);
      }
    }

    throw lastError instanceof BrokerError
      ? lastError
      : new BrokerError(`${short} failed`, lastError);
  }

  async getAccountNumber(): Promise<string> {
    if (this.accountNumber) return this.accountNumber;

    const { parsed } = await this.call('get_accounts', {}, GetAccountsSchema);
    const agentic = parsed.accounts.filter((a) => a.agentic_allowed);

    if (this.pinnedAccount) {
      const pinned = parsed.accounts.find((a) => a.account_number === this.pinnedAccount);
      if (!pinned) {
        throw new BrokerError(`RH_ACCOUNT_NUMBER is not an account on this connection`);
      }
      if (!pinned.agentic_allowed) {
        throw new BrokerError(
          'RH_ACCOUNT_NUMBER names an account this agent may not trade ' +
            '(agentic_allowed=false); use the separate Agentic account',
        );
      }
      this.accountNumber = pinned.account_number;
    } else {
      if (agentic.length === 0) throw new NoAgenticAccountError();
      if (agentic.length > 1) {
        throw new BrokerError(
          `${agentic.length} agentic accounts are reachable; set RH_ACCOUNT_NUMBER to ` +
            'name the one Ollie should trade',
        );
      }
      this.accountNumber = agentic[0]!.account_number;
    }

    this.log.info(
      { account_suffix: this.accountNumber.slice(-4) },
      'resolved agentic trading account',
    );
    return this.accountNumber;
  }

  async getHistoricals(request: HistoricalsRequest): Promise<Record<string, Candle[]>> {
    const symbols = [...request.symbols];
    const bySymbol: Record<string, Candle[]> = {};

    for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_HISTORICALS_CALL) {
      const batch = symbols.slice(i, i + MAX_SYMBOLS_PER_HISTORICALS_CALL);
      const { parsed } = await this.call(
        'get_equity_historicals',
        {
          symbols: batch,
          start_time: request.startTime,
          ...(request.endTime ? { end_time: request.endTime } : {}),
          interval: request.interval ?? 'day',
          bounds: 'regular',
          adjustment_type: 'split',
        },
        GetHistoricalsSchema,
      );

      for (const result of parsed.results) {
        bySymbol[result.symbol] = result.bars.map((bar) => ({
          t: bar.begins_at,
          o: bar.open_price,
          h: bar.high_price,
          l: bar.low_price,
          c: bar.close_price,
          v: bar.volume,
          ...(bar.interpolated === undefined ? {} : { interpolated: bar.interpolated }),
        }));
      }
    }

    return bySymbol;
  }

  async getQuotes(symbols: readonly string[]): Promise<Record<string, Quote>> {
    const { parsed } = await this.call(
      'get_equity_quotes',
      { symbols: [...symbols] },
      GetQuotesSchema,
    );

    const bySymbol: Record<string, Quote> = {};
    for (const result of parsed.results) {
      bySymbol[result.quote.symbol] = {
        symbol: result.quote.symbol,
        lastTradePrice: result.quote.last_trade_price,
        bidPrice: result.quote.bid_price ?? null,
        askPrice: result.quote.ask_price ?? null,
        previousClose: result.quote.previous_close ?? null,
        officialClose: result.close?.price ?? null,
        hasTraded: result.quote.has_traded ?? true,
        state: result.quote.state ?? 'unknown',
        lastTradeAt: result.quote.venue_last_trade_time ?? null,
      };
    }
    return bySymbol;
  }

  async getPortfolio(): Promise<Portfolio> {
    const accountNumber = await this.getAccountNumber();
    const { parsed } = await this.call(
      'get_portfolio',
      { account_number: accountNumber },
      PortfolioSchema,
    );
    return {
      totalValue: parsed.total_value,
      equityValue: parsed.equity_value ?? null,
      cash: parsed.cash ?? null,
      buyingPower: parsed.buying_power.buying_power,
      currency: parsed.currency ?? 'USD',
    };
  }

  async getPositions(): Promise<Position[]> {
    const accountNumber = await this.getAccountNumber();
    const positions: Position[] = [];
    let cursor: string | undefined;

    do {
      const { parsed } = await this.call(
        'get_equity_positions',
        { account_number: accountNumber, ...(cursor ? { cursor } : {}) },
        GetPositionsSchema,
      );
      for (const position of parsed.positions) {
        positions.push({
          symbol: position.symbol,
          quantity: position.quantity,
          // Held or unsettled shares are not sellable; when the server omits
          // the field, assume the whole position is, and let the review call
          // be the one that says otherwise.
          sharesAvailableForSells: position.shares_available_for_sells ?? position.quantity,
          averageBuyPrice: position.average_buy_price ?? null,
        });
      }
      cursor = parsed.next ? (new URL(parsed.next).searchParams.get('cursor') ?? undefined) : undefined;
    } while (cursor);

    return positions;
  }

  async reviewEquityOrder(request: ReviewOrderRequest): Promise<ReviewResult> {
    const accountNumber = await this.getAccountNumber();
    const { parsed, raw } = await this.call(
      'review_equity_order',
      {
        account_number: accountNumber,
        symbol: request.symbol,
        side: request.side,
        type: request.type ?? 'market',
        quantity: request.quantity,
        time_in_force: 'gfd',
        // Market orders are regular-hours-only; tagging them to another
        // session is rejected outright by the server.
        market_hours: 'regular_hours',
      },
      ReviewEquityOrderSchema,
    );

    const alerts = toAlerts(parsed.order_checks ?? {});
    if (alerts.length > 0) {
      this.log.warn(
        { symbol: request.symbol, side: request.side, alerts: alerts.map((a) => a.type) },
        'broker raised pre-trade alerts',
      );
    }

    return {
      symbol: parsed.symbol,
      side: request.side,
      quantity: parsed.quantity ?? request.quantity,
      estimatedPrice: estimateFillPrice(request.side, {
        lastTradePrice: parsed.quote_data.last_trade_price,
        bidPrice: parsed.quote_data.bid_price,
        askPrice: parsed.quote_data.ask_price,
      }),
      alerts,
      raw,
    };
  }

  /**
   * The real order. Market, regular hours, good-for-day — the same terms the
   * review was run under, so the review snapshot describes this order and
   * not a cousin of it. `ref_id` is the signal's idempotency key: the retry
   * loop in `call` may resend on a transport error, and the broker treats a
   * repeated key as the same order rather than a second fill. It never
   * resends after the broker has answered with an error (`isRetryable`).
   */
  async placeEquityOrder(request: PlaceOrderRequest): Promise<PlaceResult> {
    const accountNumber = await this.getAccountNumber();
    const { parsed, raw } = await this.call(
      'place_equity_order',
      {
        account_number: accountNumber,
        symbol: request.symbol,
        side: request.side,
        type: request.type ?? 'market',
        quantity: request.quantity,
        time_in_force: 'gfd',
        market_hours: 'regular_hours',
        ref_id: request.refId,
      },
      PlaceEquityOrderSchema,
    );
    const order: RawEquityOrder =
      'order' in parsed && parsed.order
        ? (parsed.order as RawEquityOrder)
        : (parsed as RawEquityOrder);
    this.log.warn(
      { symbol: request.symbol, side: request.side, quantity: request.quantity, order_id: order.id, state: order.state },
      'LIVE ORDER PLACED',
    );
    return { brokerOrderId: order.id, state: order.state, raw };
  }

  async getEquityOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    const accountNumber = await this.getAccountNumber();
    const { parsed, raw } = await this.call(
      'get_equity_orders',
      { account_number: accountNumber, order_id: brokerOrderId },
      GetEquityOrdersSchema,
    );
    // Exact id only. A filtered response that omits the requested order is
    // "no such order", never "some other order" — attributing a different
    // order's fill to this row would corrupt the record.
    const order = parsed.orders.find((o) => o.id === brokerOrderId);
    if (!order) return null;
    return {
      brokerOrderId: order.id,
      state: order.state,
      cumulativeQuantity: order.cumulative_quantity ?? '0',
      averagePrice: order.average_price ?? null,
      raw,
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  private async dropClient(): Promise<void> {
    const stale = this.client;
    this.client = null;
    if (!stale) return;
    try {
      await stale.close();
    } catch (error) {
      this.log.debug({ err: error }, 'closing the stale trading MCP session failed');
    }
  }
}

/**
 * The server answered the call and said no (`isError`). For an order this is
 * a business decision — a rejection, a halted symbol, insufficient buying
 * power — and never something a retry should resend.
 */
export class ToolResultError extends BrokerError {
  constructor(
    readonly tool: string,
    readonly content: unknown,
  ) {
    super(`${tool} returned an error: ${JSON.stringify(content)}`);
    this.name = 'ToolResultError';
  }
}

/** Pulls the `data` payload out of an MCP tool result's text content. */
export function unwrapToolResult(content: unknown, toolName: string): unknown {
  if (!Array.isArray(content)) {
    throw new BrokerError(`${toolName} returned no content`);
  }
  const text = content.find(
    (part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
  );
  if (!text) throw new BrokerError(`${toolName} returned no text content`);

  let envelope: unknown;
  try {
    envelope = JSON.parse(text.text);
  } catch (error) {
    throw new BrokerError(`${toolName} returned content that is not JSON`, error);
  }

  // Responses arrive as { data, guide }; the guide is prose aimed at a chat
  // agent and is deliberately dropped here.
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    return (envelope as { data: unknown }).data;
  }
  return envelope;
}

/**
 * order_checks arrives as an object keyed by alert type, `{}` when clean, not
 * as the array its name suggests. Normalising it here keeps that surprise in
 * one place.
 */
export function toAlerts(orderChecks: Record<string, unknown>): ReviewAlert[] {
  const alertType = orderChecks['alertType'];
  if (typeof alertType !== 'string' || alertType.length === 0) return [];

  const details = Object.entries(orderChecks).find(
    ([key]) => key !== 'alertType' && key.toLowerCase().includes('details'),
  );
  return [{ type: alertType, details: details ? details[1] : orderChecks }];
}

/** The error, its `cause`, that one's `cause`, and so on (bounded). */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current != null && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

const NOT_RETRYABLE =
  /unexpected shape|does not expose a tool|no Robinhood credential configured|RH_MCP_AUTH_TOKEN|rh:authorize/i;
const TRANSIENT_TEXT =
  /rate.?limit|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT)/i;
/**
 * A 429 or 5xx standing alone. Not inside a longer number or a price: a
 * rejection quoting "512.30" or "$503" is not a server error.
 */
const STATUS_IN_TEXT = /(?<![\d.$])\b(?:429|5\d\d)\b(?!\.\d)/;

function isRetryableStatus(value: unknown): boolean {
  return typeof value === 'number' && (value === 429 || (value >= 500 && value <= 599));
}

/**
 * Whether a failed call is worth another attempt.
 *
 * Walks the `cause` chain, because the useful part is often underneath: a
 * connect failure arrives as "failed to connect to <url>" wrapping undici's
 * "fetch failed" wrapping `{ code: 'ECONNREFUSED' }`, and the SDK's HTTP
 * error carries its status as a numeric `code`, not in the text.
 *
 * `place_equity_order` is never retried on an answer from the server: the
 * `ref_id` makes a resend after a transport failure safe, but a rejection is
 * the broker's decision, and resending it is at best noise and at worst an
 * order the owner did not approve on those terms.
 */
export function isRetryable(error: unknown, tool?: string): boolean {
  const chain = errorChain(error);

  if (tool === 'place_equity_order' && chain.some((e) => e instanceof ToolResultError)) {
    return false;
  }

  const messages = chain.map((e) => (e instanceof Error ? e.message : String(e)));
  // A missing or unrenewable credential will not fix itself; retrying only
  // delays the error. `npm run rh:authorize` names the expired-authorization
  // case raised by RhOAuthProvider.
  if (messages.some((m) => NOT_RETRYABLE.test(m))) return false;

  for (const link of chain) {
    if (typeof link !== 'object' || link === null) continue;
    const { code, status } = link as { code?: unknown; status?: unknown };
    if (isRetryableStatus(code) || isRetryableStatus(status)) return true;
    if (typeof code === 'string' && TRANSIENT_TEXT.test(code)) return true;
  }

  return messages.some((m) => TRANSIENT_TEXT.test(m) || STATUS_IN_TEXT.test(m));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
