import 'dotenv/config';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';

// Everything under test — including repository helpers that default to the
// process-wide Prisma client — must reach the throwaway test database, never a
// developer's working data. Nothing in a test may write to the dev DATABASE_URL.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ollie:ollie@localhost:5432/ollie_test';

// The API refuses to build without one. Fixed rather than random so a failing
// assertion prints something recognizable instead of noise.
process.env.OWNER_API_TOKEN = 'test-owner-token-0000000000000000000000';

// The gates are pinned, not inherited. A developer's `.env` with
// LIVE_TRADING_ENABLED=true or KILL_SWITCH=true must not change what the
// suite exercises; a test that wants a gate on sets it in its own config.
process.env.LIVE_TRADING_ENABLED = 'false';
process.env.KILL_SWITCH = 'false';
process.env.AUTONOMY_ENABLED = 'false';
process.env.SIWA_STUB = 'false';
