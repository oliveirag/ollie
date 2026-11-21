-- Narrow what the subscriber service's role can see to what it publishes.
--
-- Until now ollie_signal could SELECT every row and every column of
-- `signals`, so a compromised signal service could read pending proposals and
-- `review_snapshot.raw.order_checks` (the owner's buying-power alerts), and
-- every `track_record` row, including lots whose signal is not yet published.
-- The application filtered; the database did not. Now the database does:
--
--   * signals: column-level SELECT on exactly the columns the published
--     projection and `firstLivePublishedAt` read, and a row policy that shows
--     only published rows. review_snapshot, status, decide_reason, decided_at,
--     dedupe_key, ref_id and auto_decide_at are not granted.
--   * track_record: a row policy that shows only rows whose signal is
--     published.
--   * published_signal_estimates: the one value the projection needs from
--     review_snapshot, extracted by a view that runs as its owner and filters
--     to published rows itself.
--   * subscriber_tokens: UPDATE on last_used_at and revoked_at only.
--
-- RLS is enabled, not forced: the table owner (the orchestrator's role, which
-- also runs migrations) bypasses it and keeps seeing every row.

REVOKE SELECT ON "signals" FROM ollie_signal;
GRANT SELECT (
  "id", "created_at", "symbol", "side", "signal_type", "quantity", "thesis",
  "thesis_source", "indicators", "execution_mode", "published", "published_at"
) ON "signals" TO ollie_signal;

ALTER TABLE "signals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signals_published_for_subscribers" ON "signals"
  FOR SELECT TO ollie_signal
  USING ("published");

ALTER TABLE "track_record" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "track_record_published_for_subscribers" ON "track_record"
  FOR SELECT TO ollie_signal
  USING (EXISTS (
    SELECT 1 FROM "signals" s WHERE s."id" = "track_record"."signal_id" AND s."published"
  ));

CREATE VIEW "published_signal_estimates" AS
  SELECT "id" AS "signal_id", "review_snapshot"->>'estimated_price' AS "estimated_price"
  FROM "signals"
  WHERE "published";
GRANT SELECT ON "published_signal_estimates" TO ollie_signal;

REVOKE UPDATE ON "subscriber_tokens" FROM ollie_signal;
GRANT UPDATE ("last_used_at", "revoked_at") ON "subscriber_tokens" TO ollie_signal;
