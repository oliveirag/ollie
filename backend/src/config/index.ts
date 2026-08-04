import 'dotenv/config';
import { z } from 'zod';

/**
 * Every tunable lives here and is validated once at boot. A bad value should
 * crash the process on startup, not halfway through a pipeline run holding a
 * half-written signal.
 */

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

  ORDER_NOTIONAL_CENTS: positiveInt.default(50_000),
  MAX_POSITION_CENTS: positiveInt.default(100_000),
  MAX_DAILY_TRADES: nonNegativeInt.default(3),
  MAX_TOTAL_EXPOSURE_CENTS: positiveInt.default(500_000),

  SLIPPAGE_BPS: nonNegativeInt.default(10),
  SIGNAL_EXPIRY_MINUTES: positiveInt.default(15),

  PIPELINE_CRON: z.string().default('35 9 * * 1-5'),
  EXPIRY_SWEEP_CRON: z.string().default('* * * * *'),

  KILL_SWITCH: bool.default('false'),
  LIVE_TRADING_ENABLED: bool.default('false'),
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
  /** Cron expressions above are interpreted in this zone; persistence is always UTC. */
  timezone: string;
  killSwitchEnv: boolean;
  liveTradingEnabled: boolean;
  anthropic: { apiKey: string; model: string };
  robinhood: {
    mcpUrl: string;
    authToken: string;
    oauthClientId: string;
    oauthRefreshToken: string;
    accountNumber: string | null;
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
    timezone: TIMEZONE,
    killSwitchEnv: env.KILL_SWITCH,
    liveTradingEnabled: env.LIVE_TRADING_ENABLED,
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL },
    robinhood: {
      mcpUrl: env.RH_MCP_URL,
      authToken: env.RH_MCP_AUTH_TOKEN,
      oauthClientId: env.RH_OAUTH_CLIENT_ID,
      oauthRefreshToken: env.RH_OAUTH_REFRESH_TOKEN,
      accountNumber: env.RH_ACCOUNT_NUMBER || null,
    },
  };
}

let cached: Config | null = null;

/** Process-wide config. Throws on first access if the environment is invalid. */
export function getConfig(): Config {
  cached ??= buildConfig();
  return cached;
}
