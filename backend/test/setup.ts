import 'dotenv/config';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';

// Signals' created_at is stamped by the database with the real time, so the
// default window (to the session's 16:00 ET close) would make every expiry
// assertion depend on when the suite runs. Tests get the fixed floor window;
// the close-based window is tested directly in expiry.test.ts with fixed dates.
process.env.SIGNAL_EXPIRES_AT_CLOSE = 'false';

// Everything under test — including repository helpers that default to the
// process-wide Prisma client — must reach the throwaway test database, never a
// developer's working data. Nothing in a test may write to the dev DATABASE_URL.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ollie:ollie@localhost:5432/ollie_test';

// The API refuses to build without one. Fixed rather than random so a failing
// assertion prints something recognizable instead of noise.
process.env.OWNER_API_TOKEN = 'test-owner-token-0000000000000000000000';
