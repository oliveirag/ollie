import type { PrismaClient, Signal } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { listPendingSignals } from '../db/signals.js';
import { signalExpiresAt } from './expiry.js';
import type { Notifier } from './push/notify.js';

/**
 * One push shortly before a pending signal expires.
 *
 * The only other notification is the one at proposal time, and a signal now
 * lives until the close, so the owner gets exactly two: "here is a trade" at
 * 09:35 and "still undecided" `SIGNAL_REMINDER_MINUTES` before 16:00.
 *
 * Runs on the expiry sweep's cron (every minute). A signal is due once its
 * reminder time has passed and it has not expired yet. "Once" is held in
 * memory, not in the database: signals are immutable rows and a reminder is
 * not part of the record. The cost is that a restart inside the reminder
 * window sends it again, which the shared collapse id turns into a replaced
 * banner rather than a second one. A missed reminder costs nothing the
 * foreground refetch does not already cover, same doctrine as every push.
 */

export interface ReminderSweepDeps {
  config: Config;
  logger: Logger;
  notifier: Notifier;
  /** Signal ids already reminded by this process. Owned by the scheduler. */
  sent: Set<string>;
  clock?: () => Date;
  prisma?: PrismaClient;
}

export async function sweepReminders(deps: ReminderSweepDeps): Promise<Signal[]> {
  const leadMinutes = deps.config.signalReminderMinutes;
  if (leadMinutes <= 0) return [];

  const now = (deps.clock ?? (() => new Date()))();
  const pending = await listPendingSignals(deps.prisma);

  // Forget anything no longer pending, so the set stays as small as the queue.
  const pendingIds = new Set(pending.map((s) => s.id));
  for (const id of deps.sent) if (!pendingIds.has(id)) deps.sent.delete(id);

  const reminded: Signal[] = [];
  for (const signal of pending) {
    if (deps.sent.has(signal.id)) continue;

    const expiresAt = signalExpiresAt(signal.createdAt, deps.config);
    const remindAt = new Date(expiresAt.getTime() - leadMinutes * 60_000);

    // A window shorter than the lead time: the new-signal push already went
    // out inside it, and a "reminder" seconds later would just be a duplicate.
    if (remindAt.getTime() <= signal.createdAt.getTime()) continue;
    if (now.getTime() < remindAt.getTime() || now.getTime() >= expiresAt.getTime()) continue;

    // Marked before sending: a notifier that hangs or throws must not turn
    // into a reminder every minute until the close.
    deps.sent.add(signal.id);
    try {
      await deps.notifier.remindPendingSignal(signal, expiresAt);
      reminded.push(signal);
      deps.logger.info(
        { signal_id: signal.id, symbol: signal.symbol, expires_at: expiresAt.toISOString() },
        'expiry reminder sent',
      );
    } catch (error) {
      deps.logger.error({ err: error, signal_id: signal.id }, 'expiry reminder failed');
    }
  }
  return reminded;
}
