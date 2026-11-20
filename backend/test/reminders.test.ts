import type { Signal } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, type Config } from '../src/config/index.js';
import { insertSignal, transitionSignal } from '../src/db/signals.js';
import { signalExpiresAt } from '../src/orchestrator/expiry.js';
import type { Notifier } from '../src/orchestrator/push/notify.js';
import { sweepReminders } from '../src/orchestrator/reminders.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();
const logger = pino({ level: 'silent' });

function config(overrides: Record<string, string> = {}): Config {
  return buildConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    LOG_LEVEL: 'silent',
    // created_at is stamped by the database with the real time, so the tests
    // pin the window to the floor and move the sweep's clock relative to it.
    SIGNAL_EXPIRES_AT_CLOSE: 'false',
    SIGNAL_EXPIRY_MINUTES: '120',
    SIGNAL_REMINDER_MINUTES: '30',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function recordingNotifier() {
  const reminded: Array<{ id: string; expiresAt: Date }> = [];
  const notifier: Notifier = {
    async notifyNewSignal() {},
    async remindPendingSignal(signal: Signal, expiresAt: Date) {
      reminded.push({ id: signal.id, expiresAt });
    },
  };
  return { notifier, reminded };
}

async function seedSignal() {
  return insertSignal(
    {
      symbol: 'AAPL',
      side: 'buy',
      signalType: 'technical',
      quantity: '2',
      thesis: 'MACD crossed bullish.',
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: {
        schema_version: 1,
        estimated_price: '182.50',
        alerts: [],
        requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' },
        captured_at: new Date().toISOString(),
        raw: {},
      },
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
    },
    db,
  );
}

/** A clock `minutes` before the signal's expiry. */
function beforeExpiry(signal: Signal, cfg: Config, minutes: number) {
  return () => new Date(signalExpiresAt(signal.createdAt, cfg).getTime() - minutes * 60_000);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('sweepReminders', () => {
  it('stays quiet before the reminder time', async () => {
    const cfg = config();
    const signal = await seedSignal();
    const { notifier, reminded } = recordingNotifier();

    await sweepReminders({ config: cfg, logger, notifier, sent: new Set(), prisma: db, clock: beforeExpiry(signal, cfg, 31) });

    expect(reminded).toHaveLength(0);
  });

  it('reminds once inside the window, with the expiry it is warning about', async () => {
    const cfg = config();
    const signal = await seedSignal();
    const { notifier, reminded } = recordingNotifier();
    const sent = new Set<string>();

    await sweepReminders({ config: cfg, logger, notifier, sent, prisma: db, clock: beforeExpiry(signal, cfg, 29) });
    // The next minute's sweep must not send it again.
    await sweepReminders({ config: cfg, logger, notifier, sent, prisma: db, clock: beforeExpiry(signal, cfg, 28) });

    expect(reminded).toHaveLength(1);
    expect(reminded[0]!.id).toBe(signal.id);
    expect(reminded[0]!.expiresAt.getTime()).toBe(signalExpiresAt(signal.createdAt, cfg).getTime());
  });

  it('skips a signal the owner already decided', async () => {
    const cfg = config();
    const signal = await seedSignal();
    await transitionSignal(signal.id, 'rejected', 'no', { prisma: db });
    const { notifier, reminded } = recordingNotifier();

    await sweepReminders({ config: cfg, logger, notifier, sent: new Set(), prisma: db, clock: beforeExpiry(signal, cfg, 10) });

    expect(reminded).toHaveLength(0);
  });

  it('does not remind after the deadline', async () => {
    const cfg = config();
    const signal = await seedSignal();
    const { notifier, reminded } = recordingNotifier();

    await sweepReminders({ config: cfg, logger, notifier, sent: new Set(), prisma: db, clock: beforeExpiry(signal, cfg, 0) });

    expect(reminded).toHaveLength(0);
  });

  it('skips a window shorter than the lead time, where the first push already covers it', async () => {
    const cfg = config({ SIGNAL_EXPIRY_MINUTES: '15' });
    const signal = await seedSignal();
    const { notifier, reminded } = recordingNotifier();

    await sweepReminders({ config: cfg, logger, notifier, sent: new Set(), prisma: db, clock: beforeExpiry(signal, cfg, 5) });

    expect(reminded).toHaveLength(0);
  });

  it('is off at SIGNAL_REMINDER_MINUTES=0', async () => {
    const cfg = config({ SIGNAL_REMINDER_MINUTES: '0' });
    const signal = await seedSignal();
    const { notifier, reminded } = recordingNotifier();

    await sweepReminders({ config: cfg, logger, notifier, sent: new Set(), prisma: db, clock: beforeExpiry(signal, cfg, 10) });

    expect(reminded).toHaveLength(0);
  });

  it('marks a reminder sent even when the notifier throws, so it cannot repeat every minute', async () => {
    const cfg = config();
    const signal = await seedSignal();
    let calls = 0;
    const notifier: Notifier = {
      async notifyNewSignal() {},
      async remindPendingSignal() {
        calls += 1;
        throw new Error('push is down');
      },
    };
    const sent = new Set<string>();

    await sweepReminders({ config: cfg, logger, notifier, sent, prisma: db, clock: beforeExpiry(signal, cfg, 20) });
    await sweepReminders({ config: cfg, logger, notifier, sent, prisma: db, clock: beforeExpiry(signal, cfg, 19) });

    expect(calls).toBe(1);
  });
});
