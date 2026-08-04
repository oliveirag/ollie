/**
 * Creates and migrates the integration-test database.
 *
 * Tests run against their own database rather than the dev one for a specific
 * reason: the immutability triggers make cleanup by DELETE impossible, so tests
 * reset state with TRUNCATE — a statement-level operation that row triggers do
 * not see. Pointing that at a developer's working data would be unkind.
 *
 * Runs automatically as npm's `pretest` hook.
 */
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const DEFAULT_TEST_URL = 'postgresql://ollie:ollie@localhost:5432/ollie_test';

async function main(): Promise<void> {
  const testUrl = new URL(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL);
  const dbName = testUrl.pathname.replace(/^\//, '');
  if (!dbName) throw new Error(`TEST_DATABASE_URL has no database name: ${testUrl.href}`);

  const adminUrl = new URL(testUrl.href);
  adminUrl.pathname = '/postgres';

  const admin = new PrismaClient({ datasourceUrl: adminUrl.href });
  try {
    const existing = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      dbName,
    );
    if (existing.length === 0) {
      // Identifier cannot be parameterised; dbName comes from our own env, and
      // quoting it keeps a surprising name from becoming a surprising statement.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`created test database ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl.href },
  });
}

main().catch((error: unknown) => {
  console.error('test database setup failed:', error);
  process.exit(1);
});
