import 'dotenv/config';
import { z } from 'zod';

/**
 * Every tunable lives here and is validated once at boot. A bad value should
 * crash the process on startup, not halfway through a pipeline run holding a
 * half-written signal.
 */

// `.default()` takes the *output* value in zod 4, so these read `false`, not
// `'false'` — the default short-circuits the transform rather than feeding it.
const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: positiveInt.default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  RH_MCP_URL: z.string().url().default('https://agent.robinhood.com/mcp/trading'),
  RH_MCP_AUTH_TOKEN: z.string().default(''),
  // The durable half of the OAuth credential. Obtained by scripts/authorize-rh.ts,
  // which needs a browser; these two are what a deploy actually carries.
  RH_OAUTH_CLIENT_ID: z.string().default(''),
  RH_OAUTH_REFRESH_TOKEN: z.string().default(''),
  RH_ACCOUNT_NUMBER: z.string().default(''),

  SYMBOL_ALLOWLIST: z.string().default('AAPL,MSFT,SPY'),
  CANDLE_LOOKBACK_DAYS: positiveInt.default(180),
  RSI_PERIOD: positiveInt.default(14),
  RSI_OVERSOLD: z.coerce.number().min(0).max(100).default(30),
  RSI_OVERBOUGHT: z.coerce.number().min(0).max(100).default(70),
  MACD_FAST: positiveInt.default(12),
  MACD_SLOW: positiveInt.default(26),
  MACD_SIGNAL: positiveInt.default(9),

  /**
   * Trading days a lot may stay open before the time stop proposes an exit.
   * Exists so a sustained paper run cannot end with zero closed trades — and
   * therefore no win rate and nothing worth publishing — merely because the
   * market never obliged with a crossing. 0 disables it.
   */
  /**
   * When the daily mark runs, ET. After the close by default, so the quote it
   * records is a settled price rather than a mid-session one.
   */
  MARK_CRON: z.string().default('15 16 * * 1-5'),

  MAX_HOLDING_DAYS: z.coerce.number().int().min(0).default(30),

  ORDER_NOTIONAL_CENTS: positiveInt.default(50_000),
  MAX_POSITION_CENTS: positiveInt.default(100_000),
  MAX_DAILY_TRADES: nonNegativeInt.default(3),
  MAX_TOTAL_EXPOSURE_CENTS: positiveInt.default(500_000),

  SLIPPAGE_BPS: nonNegativeInt.default(10),
  SIGNAL_EXPIRY_MINUTES: positiveInt.default(15),

  PIPELINE_CRON: z.string().default('35 9 * * 1-5'),
  EXPIRY_SWEEP_CRON: z.string().default('* * * * *'),
  /**
   * How often the orchestrator looks for an approved-and-filled signal the
   * decision route failed to publish. Bounds the crash window (Phase 4,
   * decision 1); normally finds nothing.
   */
  PUBLISH_SWEEP_CRON: z.string().default('*/5 * * * *'),

  KILL_SWITCH: bool.default(false),
  LIVE_TRADING_ENABLED: bool.default(false),

  /**
   * Bearer credential for the owner API (Phase 2). Empty means "no API",
   * which is why the shape is validated here but the requirement is enforced
   * by the server: the CLIs and the scheduler have no business demanding an
   * HTTP token, and a weak-but-present token is worse than an absent one.
   */
  OWNER_API_TOKEN: z
    .string()
    .min(32, 'must be at least 32 characters; generate with `openssl rand -hex 32`')
    .or(z.literal(''))
    .default(''),

  /**
   * APNs, all optional: with any of them missing the notifier is a no-op and
   * signals are simply not pushed. Push is best-effort by design, so a partial
   * configuration must degrade rather than crash the service.
   *
   * The .p8 is base64-encoded because a PEM's newlines do not survive most
   * environment-variable editors intact.
   */
  APNS_KEY_P8_BASE64: z.string().default(''),
  APNS_KEY_ID: z.string().default(''),
  APNS_TEAM_ID: z.string().default(''),
  APNS_BUNDLE_ID: z.string().default(''),

  /**
   * The signal service (Phase 4). Validated for shape here; the service
   * itself refuses to boot when SIGNAL_DATABASE_URL is unset, the same way the
   * owner API refuses to boot tokenless. The orchestrator never reads these.
   */
  SIGNAL_SERVICE_PORT: positiveInt.default(3100),
  SIGNAL_DATABASE_URL: z.string().url().or(z.literal('')).default(''),
  /** Comma-separated. Empty means no one can complete a first sign-in. */
  SUBSCRIBER_INVITE_CODES: z.string().default(''),
  /** The SIWA audience. Defaults to the app's bundle id. */
  APPLE_APP_BUNDLE_ID: z.string().default('com.guilhermeoliveira.Ollie'),
  /** Advertised to subscribers as the MCP URL after minting a token. */
  SIGNAL_PUBLIC_URL: z.string().url().or(z.literal('')).default(''),
});

export type Env = z.infer<typeof EnvSchema>;

export interface StrategyConfig {
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  /** Target notional per order, in integer cents. Sizing floors to whole shares. */
  orderNotionalCents: number;
  /** 0 disables the time stop entirely. */
  maxHoldingDays: number;
}

export interface RiskConfig {
  symbolAllowlist: readonly string[];
  maxPositionCents: number;
  maxDailyTrades: number;
  maxTotalExposureCents: number;
}

