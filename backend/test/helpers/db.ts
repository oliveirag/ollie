import { PrismaClient } from '@prisma/client';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ollie:ollie@localhost:5432/ollie_test';

let prisma: PrismaClient | null = null;

export function testPrisma(): PrismaClient {
  prisma ??= new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  return prisma;
}

/**
 * TRUNCATE, not DELETE: the immutability triggers are row-level and refuse
 * every delete, which is the point of them. TRUNCATE is statement-level and so
 * bypasses them — the one deliberate escape hatch, available only to test setup
 * because nothing in `src/` issues it.
 */
export async function resetDatabase(): Promise<void> {
  const db = testPrisma();

  // The record tables now refuse TRUNCATE (see the reject_truncate migration),
  // which is the point — but a test database has to be resettable. Replica mode
  // is the narrowest bypass available: triggers created in the default ORIGIN
  // mode do not fire, it lasts only for this session, and it is restored below
  // even if the truncate throws.
  //
  // This is why the guard is a trigger and not, say, a revoked privilege: the
  // bypass has to be deliberate and visible, and it lives in test-only code
  // that production never loads.
  await db.$executeRawUnsafe("SET session_replication_role = 'replica'");
  try {
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE "track_record", "executions", "signal_events", "signals", "devices", "oauth_state" RESTART IDENTITY CASCADE',
    );
  } finally {
    await db.$executeRawUnsafe("SET session_replication_role = 'origin'");
  }
  await db.appSettings.upsert({
    where: { id: 1 },
    update: { killSwitch: false, executionMode: 'paper' },
    create: { id: 1, killSwitch: false, executionMode: 'paper' },
  });
}

export async function closeTestPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

let counter = 0;

/** Unique dedupe key per call, so tests never collide with each other. */
export function uniqueDedupeKey(prefix = 'test'): string {
  counter += 1;
  return `${prefix}:${process.pid}:${Date.now()}:${counter}`;
}
