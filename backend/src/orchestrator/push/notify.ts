import type { Signal } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../../config/index.js';
import { deleteDevice, listDevices } from '../../db/devices.js';
import { formatEtTime, signalExpiresAt } from '../expiry.js';
import { parseReviewSnapshot } from '../reviewSnapshot.js';
import { ApnsClient, type ApnsEnvironment } from './apns.js';

/**
 * Tells the owner a signal is waiting, and once more before it expires.
 *
 * The governing rule, same doctrine as the thesis: **push must never block or
 * fail a signal.** A signal that exists but was not announced is an
 * inconvenience the owner recovers from by opening the app; a signal that
 * failed to persist because a notification could not be delivered is a defect.
 * So every path here swallows its errors after logging them.
 *
 * Delivery is best-effort by design and the app does not depend on it — the
 * approvals list refetches on foreground and on pull-to-refresh, so a missed
 * push costs one expired signal, visible with its reason, never a silent one.
 */

export interface Notifier {
  notifyNewSignal(signal: Signal): Promise<void>;
  /** The one reminder before expiry (reminders.ts decides when). */
  remindPendingSignal(signal: Signal, expiresAt: Date): Promise<void>;
}

/** Used when push is not configured, which is the default. */
export const noopNotifier: Notifier = {
  async notifyNewSignal() {
    /* nothing to do */
  },
  async remindPendingSignal() {
    /* nothing to do */
  },
};

/**
 * The action sets the iOS app registers (PushRegistrar.swift). Paper signals
 * get approve and decline on the notification itself. Live signals get
 * decline only: approving one places a real order and needs the app's own
 * two-tap confirmation (`confirm_live`), which a lock-screen button is not.
 */
export const PUSH_CATEGORY = {
  paper: 'SIGNAL_DECISION',
  live: 'SIGNAL_DECISION_LIVE',
} as const;

export function buildNotifier(config: Config, logger: Logger): Notifier {
  const { apns } = config;
  if (!apns.keyP8 || !apns.keyId || !apns.teamId || !apns.bundleId) {
    logger.debug('APNs is not configured; signals will not be pushed');
    return noopNotifier;
  }

  const client = new ApnsClient({
    credentials: {
      keyP8: apns.keyP8,
      keyId: apns.keyId,
      teamId: apns.teamId,
      bundleId: apns.bundleId,
    },
  });

  return new ApnsNotifier(client, config, logger);
}

export class ApnsNotifier implements Notifier {
  constructor(
    private readonly client: ApnsClient,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async notifyNewSignal(signal: Signal): Promise<void> {
    const expiresAt = signalExpiresAt(signal.createdAt, this.config);
    await this.dispatch(signal, buildPayload(signal, expiresAt));
  }

  async remindPendingSignal(signal: Signal, expiresAt: Date): Promise<void> {
    await this.dispatch(signal, buildReminderPayload(signal, expiresAt));
  }

  private async dispatch(signal: Signal, payload: PushPayload): Promise<void> {
    try {
      const devices = await listDevices();
      if (devices.length === 0) return;

      await Promise.all(
        devices.map(async (device) => {
          const result = await this.client.send({
            deviceToken: device.apnsToken,
            environment: (device.environment as ApnsEnvironment) ?? 'production',
            title: payload.title,
            body: payload.body,
            data: payload.data,
            category: payload.category,
            // One visible notification per signal, however many retries. The
            // reminder shares it, so it replaces the morning's banner rather
            // than stacking a second one for the same trade.
            collapseId: signal.id,
          });

          if (result.ok) return;

          if (result.unregistered) {
            await deleteDevice(device.apnsToken);
            this.logger.info(
              { reason: result.reason },
              'pruned an APNs token the service reported as gone',
            );
            return;
          }

          this.logger.warn(
            { reason: result.reason, retryable: result.retryable, signal_id: signal.id },
            'push failed',
          );
        }),
      );
    } catch (error) {
      // The catch is the feature. Reaching here means the signal is already
      // persisted and the owner can still see it in the app.
      this.logger.error({ err: error, signal_id: signal.id }, 'push dispatch failed; signal is unaffected');
    }
  }
}

export interface PushPayload {
  title: string;
  body: string;
  category: string;
  data: {
    kind: 'new_signal' | 'reminder';
    signal_id: string;
    symbol: string;
    side: string;
    quantity: string;
    execution_mode: string;
    estimated_price: string | null;
    expires_at: string;
  };
}

/**
 * What the notification says. Deliberately nothing from the raw review
 * snapshot — a lock screen is not the place for a broker's JSON, and the
 * detail is one tap away.
 */
export function buildPayload(signal: Signal, expiresAt: Date): PushPayload {
  const parts = describe(signal);
  return {
    title: `${parts.side} ${signal.symbol}`,
    body: `${parts.shares}${parts.priceSuffix}. Decide by ${formatEtTime(expiresAt)}.`,
    category: categoryFor(signal),
    data: payloadData(signal, 'new_signal', parts.estimatedPrice, expiresAt),
  };
}

/** The one reminder. Same data, so a tap or an action works the same way. */
export function buildReminderPayload(signal: Signal, expiresAt: Date): PushPayload {
  const parts = describe(signal);
  return {
    title: `Still undecided: ${parts.side} ${signal.symbol}`,
    body: `${parts.shares}${parts.priceSuffix}. Expires at ${formatEtTime(expiresAt)}.`,
    category: categoryFor(signal),
    data: payloadData(signal, 'reminder', parts.estimatedPrice, expiresAt),
  };
}

function categoryFor(signal: Signal): string {
  return signal.executionMode === 'live' ? PUSH_CATEGORY.live : PUSH_CATEGORY.paper;
}

function describe(signal: Signal) {
  let estimatedPrice: string | null = null;
  try {
    estimatedPrice = parseReviewSnapshot(signal.reviewSnapshot).estimated_price;
  } catch {
    estimatedPrice = null;
  }
  const quantity = signal.quantity.toString();
  return {
    side: signal.side === 'buy' ? 'Buy' : 'Sell',
    shares: `${quantity} share${quantity === '1' ? '' : 's'}`,
    priceSuffix: estimatedPrice ? ` at ~${estimatedPrice}` : '',
    estimatedPrice,
  };
}

function payloadData(
  signal: Signal,
  kind: PushPayload['data']['kind'],
  estimatedPrice: string | null,
  expiresAt: Date,
): PushPayload['data'] {
  return {
    kind,
    signal_id: signal.id,
    symbol: signal.symbol,
    side: signal.side,
    quantity: signal.quantity.toString(),
    execution_mode: signal.executionMode,
    estimated_price: estimatedPrice,
    expires_at: expiresAt.toISOString(),
  };
}
