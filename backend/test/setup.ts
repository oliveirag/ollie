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
