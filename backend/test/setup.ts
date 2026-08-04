import 'dotenv/config';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';

// Unit tests must not depend on a developer's local .env. Anything that reaches
// the database overrides this explicitly via TEST_DATABASE_URL.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://ollie:ollie@localhost:5432/ollie';
