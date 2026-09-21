import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The one hashing doctrine for every bearer credential in the codebase.
 *
 * Phase 2's owner token is compared through it (the expected value lives in
 * the environment); Phase 4's subscriber tokens are *stored* through it (only
 * the hash lives in the database). Same primitive either way, so there is one
 * place to be wrong about it.
 */

/** Hex sha256, the at-rest form of a subscriber token. */
export function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Compare via fixed-width digests rather than the raw strings.
 * `timingSafeEqual` throws on a length mismatch, and that throw is itself an
 * oracle for the token's length — hashing first makes every comparison the
 * same 32 bytes regardless of what was presented.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * A fresh opaque token. The prefix is not security — it is so a token found
 * in a log or a pasted config is recognisable for what it is and which
 * surface it belongs to, the way `sk-` and `ghp_` are.
 */
export function generateSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('hex')}`;
}
