-- Close the TRUNCATE hole in the immutability guarantee.
--
-- The Phase 0 triggers are row-level and fire on UPDATE and DELETE. TRUNCATE is
-- a statement-level operation and bypasses them entirely, so until now the
-- record could not be edited but could be erased wholesale in one statement.
-- That is a materially weaker promise than the docs make, and PRD §9 puts the
-- record's credibility at the centre of the product: a subscriber who
-- understood the distinction would be right to discount it.
--
-- Verified 2026-08-13: `TRUNCATE track_record, executions, signal_events,
-- signals CASCADE` succeeded against a database carrying every Phase 0 trigger.
--
-- Same SQLSTATE 'OL001' as the other immutability breaches, so callers cannot
-- tell one kind of erasure apart from another and do not need to.
--
-- Deliberately NOT applied to `devices` or `app_settings`: a device token is
-- operational state that rotates, and app_settings is a single mutable row.
-- Only the four tables that make up the published record are protected.

CREATE OR REPLACE FUNCTION ollie_reject_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE is not permitted on %; the record is append-only', TG_TABLE_NAME
    USING ERRCODE = 'OL001';
END;
$$;

CREATE TRIGGER signals_reject_truncate
  BEFORE TRUNCATE ON "signals"
  FOR EACH STATEMENT EXECUTE FUNCTION ollie_reject_truncate();

CREATE TRIGGER executions_reject_truncate
  BEFORE TRUNCATE ON "executions"
  FOR EACH STATEMENT EXECUTE FUNCTION ollie_reject_truncate();

CREATE TRIGGER signal_events_reject_truncate
  BEFORE TRUNCATE ON "signal_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ollie_reject_truncate();

CREATE TRIGGER track_record_reject_truncate
  BEFORE TRUNCATE ON "track_record"
  FOR EACH STATEMENT EXECUTE FUNCTION ollie_reject_truncate();
