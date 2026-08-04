import { Prisma, type ExecMode, type Execution, type PrismaClient } from '@prisma/client';
import { getPrisma } from './client.js';

export interface RecordExecutionInput {
  signalId: string;
  mode: ExecMode;
  /** Decimal strings. Paper fills come from the review estimate plus slippage. */
  fillPrice: string;
  quantity: string;
  filledAt?: Date;
  /** Null for paper fills; live fills carry the broker's order id. */
  brokerOrderId?: string | null;
}

/** Append-only: `executions` rejects UPDATE and DELETE at the database level. */
export async function recordExecution(
  input: RecordExecutionInput,
  prisma: PrismaClient = getPrisma(),
): Promise<Execution> {
  return prisma.execution.create({
    data: {
      signalId: input.signalId,
      mode: input.mode,
      fillPrice: new Prisma.Decimal(input.fillPrice),
      quantity: new Prisma.Decimal(input.quantity),
      filledAt: input.filledAt ?? new Date(),
      brokerOrderId: input.brokerOrderId ?? null,
    },
  });
}

export async function listExecutions(
  signalId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<Execution[]> {
  return prisma.execution.findMany({ where: { signalId }, orderBy: { filledAt: 'asc' } });
}
