/**
 * The privacy policy for the subscriber app, served by the signal service at
 * `/privacy`. App Review requires a policy link both in App Store Connect and
 * inside the app (guideline 5.1.1(i)), and it has to describe what the app and
 * the service actually collect.
 *
 * Kept here for the same reason as the disclaimer: Railway builds with
 * `backend/` as its root, so a file under `docs/` does not exist at runtime.
 * When what the service stores changes, this text changes with it, and so do
 * the App Privacy answers in App Store Connect.
 */
export const PRIVACY_POLICY_UPDATED = '2026-11-21';

export const PRIVACY_POLICY_TEXT = `# Ollie privacy policy

Last updated ${PRIVACY_POLICY_UPDATED}.

Ollie publishes one rule-based strategy's trading signals as a generic feed.
Every subscriber sees the same feed. This policy covers the Ollie iOS app and
the Ollie signal service it talks to.

## What Ollie stores

When you sign in with Apple, Ollie stores:

- The stable identifier Apple gives Ollie for your Apple ID. This is how Ollie
  recognizes you when you sign in again.
- An email address, only if you choose to share one with Apple. It may be an
  Apple private relay address. Ollie does not send you email.
- The invite code you entered on your first sign-in.
- When you accepted the disclaimer, and which version of it you accepted.
- Your session and agent tokens, stored only as one-way fingerprints, with
  when each was created, last used, and revoked.

The service's logs record the IP address and time of each request. They are
used to keep the service running and to limit abuse, and they are deleted
when the hosting provider's log retention expires.

## What Ollie does not collect

Ollie never asks for, sees, or stores brokerage credentials, account
balances, positions, or trades of yours. It never places orders for you. It
does not track you across other apps or websites, does not use advertising or
analytics SDKs, and does not sell or share your data with anyone.

## How it is used

Only to run the service: to sign you in, to check that you accepted the
disclaimer before an agent token is created, and to let agent tokens you
created read the feed.

## Where it is kept

On the service's database, hosted by Railway in the United States. Apple
handles Sign in with Apple under its own privacy policy.

## Deleting your account

In the app, open Agent and tap Delete account. Ollie revokes its Sign in with
Apple authorization, removes your Apple identifier, email and invite code,
and revokes every token, so no agent can use your tokens again. A record that
an anonymous account accepted the disclaimer is kept, because those records
cannot be edited after the fact. If you sign in again later, you start as a
new subscriber.

You can also stop Ollie from using your Apple ID at any time from your Apple
ID settings, under Sign in with Apple.

## Contact

Questions about this policy: privacy@notgui.com.
`;
