import { Prisma, type PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { newRunLogger } from '../logger.js';
import { listExecutions, recordExecution } from '../db/executions.js';
import { listOpenOrders, updateOrderFromBroker } from '../db/liveOrders.js';
import { SignalAlreadyPublishedError, getSignal, publishSignal } from '../db/signals.js';
import { NoOpenPositionError, settleLots } from './executor.js';
import { isTerminalOrderState, type BrokerAdapter } from './robinhood/client.js';

/**
 * The order poll (Phase 5, decisions 1–3).
 *
 * Reads every open live order back from the broker. When one first reports a
 * fill — `filled`, or terminal with a non-zero cumulative quantity — this
 * writes the execution row from the broker's numbers, opens or closes the lot
 * exactly as the paper path does, and publishes the signal. A terminal order
 * with nothing filled is marked and logged; the signal stays approved with no
 * fill, which the owner sees and the feed never does.
 *
 * **Not gated on the kill switch**, unlike placing an order, because this job
 * observes rather than acts: a fill the broker already made is a fact the
 * record must contain, and a halt that hid it would leave a real position
 * unaccounted for. The switch stops new orders; it cannot un-fill one.
 *
 * Idempotent by construction: an execution is written only when the signal
 * has none, and a terminal order is never polled again.
 */
export interface OrderPollDeps {
  broker: BrokerAdapter;
  logger: Logger;
  prisma?: PrismaClient;
  now?: () => Date;
}

export interface OrderPollResult {
  runId: string;
  polled: number;
  filled: number;
  endedUnfilled: number;
  /** Orders whose poll failed or parsed badly; left open for the next run. */
  errors: number;
}

export async function pollOpenOrders(deps: OrderPollDeps): Promise<OrderPollResult> {
  const open = await listOpenOrders(deps.prisma);
  const result: OrderPollResult = { runId: '', polled: 0, filled: 0, endedUnfilled: 0, errors: 0 };
  if (open.length === 0) return result;

  const log = newRunLogger('orders', deps.logger);
  result.runId = log.runId;
  const now = (deps.now ?? (() => new Date()))();

  for (const order of open) {
    result.polled += 1;
    let current;
    try {
      current = await deps.broker.getEquityOrder(order.brokerOrderId);
    } catch (error) {
      // A shape change or a transport failure leaves the order open; the next
      // firing tries again. The poll never guesses.
      result.errors += 1;
      log.error({ err: error, broker_order_id: order.brokerOrderId }, 'order poll failed');
      continue;
    }
    if (!current) {
      result.errors += 1;
      log.error({ broker_order_id: order.brokerOrderId }, 'broker reports no such order');
      continue;
    }

    const terminal = isTerminalOrderState(current.state);
    const filledQuantity = new Prisma.Decimal(current.cumulativeQuantity);
    const hasFill = current.state === 'filled' || (terminal && filledQuantity.greaterThan(0));

    await updateOrderFromBroker(
      order.id,
      {
        state: current.state,
        cumulativeQuantity: current.cumulativeQuantity,
        averagePrice: current.averagePrice,
        raw: current.raw,
        polledAt: now,
        // Only stamped once the fill (if any) has been recorded below, so a
        // crash between the two leaves the order open and re-polled.
        terminalAt: null,
      },
      deps.prisma,
    );

    if (hasFill) {
      if (!current.averagePrice || filledQuantity.lte(0)) {
        result.errors += 1;
        log.error(
          { broker_order_id: order.brokerOrderId, state: current.state, cumulative_quantity: current.cumulativeQuantity },
          'order reports a fill without a price or quantity; leaving open rather than guessing',
        );
        continue;
      }

      const signal = await getSignal(order.signalId, deps.prisma);
      if (!signal) {
        result.errors += 1;
        log.error({ signal_id: order.signalId }, 'order belongs to no signal');
        continue;
      }

      const existing = await listExecutions(signal.id, deps.prisma);
      if (existing.length === 0) {
        const execution = await recordExecution(
          {
            signalId: signal.id,
            mode: 'live',
            fillPrice: current.averagePrice,
            quantity: filledQuantity.toString(),
            filledAt: now,
            brokerOrderId: order.brokerOrderId,
          },
          deps.prisma,
        );

        try {
          await settleLots(
            signal,
            { fillPrice: current.averagePrice, quantity: filledQuantity.toString(), filledAt: now },
            deps.prisma,
          );
        } catch (error) {
          if (!(error instanceof NoOpenPositionError)) throw error;
          // The fill is real and recorded; what is missing is a lot to close —
          // the owner sold by hand, or a prior exit consumed it. Say so.
          log.error(
            { signal_id: signal.id, execution_id: execution.id },
            'live sell filled with no open lot to close; execution recorded, no lot closed',
          );
        }

        try {
          await publishSignal(signal.id, { now, ...(deps.prisma ? { prisma: deps.prisma } : {}) });
        } catch (error) {
          if (!(error instanceof SignalAlreadyPublishedError)) {
            log.error({ err: error, signal_id: signal.id }, 'publish failed after live fill; the sweep will retry');
          }
        }

        result.filled += 1;
        log.warn(
          {
            signal_id: signal.id,
            broker_order_id: order.brokerOrderId,
            fill_price: current.averagePrice,
            quantity: filledQuantity.toString(),
            partial: filledQuantity.lessThan(signal.quantity),
          },
          'LIVE FILL RECORDED',
        );
      }
    }

    if (terminal) {
      await updateOrderFromBroker(
        order.id,
        {
          state: current.state,
          cumulativeQuantity: current.cumulativeQuantity,
          averagePrice: current.averagePrice,
          raw: current.raw,
          polledAt: now,
          terminalAt: now,
        },
        deps.prisma,
      );
      if (!hasFill) {
        result.endedUnfilled += 1;
        log.warn(
          { signal_id: order.signalId, broker_order_id: order.brokerOrderId, state: current.state },
          'live order ended without a fill; the signal is approved and unfilled',
        );
      }
    }
  }

  log.info(result, 'order poll complete');
  return result;
}
