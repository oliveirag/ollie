-- CreateEnum
CREATE TYPE "signal_side" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "signal_type" AS ENUM ('technical', 'rebalance');

-- CreateEnum
CREATE TYPE "signal_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "exec_mode" AS ENUM ('paper', 'live');

-- CreateEnum
CREATE TYPE "position_status" AS ENUM ('open', 'closed');

-- CreateTable
CREATE TABLE "signals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "side" "signal_side" NOT NULL,
    "signal_type" "signal_type" NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "thesis" TEXT,
    "thesis_source" TEXT NOT NULL DEFAULT 'llm',
    "indicators" JSONB NOT NULL,
    "review_snapshot" JSONB NOT NULL,
    "status" "signal_status" NOT NULL DEFAULT 'pending',
    "execution_mode" "exec_mode" NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "decide_reason" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(6),
    "dedupe_key" TEXT NOT NULL,
    "ref_id" UUID NOT NULL DEFAULT gen_random_uuid(),

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "signal_id" UUID NOT NULL,
    "from_status" "signal_status" NOT NULL,
    "to_status" "signal_status" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "signal_id" UUID NOT NULL,
    "mode" "exec_mode" NOT NULL,
    "fill_price" DECIMAL(18,6) NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "filled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "broker_order_id" TEXT,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "track_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "signal_id" UUID NOT NULL,
    "entry_price" DECIMAL(18,6) NOT NULL,
    "exit_price" DECIMAL(18,6),
    "realized_pnl" DECIMAL(18,6),
    "unrealized_pnl" DECIMAL(18,6),
    "status" "position_status" NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "kill_switch" BOOLEAN NOT NULL DEFAULT false,
    "execution_mode" "exec_mode" NOT NULL DEFAULT 'paper',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signals_dedupe_key_key" ON "signals"("dedupe_key");

-- CreateIndex
CREATE INDEX "signals_status_created_at_idx" ON "signals"("status", "created_at");

-- CreateIndex
CREATE INDEX "signals_symbol_created_at_idx" ON "signals"("symbol", "created_at");

-- CreateIndex
CREATE INDEX "signal_events_signal_id_created_at_idx" ON "signal_events"("signal_id", "created_at");

-- CreateIndex
CREATE INDEX "executions_signal_id_idx" ON "executions"("signal_id");

-- CreateIndex
CREATE INDEX "track_record_signal_id_recorded_at_idx" ON "track_record"("signal_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_record" ADD CONSTRAINT "track_record_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
