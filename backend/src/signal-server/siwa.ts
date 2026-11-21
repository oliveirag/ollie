import {
  SignJWT,
  createRemoteJWKSet,
  errors,
  importPKCS8,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

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

/**
 * A verifier that accepts `fake:{"sub":…,"email":…}` tokens. For the simulator
 * and the UI tests only: Sign in with Apple needs a paid Apple Developer team
 * and per-app configuration that a local run does not have (Phase 4, risk 3).
 * The service refuses to enable it in production; see index.ts.
 */
export const stubSiwaVerifier: SiwaVerifier = {
  async verify(identityToken) {
    if (!identityToken.startsWith('fake:')) throw new InvalidIdentityTokenError('not a stub token');
    let parsed: { sub?: unknown; email?: unknown };
    try {
      parsed = JSON.parse(identityToken.slice('fake:'.length)) as typeof parsed;
    } catch {
      throw new InvalidIdentityTokenError('unreadable stub token');
    }
    if (typeof parsed.sub !== 'string' || parsed.sub.length === 0) {
      throw new InvalidIdentityTokenError('missing subject');
    }
    return {
      appleUserId: parsed.sub,
      email: typeof parsed.email === 'string' && parsed.email ? parsed.email : null,
    };
  },
};

/**
 * Sign in with Apple token revocation, for account deletion. Apple requires an
 * app that offers Sign in with Apple to revoke the user's tokens through its
 * REST API when the account is deleted (TN3194).
 *
 * The app signs in again just before deleting and hands over the fresh
 * authorization code. That code is exchanged for a refresh token at
 * /auth/token, and the refresh token is revoked at /auth/revoke. The backend
 * never stores either: the exchange exists only to have something to revoke.
 *
 * Both calls authenticate with a client secret, a short-lived ES256 JWT signed
 * with a Sign in with Apple key from the developer account. `fetch` is
 * injected so the tests never reach Apple.
 */

export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

export interface SiwaRevokerOptions {
  /** The app's bundle identifier: the client_id the code was issued to. */
  clientId: string;
  teamId: string;
  keyId: string;
  /** The .p8 key's PEM. Literal `\n` sequences are accepted for env vars. */
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface SiwaRevoker {
  /** Exchange the code for a refresh token and revoke it. Throws on failure. */
  revokeAuthorizationCode(authorizationCode: string): Promise<void>;
}

export class SiwaRevokeError extends Error {
  constructor(
    public readonly stage: 'token' | 'revoke',
    public readonly status: number | null,
    public readonly reason: string,
  ) {
    super(`sign in with apple ${stage} call failed: ${status ?? 'no response'} ${reason}`);
    this.name = 'SiwaRevokeError';
  }
}

/** Apple accepts up to six months; five minutes is all one deletion needs. */
const CLIENT_SECRET_TTL_SECONDS = 300;

export function buildSiwaRevoker(options: SiwaRevokerOptions): SiwaRevoker {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const pem = options.privateKey.replace(/\\n/g, '\n');
  let keyPromise: ReturnType<typeof importPKCS8> | null = null;

  async function clientSecret(): Promise<string> {
    keyPromise ??= importPKCS8(pem, 'ES256');
    const issuedAt = Math.floor(now().getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: options.keyId })
      .setIssuer(options.teamId)
      .setSubject(options.clientId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + CLIENT_SECRET_TTL_SECONDS)
      .sign(await keyPromise);
  }

  async function post(
    stage: 'token' | 'revoke',
    url: string,
    form: Record<string, string>,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    } catch (error) {
      throw new SiwaRevokeError(stage, null, error instanceof Error ? error.message : 'unreachable');
    }
    if (!response.ok) {
      // Apple's error body is a small JSON object like {"error":"invalid_grant"}.
      // It names the problem and carries no secret, so it is safe to log.
      const body = await response.text().catch(() => '');
      throw new SiwaRevokeError(stage, response.status, body.slice(0, 200));
    }
    return response;
  }

  return {
    async revokeAuthorizationCode(authorizationCode) {
      const secret = await clientSecret();
      const exchanged = await post('token', APPLE_TOKEN_URL, {
        client_id: options.clientId,
        client_secret: secret,
        code: authorizationCode,
        grant_type: 'authorization_code',
      });
      const tokens = (await exchanged.json().catch(() => ({}))) as {
        refresh_token?: unknown;
        access_token?: unknown;
      };
      // A refresh token outlives the access token, so it is the one worth
      // revoking. Apple returns one for every code exchange; the access token
      // is the fallback in case it ever does not.
      const [token, hint] =
        typeof tokens.refresh_token === 'string'
          ? [tokens.refresh_token, 'refresh_token']
          : typeof tokens.access_token === 'string'
            ? [tokens.access_token, 'access_token']
            : [null, null];
      if (!token || !hint) throw new SiwaRevokeError('token', exchanged.status, 'no token in response');

      await post('revoke', APPLE_REVOKE_URL, {
        client_id: options.clientId,
        client_secret: secret,
        token,
        token_type_hint: hint,
      });
    },
  };
}
