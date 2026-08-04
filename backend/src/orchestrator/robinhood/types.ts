import { z } from 'zod';

/**
 * Wire schemas for the Robinhood Trading MCP, frozen from responses observed
 * against the live server on 2026-08-04 (see scripts/introspect-mcp.ts and
 * test/fixtures/mcp/). Re-run the introspect script and update these together
 * if the server changes.
 *
 * Two rules hold throughout:
 *
 * 1. **Every price and quantity is a decimal string on the wire and stays a
 *    string here.** No schema in this file coerces money to a number. Parsing
 *    "308.570000" into a float is how a fill price becomes almost right.
 * 2. **Every object passes through unknown keys and the raw response is
 *    persisted alongside the parsed one.** These schemas describe what the
 *    server sent one afternoon, not a contract it owes us.
 */

/** A decimal number carried as a string, e.g. "308.570000". */
export const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');

export const AccountSchema = z
  .object({
    account_number: z.string(),
    rhs_account_number: z.string().optional(),
    type: z.string().optional(),
    brokerage_account_type: z.string().optional(),
    nickname: z.string().optional(),
    is_default: z.boolean().optional(),
    /**
     * Caller-relative: true means this agent may act on the account. Trading
     * lives in a separate Agentic account, so this is the field that decides
     * which account the orchestrator is even allowed to review against.
     */
    agentic_allowed: z.boolean(),
    state: z.string().optional(),
    deactivated: z.boolean().optional(),
    unsettled_funds: DecimalString.optional(),
  })
  .passthrough();

export const GetAccountsSchema = z
  .object({ accounts: z.array(AccountSchema) })
  .passthrough();

export const BuyingPowerSchema = z
  .object({
    buying_power: DecimalString,
    unleveraged_buying_power: DecimalString.optional(),
    display_currency: z.string().optional(),
  })
  .passthrough();

export const PortfolioSchema = z
  .object({
    total_value: DecimalString,
    equity_value: DecimalString.optional(),
    options_value: DecimalString.optional(),
    crypto_value: DecimalString.optional(),
    cash: DecimalString.optional(),
    currency: z.string().optional(),
    buying_power: BuyingPowerSchema,
  })
  .passthrough();

/**
 * Shape taken from the tool's own guidance rather than a populated response:
 * the Agentic account held no positions when this was captured. Everything but
 * symbol and quantity is optional until a non-empty response confirms it.
 */
export const PositionSchema = z
  .object({
    symbol: z.string(),
    quantity: DecimalString,
    /** Sellable now. Differs from quantity when shares are held or unsettled. */
    shares_available_for_sells: DecimalString.optional(),
    average_buy_price: DecimalString.optional(),
    intraday_quantity: DecimalString.optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const GetPositionsSchema = z
  .object({ positions: z.array(PositionSchema), next: z.string().nullish() })
  .passthrough();

export const QuoteSchema = z
  .object({
    symbol: z.string(),
    last_trade_price: DecimalString,
    bid_price: DecimalString.nullish(),
    ask_price: DecimalString.nullish(),
    previous_close: DecimalString.nullish(),
    adjusted_previous_close: DecimalString.nullish(),
    previous_close_date: z.string().nullish(),
    has_traded: z.boolean().optional(),
    /** Anything other than 'active' means the price is not tradeable-fresh. */
    state: z.string().optional(),
  })
  .passthrough();

export const OfficialCloseSchema = z
  .object({
    symbol: z.string(),
    date: z.string(),
    price: DecimalString,
    interpolated: z.boolean().optional(),
    source: z.string().optional(),
  })
  .passthrough();

export const GetQuotesSchema = z
  .object({
    results: z.array(
      z.object({ quote: QuoteSchema, close: OfficialCloseSchema.nullish() }).passthrough(),
    ),
    closes_error: z.unknown().optional(),
  })
  .passthrough();

export const BarSchema = z
  .object({
    begins_at: z.string(),
    open_price: DecimalString,
    high_price: DecimalString,
    low_price: DecimalString,
    close_price: DecimalString,
    volume: z.number(),
    session: z.string().optional(),
    /**
     * Present and true only on synthesized gap-fill bars. Absent means a real
     * bar. These must be dropped before any indicator sees them — a fabricated
     * close would produce a fabricated crossing.
     */
    interpolated: z.boolean().optional(),
  })
  .passthrough();

export const HistoricalsResultSchema = z
  .object({
    symbol: z.string(),
    interval: z.string().optional(),
    bounds: z.string().optional(),
    bars: z.array(BarSchema),
  })
  .passthrough();

export const GetHistoricalsSchema = z
  .object({ results: z.array(HistoricalsResultSchema) })
  .passthrough();

/**
 * Pre-trade alerts. Observed as an object keyed by alertType — `{}` when the
 * broker raised nothing — not the array the shape of "alerts" suggests. The
 * detail payload varies per alert type, so it is kept as passthrough and
 * persisted verbatim.
 */
export const OrderChecksSchema = z
  .object({ alertType: z.string().optional() })
  .passthrough();

export const ReviewEquityOrderSchema = z
  .object({
    symbol: z.string(),
    side: z.string(),
    type: z.string(),
    quantity: DecimalString.optional(),
    dollar_amount: DecimalString.optional(),
    order_checks: OrderChecksSchema.default({}),
    quote_data: QuoteSchema,
    /** Compliance disclosure string; persisted with the snapshot. */
    market_data_disclosure: z.string().optional(),
  })
  .passthrough();

export type RawAccount = z.infer<typeof AccountSchema>;
export type RawPortfolio = z.infer<typeof PortfolioSchema>;
export type RawPosition = z.infer<typeof PositionSchema>;
export type RawQuote = z.infer<typeof QuoteSchema>;
export type RawBar = z.infer<typeof BarSchema>;
export type RawReview = z.infer<typeof ReviewEquityOrderSchema>;
