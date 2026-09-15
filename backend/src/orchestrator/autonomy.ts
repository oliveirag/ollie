import type { PrismaClient, Signal } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { newRunLogger } from '../logger.js';
import { getAppSettings } from '../db/settings.js';
import {
  SignalAlreadyPublishedError,
  SignalNotPendingError,
  listAutoDecidableSignals,
  publishSignal,
  transitionSignal,
} from '../db/signals.js';
import { openLotsForSymbol } from '../db/trackRecord.js';
import { executorFor } from './executor.js';
import type { BrokerAdapter } from './robinhood/client.js';

/**
 * Autonomy within caps (Phase 5, decisions 6 and 7).
 *
 * A signal created while autonomy was on carries `auto_decide_at`. Once that
 * instant passes with the signal still pending — the owner neither approved
 * nor vetoed it — this sweep approves it, with a reason that says so, and
 * executes it through the same executor a tap would have used. Everything
 * else is unchanged: the caps bounded what could be proposed, the executor's
 * own gates still apply, and publication still waits for the fill.
 *
 * Both halves of the autonomy gate are re-checked on every firing, and the
 * kill switch halts it like everything that acts. A signal whose window
 * passes while any of those is off simply stays pending until the expiry
 * sweep records that nobody decided it.
 */
export const AUTO_APPROVE_REASON = 'auto-approved after veto window';

export interface AutonomySweepDeps {
  broker: BrokerAdapter;
  config: Config;
  logger: Logger;
  prisma?: PrismaClient;
  clock?: () => Date;
}

export interface AutonomySweepResult {
  status: 'completed' | 'halted_kill_switch' | 'autonomy_off';
  approved: Signal[];
  skipped: number;
}

export async function sweepAutonomy(deps: AutonomySweepDeps): Promise<AutonomySweepResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const settings = await getAppSettings(deps.prisma);

  if (deps.config.killSwitchEnv || settings.killSwitch) {
    return { status: 'halted_kill_switch', approved: [], skipped: 0 };
  }
  if (!deps.config.autonomyEnabled || !settings.autonomy) {
    return { status: 'autonomy_off', approved: [], skipped: 0 };
  }

  const due = await listAutoDecidableSignals(now, deps.prisma);
  if (due.length === 0) return { status: 'completed', approved: [], skipped: 0 };

  const log = newRunLogger('autonomy', deps.logger);
  const approved: Signal[] = [];
  let skipped = 0;

  for (const signal of due) {
    // The route's pre-flight, for the same reason: an exit with nothing to
    // close must not burn its one transition. Left pending; expiry will say
    // nobody decided it, which is true.
    if (signal.side === 'sell') {
      const lots = await openLotsForSymbol(signal.symbol, deps.prisma);
      if (lots.length === 0) {
        skipped += 1;
        log.warn({ signal_id: signal.id, symbol: signal.symbol }, 'auto-approval skipped: no open lot to close');
        continue;
      }
    }

    let decided: Signal;
    try {
      decided = await transitionSignal(signal.id, 'approved', AUTO_APPROVE_REASON, {
        now,
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      });
    } catch (error) {
      if (error instanceof SignalNotPendingError) {
        // The owner got there first, or expiry did. Their decision wins.
        skipped += 1;
        continue;
      }
      throw error;
    }

    try {
      const executor = executorFor(
        decided,
        { config: deps.config, logger: deps.logger, ...(deps.prisma ? { prisma: deps.prisma } : {}), now: () => now },
        deps.broker,
      );
      const outcome = await executor.execute(decided);
      if (outcome.kind === 'filled') {
        try {
          await publishSignal(decided.id, { now, ...(deps.prisma ? { prisma: deps.prisma } : {}) });
        } catch (error) {
          if (!(error instanceof SignalAlreadyPublishedError)) throw error;
        }
      }
      approved.push(decided);
      log.warn(
        { signal_id: decided.id, symbol: decided.symbol, side: decided.side, outcome: outcome.kind },
        'signal auto-approved',
      );
    } catch (error) {
      // Same shape as the route's execution_failed: approved, unfilled, and
      // said plainly. The publish sweep will not touch it — no execution.
      log.error({ err: error, signal_id: decided.id }, 'auto-approved but execution failed; no fill');
      approved.push(decided);
    }
  }

  return { status: 'completed', approved, skipped };
}
