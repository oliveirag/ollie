-- Phase 4, milestone 4.2: the subscriber tables, the consent trigger, and the
-- database role that is the data-tier half of the owner/subscriber wall.
--
-- Three tables (decision 3): users keyed by the Sign in with Apple subject,
-- hashed revocable tokens, and append-only disclaimer acceptances (decision 6).
-- The PRD's `subscriptions` table stays deferred: no tier logic exists.
--
-- One role (decision 4): `ollie_signal` is what the subscriber-facing service
-- connects as. Its grants are listed explicitly and everything else is denied
-- by omission — in particular it has NO privilege on oauth_state (the broker
-- credential), app_settings (the kill switch), devices (the owner's phone),
-- executions (the owner's fills), or signal_events. A full compromise of the
-- subscriber service cannot read the credential, flip the switch, or see a
-- fill, because the database will not hand them over.

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role" TEXT NOT NULL DEFAULT 'subscriber',
    "apple_user_id" TEXT NOT NULL,
    "email" TEXT,
    "invite_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriber_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "subscriber_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disclaimer_acceptances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "disclaimer_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disclaimer_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_apple_user_id_key" ON "users"("apple_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriber_tokens_token_hash_key" ON "subscriber_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "subscriber_tokens_user_id_kind_idx" ON "subscriber_tokens"("user_id", "kind");

-- CreateIndex
CREATE INDEX "disclaimer_acceptances_user_id_accepted_at_idx" ON "disclaimer_acceptances"("user_id", "accepted_at");

-- AddForeignKey
ALTER TABLE "subscriber_tokens" ADD CONSTRAINT "subscriber_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disclaimer_acceptances" ADD CONSTRAINT "disclaimer_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Consent is a record: the full append-only treatment, same functions as the
-- track record, same SQLSTATE 'OL001'.
-- ---------------------------------------------------------------------------

CREATE TRIGGER disclaimer_acceptances_forbid_update
  BEFORE UPDATE ON "disclaimer_acceptances"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_update();

CREATE TRIGGER disclaimer_acceptances_forbid_delete
  BEFORE DELETE ON "disclaimer_acceptances"
  FOR EACH ROW EXECUTE FUNCTION ollie_forbid_delete();

CREATE TRIGGER disclaimer_acceptances_reject_truncate
  BEFORE TRUNCATE ON "disclaimer_acceptances"
  FOR EACH STATEMENT EXECUTE FUNCTION ollie_reject_truncate();

-- ---------------------------------------------------------------------------
-- The subscriber service's role. Roles are cluster-wide, so the CREATE is
-- guarded: the dev and test databases share one Postgres locally. The
-- password is never set here — it is per-environment (ALTER ROLE ... PASSWORD
-- on the target cluster), so a migration file carries no credential.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ollie_signal') THEN
    CREATE ROLE ollie_signal LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ollie_signal;

GRANT SELECT ON "signals", "track_record" TO ollie_signal;
GRANT SELECT, INSERT ON "users", "disclaimer_acceptances" TO ollie_signal;
-- UPDATE exists for last_used_at and revoked_at; the application never writes
-- anything else, and there is no DELETE — a revoked token is history.
GRANT SELECT, INSERT, UPDATE ON "subscriber_tokens" TO ollie_signal;
-- users.email is erasable operational data (Phase 4 risk 9); nothing else on
-- users is updated by the service.
GRANT UPDATE ("email") ON "users" TO ollie_signal;

-- No grant of any kind on oauth_state, app_settings, devices, executions, or
-- signal_events. Stated as a comment because the absence is the point, and a
-- test asserts each of the five individually.
