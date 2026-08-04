-- Immutability, enforced by the database rather than by discipline.
--
-- PRD §3.2 and §4.4: every signal is a permanent record from the moment it
-- fires, and track-record rows are append-only ("corrections are new rows,
-- never edits"). That promise is the product, so it cannot live only in the
-- repository layer where the next feature can route around it. A psql session,
-- a migration script, and an ORM misuse all hit these triggers.
--
-- The one thing that must still change is a signal's decision: pending becomes
-- approved, rejected, or expired exactly once. So `signals` is not frozen
-- outright; it is pinned to a state machine.
--
-- All violations raise SQLSTATE 'OL001' so callers can tell an immutability
-- breach apart from an ordinary constraint failure.

-- ---------------------------------------------------------------------------
-- signals: frozen except for a one-way decision, and never deleted
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
  THEN
    RAISE EXCEPTION
      'signal % is immutable: only status, decided_at, decide_reason, published and published_at may change',
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

  -- Publication is one-way and stamped once. A signal that was published to
  -- subscribers cannot be quietly unpublished.
  IF OLD.published AND NOT NEW.published THEN
    RAISE EXCEPTION 'signal % cannot be unpublished', OLD.id
      USING ERRCODE = 'OL001';
  END IF;
  IF NEW.published AND NEW.published_at IS NULL THEN
    RAISE EXCEPTION 'signal % must record published_at when published', OLD.id
      USING ERRCODE = 'OL001';
  END IF;
  IF OLD.published AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'signal %: published_at is stamped once', OLD.id
      USING ERRCODE = 'OL001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ollie_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rows in % are permanent and cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = 'OL001';
END;
$$;

CREATE OR REPLACE FUNCTION ollie_forbid_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'rows in % are append-only; record a correction as a new row instead of editing',
    TG_TABLE_NAME USING ERRCODE = 'OL001';
END;
$$;

CREATE TRIGGER signals_enforce_update
  BEFORE UPDATE ON "signals"
  FOR EACH ROW EXECUTE FUNCTION ollie_signals_enforce_update();

CREATE TRIGGER signals_forbid_delete
  BEFORE DELETE ON "signals"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_delete();

-- ---------------------------------------------------------------------------
-- Pure append-only tables: the audit trail, the fills, and the track record
-- ---------------------------------------------------------------------------

CREATE TRIGGER signal_events_forbid_update
  BEFORE UPDATE ON "signal_events"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_update();

CREATE TRIGGER signal_events_forbid_delete
  BEFORE DELETE ON "signal_events"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_delete();

CREATE TRIGGER executions_forbid_update
  BEFORE UPDATE ON "executions"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_update();

CREATE TRIGGER executions_forbid_delete
  BEFORE DELETE ON "executions"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_delete();

CREATE TRIGGER track_record_forbid_update
  BEFORE UPDATE ON "track_record"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_update();

CREATE TRIGGER track_record_forbid_delete
  BEFORE DELETE ON "track_record"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_delete();

-- ---------------------------------------------------------------------------
-- app_settings is mutable by design (the kill switch has to flip) but the row
-- itself must survive: deleting it would leave the pipeline with no flags to
-- read, and "no row" must never be mistaken for "kill switch off".
-- ---------------------------------------------------------------------------

CREATE TRIGGER app_settings_forbid_delete
  BEFORE DELETE ON "app_settings"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_delete();