export interface Config {
  env: Env;
  nodeEnv: Env['NODE_ENV'];
  port: number;
  databaseUrl: string;
  logLevel: Env['LOG_LEVEL'];
  symbolAllowlist: readonly string[];
  candleLookbackDays: number;
  strategy: StrategyConfig;
  risk: RiskConfig;
  slippageBps: number;
  signalExpiryMinutes: number;
  pipelineCron: string;
  expirySweepCron: string;
  publishSweepCron: string;
  markCron: string;
  /** Cron expressions above are interpreted in this zone; persistence is always UTC. */
  timezone: string;
  killSwitchEnv: boolean;
  liveTradingEnabled: boolean;
  /** null when unset; the API refuses to start rather than run unauthenticated. */
  ownerApiToken: string | null;
  anthropic: { apiKey: string; model: string };
  /** Empty strings mean push is off; the notifier degrades to a no-op. */
  apns: { keyP8: string; keyId: string; teamId: string; bundleId: string };
  robinhood: {
    mcpUrl: string;
    authToken: string;
    oauthClientId: string;
    oauthRefreshToken: string;
    accountNumber: string | null;
  };
  signalService: {
    port: number;
    /** null when unset; the signal service refuses to start. */
    databaseUrl: string | null;
    inviteCodes: readonly string[];
    appleAudience: string;
    /** null when unset; the mint response then omits the URL. */
    publicUrl: string | null;
  };
}

export const TIMEZONE = 'America/New_York';

function parseSymbols(raw: string): readonly string[] {
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  return Object.freeze([...new Set(symbols)]);
}

export function buildConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  if (env.RSI_OVERSOLD >= env.RSI_OVERBOUGHT) {
    throw new Error(
      `RSI_OVERSOLD (${env.RSI_OVERSOLD}) must be below RSI_OVERBOUGHT (${env.RSI_OVERBOUGHT})`,
    );
  }
  if (env.MACD_FAST >= env.MACD_SLOW) {
    throw new Error(
      `MACD_FAST (${env.MACD_FAST}) must be below MACD_SLOW (${env.MACD_SLOW})`,
    );
  }
  if (env.ORDER_NOTIONAL_CENTS > env.MAX_POSITION_CENTS) {
    throw new Error(
      `ORDER_NOTIONAL_CENTS (${env.ORDER_NOTIONAL_CENTS}) exceeds MAX_POSITION_CENTS ` +
        `(${env.MAX_POSITION_CENTS}); every order would be rejected by the risk gate`,
    );
  }

  const symbolAllowlist = parseSymbols(env.SYMBOL_ALLOWLIST);
  if (symbolAllowlist.length === 0) {
    throw new Error('SYMBOL_ALLOWLIST must name at least one symbol');
  }

  return {
    env,
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    symbolAllowlist,
    candleLookbackDays: env.CANDLE_LOOKBACK_DAYS,
    strategy: {
      rsiPeriod: env.RSI_PERIOD,
      rsiOversold: env.RSI_OVERSOLD,
      rsiOverbought: env.RSI_OVERBOUGHT,
      macdFast: env.MACD_FAST,
      macdSlow: env.MACD_SLOW,
      macdSignal: env.MACD_SIGNAL,
      orderNotionalCents: env.ORDER_NOTIONAL_CENTS,
      maxHoldingDays: env.MAX_HOLDING_DAYS,
    },
    risk: {
      symbolAllowlist,
      maxPositionCents: env.MAX_POSITION_CENTS,
      maxDailyTrades: env.MAX_DAILY_TRADES,
      maxTotalExposureCents: env.MAX_TOTAL_EXPOSURE_CENTS,
    },
    slippageBps: env.SLIPPAGE_BPS,
    signalExpiryMinutes: env.SIGNAL_EXPIRY_MINUTES,
    pipelineCron: env.PIPELINE_CRON,
    expirySweepCron: env.EXPIRY_SWEEP_CRON,
    publishSweepCron: env.PUBLISH_SWEEP_CRON,
    markCron: env.MARK_CRON,
    timezone: TIMEZONE,
    killSwitchEnv: env.KILL_SWITCH,
    liveTradingEnabled: env.LIVE_TRADING_ENABLED,
    ownerApiToken: env.OWNER_API_TOKEN || null,
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL },
    apns: {
      keyP8: env.APNS_KEY_P8_BASE64
        ? Buffer.from(env.APNS_KEY_P8_BASE64, 'base64').toString('utf8')
        : '',
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      bundleId: env.APNS_BUNDLE_ID,
    },
    robinhood: {
      mcpUrl: env.RH_MCP_URL,
      authToken: env.RH_MCP_AUTH_TOKEN,
      oauthClientId: env.RH_OAUTH_CLIENT_ID,
      oauthRefreshToken: env.RH_OAUTH_REFRESH_TOKEN,
      accountNumber: env.RH_ACCOUNT_NUMBER || null,
    },
    signalService: {
      port: env.SIGNAL_SERVICE_PORT,
      databaseUrl: env.SIGNAL_DATABASE_URL || null,
      inviteCodes: Object.freeze(
        env.SUBSCRIBER_INVITE_CODES.split(',')
          .map((code) => code.trim())
          .filter((code) => code.length > 0),
      ),
      appleAudience: env.APPLE_APP_BUNDLE_ID,
      publicUrl: env.SIGNAL_PUBLIC_URL || null,
    },
  };
}

let cached: Config | null = null;

/** Process-wide config. Throws on first access if the environment is invalid. */
export function getConfig(): Config {
  cached ??= buildConfig();
  return cached;
}
