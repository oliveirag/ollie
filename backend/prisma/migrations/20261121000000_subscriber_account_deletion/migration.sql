-- In-app account deletion (App Store guideline 5.1.1(v)).
--
-- A deleted subscriber is tombstoned, not removed: disclaimer_acceptances is
-- append-only and references the user row, and "this account accepted this
-- text at this time" stays true after the account is gone. What deletion
-- removes is everything that identifies the person: the Apple subject is
-- replaced with an opaque tombstone, the email and invite code are cleared,
-- and every token is revoked so no app or agent credential works again.
-- Signing in with the same Apple ID later creates a fresh subscriber.

ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

-- The signal service gets exactly this operation and nothing wider. Granting
-- it UPDATE on apple_user_id would let a compromised service re-key any user
-- to any subject; this function can only tombstone, only a subscriber, and
-- only once.
CREATE FUNCTION ollie_delete_subscriber(target UUID) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE "users"
     SET "apple_user_id" = 'deleted:' || "id"::text,
         "email" = NULL,
         "invite_code" = NULL,
         "deleted_at" = now()
   WHERE "id" = target
     AND "role" = 'subscriber'
     AND "deleted_at" IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected = 1 THEN
    UPDATE "subscriber_tokens"
       SET "revoked_at" = now()
     WHERE "user_id" = target
       AND "revoked_at" IS NULL;
  END IF;

  RETURN affected = 1;
END;
$$;

REVOKE ALL ON FUNCTION ollie_delete_subscriber(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ollie_delete_subscriber(UUID) TO ollie_signal;
