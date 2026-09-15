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
const DEFAULT_SIGNAL_TEST_URL = 'postgresql://ollie_signal:ollie_signal@localhost:5432/ollie_test';

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

  // The migration creates the subscriber service's role without a password —
  // credentials are per-environment, never in a migration file. The suite
  // connects as that role to prove its denials, so the throwaway test cluster
  // gets one here, taken from the same URL the tests connect with. Local
  // scratch credentials only, on the same footing as `ollie:ollie` above.
  const signalUrl = new URL(process.env.SIGNAL_TEST_DATABASE_URL ?? DEFAULT_SIGNAL_TEST_URL);
  const role = decodeURIComponent(signalUrl.username);
  const password = decodeURIComponent(signalUrl.password);
  if (!role || !password) {
    throw new Error('SIGNAL_TEST_DATABASE_URL must carry a role and password');
  }
  const test = new PrismaClient({ datasourceUrl: testUrl.href });
  try {
    await test.$executeRawUnsafe(
      `ALTER ROLE "${role.replace(/"/g, '""')}" WITH PASSWORD '${password.replace(/'/g, "''")}'`,
    );
  } finally {
    await test.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('test database setup failed:', error);
  process.exit(1);
});
