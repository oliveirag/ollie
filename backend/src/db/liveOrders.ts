import { Prisma, type LiveOrder, type PrismaClient } from '@prisma/client';
import { getPrisma } from './client.js';

/**
 * Live orders (Phase 5, decision 2): the broker's view of each order Ollie
 * placed, refreshed by the poll job. Mutable on purpose — an order's state is
 * the broker's fact, not our claim — and never published. The fill an order
 * produces is written once to `executions`, which is the record.
 */

export interface RecordPlacedOrderInput {
  signalId: string;
  brokerOrderId: string;
  refId: string;
  state: string;
  raw: unknown;
  placedAt?: Date;
}

/**
 * Upsert on the broker order id: a retried placement with the same ref_id
 * comes back as the same order, and must land as the same row.
 */
export async function recordPlacedOrder(
  input: RecordPlacedOrderInput,
  prisma: PrismaClient = getPrisma(),
): Promise<LiveOrder> {
  return prisma.liveOrder.upsert({
    where: { brokerOrderId: input.brokerOrderId },
    update: { state: input.state, lastResponse: input.raw as Prisma.InputJsonValue },
    create: {
      signalId: input.signalId,
      brokerOrderId: input.brokerOrderId,
      refId: input.refId,
      state: input.state,
      placedAt: input.placedAt ?? new Date(),
      lastResponse: input.raw as Prisma.InputJsonValue,
    },
  });
}

export interface OrderPollUpdate {
  state: string;
  cumulativeQuantity: string;
  averagePrice: string | null;
  raw: unknown;
  polledAt: Date;
  terminalAt?: Date | null;
}

export async function updateOrderFromBroker(
  id: string,
  update: OrderPollUpdate,
  prisma: PrismaClient = getPrisma(),
): Promise<LiveOrder> {
  return prisma.liveOrder.update({
    where: { id },
    data: {
      state: update.state,
      cumulativeQuantity: new Prisma.Decimal(update.cumulativeQuantity),
      averagePrice: update.averagePrice === null ? null : new Prisma.Decimal(update.averagePrice),
      lastResponse: update.raw as Prisma.InputJsonValue,
      lastPolledAt: update.polledAt,
      ...(update.terminalAt !== undefined ? { terminalAt: update.terminalAt } : {}),
    },
  });
}

/** Orders the poll job still has to watch, oldest first. */
export async function listOpenOrders(prisma: PrismaClient = getPrisma()): Promise<LiveOrder[]> {
  return prisma.liveOrder.findMany({ where: { terminalAt: null }, orderBy: { placedAt: 'asc' } });
}

export async function latestOrderForSignal(
  signalId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<LiveOrder | null> {
  return prisma.liveOrder.findFirst({ where: { signalId }, orderBy: { placedAt: 'desc' } });
}

/** One query for a list view: the newest order per signal id. */
export async function latestOrdersForSignals(
  signalIds: readonly string[],
  prisma: PrismaClient = getPrisma(),
): Promise<Map<string, LiveOrder>> {
  if (signalIds.length === 0) return new Map();
  const rows = await prisma.liveOrder.findMany({
    where: { signalId: { in: [...signalIds] } },
    orderBy: { placedAt: 'desc' },
  });
  const latest = new Map<string, LiveOrder>();
  for (const row of rows) if (!latest.has(row.signalId)) latest.set(row.signalId, row);
  return latest;
}
