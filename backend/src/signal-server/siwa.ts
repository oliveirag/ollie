import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Sign in with Apple identity-token verification (Phase 4, decision 3).
 *
 * The app hands the backend the identity token Apple issued it; this module
 * proves it is genuine and current before the subject is trusted as an
 * identity. Pure over its inputs: the key set is injected so the tests sign
 * tokens with a locally generated key and never touch the network. Production
 * uses Apple's JWKS, fetched and cached by jose.
 */

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

export interface AppleIdentity {
  /** Apple's stable subject for this user and this team. THE identity. */
  appleUserId: string;
  /** May be a private-relay address, or absent after the first sign-in. */
  email: string | null;
}

export class InvalidIdentityTokenError extends Error {
  constructor(public readonly reason: string) {
    super(`identity token rejected: ${reason}`);
    this.name = 'InvalidIdentityTokenError';
  }
}

export interface SiwaVerifierOptions {
  /** The app's bundle identifier; Apple sets it as the token audience. */
  audience: string;
  /** Defaults to Apple's remote JWKS. Tests pass a local set. */
  keys?: JWTVerifyGetKey;
  now?: () => Date;
}

export interface SiwaVerifier {
  verify(identityToken: string): Promise<AppleIdentity>;
}

export function buildSiwaVerifier(options: SiwaVerifierOptions): SiwaVerifier {
  const keys = options.keys ?? createRemoteJWKSet(APPLE_JWKS_URL);

  return {
    async verify(identityToken) {
      let payload;
      try {
        ({ payload } = await jwtVerify(identityToken, keys, {
          issuer: APPLE_ISSUER,
          audience: options.audience,
          // Apple signs with RS256; pinning the algorithm closes the
          // alg-confusion class of attack regardless of what the key set holds.
          algorithms: ['RS256'],
          ...(options.now ? { currentDate: options.now() } : {}),
        }));
      } catch (error) {
        // jose's messages are precise about *why*, which is useful in a log and
        // must not reach a client. The caller renders a bodyless 401 either way.
        const reason =
          error instanceof errors.JOSEError ? `${error.code}: ${error.message}` : 'unreadable';
        throw new InvalidIdentityTokenError(reason);
      }

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new InvalidIdentityTokenError('missing subject');
      }

      const email = typeof payload.email === 'string' && payload.email ? payload.email : null;
      return { appleUserId: payload.sub, email };
    },
  };
}
