import type { PrismaClient, Signal } from '@prisma/client';
import type { Config } from '../config/index.js';
import { getAppSettings } from '../db/settings.js';
import { selectLotsToClose } from './executor.js';

/**
 * The approval pre-flight, shared by the decision route and the decide-signal
 * CLI so the break-glass path refuses exactly what the app refuses.
 */
export interface PreflightRefusal {
  error: string;
  detail: string;
}

/**
 * Returns an error body when execution would be refused, or null when it would
 * proceed. Mirrors the executor's own gates without duplicating their
 * authority — this exists to keep a doomed approval from consuming the
 * signal's one allowed transition.
 */
export async function preflightExecution(
  signal: Signal,
  config: Config,
  confirmLive: boolean,
  prisma?: PrismaClient,
): Promise<PreflightRefusal | null> {
  const mode = signal.executionMode;
  if (config.killSwitchEnv) {
    return { error: 'kill_switch_engaged', detail: 'KILL_SWITCH is set in the environment' };
  }

  const settings = await getAppSettings(prisma);
  if (settings.killSwitch) {
    return { error: 'kill_switch_engaged', detail: 'the kill switch is on' };
  }

  if (mode === 'live') {
    // The executor's two gates, mirrored so a refusal leaves the signal
    // pending rather than burning its transition — plus the third gate, which
    // exists only here: the per-approval confirmation (Phase 5, decision 4).
    if (!config.liveTradingEnabled) {
      return { error: 'live_mode_not_enabled', detail: 'LIVE_TRADING_ENABLED is not set' };
    }
    if (settings.executionMode !== 'live') {
      return { error: 'live_mode_not_enabled', detail: 'app_settings.execution_mode is not live' };
    }
    if (!confirmLive) {
      return {
        error: 'live_confirmation_required',
        detail: 'approving a live signal places a real order; send confirm_live: true',
      };
    }
  }

  // A long-only exit needs something to close. The executor refuses too and
  // remains the authority, but discovering it there would mean the signal had
  // already transitioned to approved — and the immutability triggers only allow
  // pending -> terminal, so it would be stranded approved with no fill. Checked
  // here, the answer is a 409 and the signal is still pending and still
  // decidable, exactly as with the kill-switch and live-mode refusals above.
  // The same whole-lot selection the executor settles with: an open lot bigger
  // than this exit is not something it can close.
  if (signal.side === 'sell') {
    const consumed = await selectLotsToClose(signal.symbol, signal.quantity.toString(), prisma);
    if (consumed.length === 0) {
      return {
        error: 'no_open_position',
        detail: `no open ${signal.symbol} lot to close`,
      };
    }
  }

  return null;
}
