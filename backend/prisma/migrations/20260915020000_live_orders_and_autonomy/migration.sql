-- Phase 5: the live order path and autonomy.
--
-- live_orders is operational state (decision 2): the broker's view of an
-- order, refreshed on every poll. No immutability trigger, and no grant to
-- ollie_signal — subscribers see fills (executions), never orders.
--
-- track_record.quantity is nullable on purpose (decision 3): null means "the
-- signal's quantity", which is every row that exists today. Backfilling would
-- have meant updating record rows, and the trigger that forbids that is not
-- something a migration should work around.
--
-- signals.auto_decide_at is stamped at creation and joins the trigger's frozen
-- list (decision 7), so the function is redefined once more below.

-- AlterTable
ALTER TABLE "app_settings" ADD COLUMN     "autonomy" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "auto_decide_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "track_record" ADD COLUMN     "quantity" DECIMAL(18,6);

-- CreateTable
CREATE TABLE "live_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "signal_id" UUID NOT NULL,
    "broker_order_id" TEXT NOT NULL,
    "ref_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "cumulative_quantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "average_price" DECIMAL(18,6),
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_polled_at" TIMESTAMPTZ(6),
    "terminal_at" TIMESTAMPTZ(6),
    "last_response" JSONB,

    CONSTRAINT "live_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_orders_broker_order_id_key" ON "live_orders"("broker_order_id");

-- CreateIndex
CREATE INDEX "live_orders_signal_id_idx" ON "live_orders"("signal_id");

-- CreateIndex
CREATE INDEX "live_orders_terminal_at_idx" ON "live_orders"("terminal_at");

-- AddForeignKey
ALTER TABLE "live_orders" ADD CONSTRAINT "live_orders_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- auto_decide_at is frozen after creation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ollie_signals_enforce_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  status_changed boolean := NEW.status IS DISTINCT FROM OLD.status;
BEGIN
  IF NEW.id              IS DISTINCT FROM OLD.id
  OR NEW.created_at      IS DISTINCT FROM OLD.created_at
  OR NEW.symbol          IS DISTINCT FROM OLD.symbol
  OR NEW.side            IS DISTINCT FROM OLD.side
  OR NEW.signal_type     IS DISTINCT FROM OLD.signal_type
  OR NEW.quantity        IS DISTINCT FROM OLD.quantity
  OR NEW.thesis          IS DISTINCT FROM OLD.thesis
  OR NEW.thesis_source   IS DISTINCT FROM OLD.thesis_source
  OR NEW.indicators      IS DISTINCT FROM OLD.indicators
  OR NEW.review_snapshot IS DISTINCT FROM OLD.review_snapshot
  OR NEW.execution_mode  IS DISTINCT FROM OLD.execution_mode
  OR NEW.dedupe_key      IS DISTINCT FROM OLD.dedupe_key
  OR NEW.ref_id          IS DISTINCT FROM OLD.ref_id
  OR NEW.auto_decide_at  IS DISTINCT FROM OLD.auto_decide_at
  THEN
    RAISE EXCEPTION
      'signal % is immutable: only status, decided_at, decide_reason, published and published_at may change (auto_decide_at is stamped at creation)',
      OLD.id USING ERRCODE = 'OL001';
  END IF;

  IF status_changed THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION
        'signal % was already decided (%); a decision cannot be revisited',
        OLD.id, OLD.status USING ERRCODE = 'OL001';
    END IF;
    IF NEW.status = 'pending' THEN
      RAISE EXCEPTION 'signal % cannot return to pending', OLD.id
        USING ERRCODE = 'OL001';
    END IF;
    IF NEW.decided_at IS NULL THEN
      RAISE EXCEPTION
        'signal % must record decided_at when leaving pending', OLD.id
        USING ERRCODE = 'OL001';
    END IF;
  ELSE
    IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION
        'signal %: decided_at only moves when status does', OLD.id
        USING ERRCODE = 'OL001';
    END IF;
    IF NEW.decide_reason IS DISTINCT FROM OLD.decide_reason THEN
      RAISE EXCEPTION
        'signal %: decide_reason only moves when status does', OLD.id
        USING ERRCODE = 'OL001';
    END IF;
  END IF;

  -- Publication: exactly one legal transition, and nothing else touches the
  -- pair. Once published, both columns are frozen for the life of the row.
  IF OLD.published THEN
    IF NOT NEW.published THEN
      RAISE EXCEPTION 'signal % cannot be unpublished', OLD.id
        USING ERRCODE = 'OL001';
    END IF;
    IF NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'signal %: published_at is stamped once', OLD.id
        USING ERRCODE = 'OL001';
    END IF;
  ELSIF NEW.published THEN
    IF NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'signal % must record published_at when published', OLD.id
        USING ERRCODE = 'OL001';
    END IF;
  ELSIF NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION
      'signal %: published_at is set only by publication itself', OLD.id
      USING ERRCODE = 'OL001';
  END IF;

  RETURN NEW;
END;
$$;
