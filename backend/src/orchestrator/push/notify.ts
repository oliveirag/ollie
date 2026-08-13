import type { Signal } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from '../../config/index.js';
import { deleteDevice, listDevices } from '../../db/devices.js';
import { parseReviewSnapshot } from '../reviewSnapshot.js';
import { ApnsClient, type ApnsEnvironment } from './apns.js';

/**
 * Tells the owner a signal is waiting.
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
}

/** Used when push is not configured, which is the default. */
export const noopNotifier: Notifier = {
  async notifyNewSignal() {
    /* nothing to do */
  },
};

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
    try {
      const devices = await listDevices();
      if (devices.length === 0) return;

      const payload = buildPayload(signal, this.config.signalExpiryMinutes);

      await Promise.all(
        devices.map(async (device) => {
          const result = await this.client.send({
            deviceToken: device.apnsToken,
            environment: (device.environment as ApnsEnvironment) ?? 'production',
            title: payload.title,
            body: payload.body,
            data: payload.data,
            // One visible notification per signal, however many retries.
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

/**
 * What the notification says. Deliberately nothing from the raw review
 * snapshot — a lock screen is not the place for a broker's JSON, and the
 * detail is one tap away.
 */
export function buildPayload(signal: Signal, expiryMinutes: number) {
  let estimatedPrice: string | null = null;
  try {
    estimatedPrice = parseReviewSnapshot(signal.reviewSnapshot).estimated_price;
  } catch {
    estimatedPrice = null;
  }

  const side = signal.side === 'buy' ? 'Buy' : 'Sell';
  const priceSuffix = estimatedPrice ? ` at ~${estimatedPrice}` : '';
  const expiresAt = new Date(signal.createdAt.getTime() + expiryMinutes * 60_000);

  return {
    title: `${side} ${signal.symbol}`,
    body: `${signal.quantity} share${signal.quantity.toString() === '1' ? '' : 's'}${priceSuffix}. Expires in ${expiryMinutes} min.`,
    data: {
      signal_id: signal.id,
      symbol: signal.symbol,
      side: signal.side,
      quantity: signal.quantity.toString(),
      estimated_price: estimatedPrice,
      expires_at: expiresAt.toISOString(),
    },
  };
}
