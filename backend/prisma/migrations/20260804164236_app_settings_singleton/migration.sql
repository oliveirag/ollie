-- app_settings holds the runtime safety flags (kill switch, execution mode) and
-- must never become ambiguous: two rows would mean two answers to "is the kill
-- switch on", and the pipeline would act on whichever one it happened to fetch.

ALTER TABLE "app_settings"
  ADD CONSTRAINT "app_settings_singleton" CHECK ("id" = 1);

-- Seed the row so a fresh database is already safe to run against: paper mode,
-- kill switch off. ON CONFLICT keeps this migration replayable.
INSERT INTO "app_settings" ("id", "kill_switch", "execution_mode")
VALUES (1, false, 'paper')
ON CONFLICT ("id") DO NOTHING;
