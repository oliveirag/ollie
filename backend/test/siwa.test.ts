import {
  SignJWT,
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  type CryptoKey,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  APPLE_ISSUER,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  InvalidIdentityTokenError,
  SiwaRevokeError,
  buildSiwaRevoker,
  buildSiwaVerifier,
  type SiwaVerifier,
} from '../src/signal-server/siwa.js';

/**
 * The verifier against locally-minted tokens. No network: the key set is a
 * generated RSA pair exported as a JWKS, which is exactly the shape Apple
 * serves. A second pair stands in for "someone else's key".
 */
const AUDIENCE = 'com.guilhermeoliveira.Ollie';

let verifier: SiwaVerifier;
let sign: (claims: Record<string, unknown>, options?: { key?: CryptoKey; alg?: string }) => Promise<string>;
let appleKey: CryptoKey;
let strangerKey: CryptoKey;

const now = () => new Date('2026-09-15T12:00:00.000Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

beforeAll(async () => {
  const apple = await generateKeyPair('RS256');
  const stranger = await generateKeyPair('RS256');
  appleKey = apple.privateKey;
  strangerKey = stranger.privateKey;

  const jwk = await exportJWK(apple.publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'apple-1', alg: 'RS256', use: 'sig' }] });
  verifier = buildSiwaVerifier({ audience: AUDIENCE, keys, now });

  sign = async (claims, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: 'apple-1' })
      .sign(options.key ?? appleKey);
});

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: APPLE_ISSUER,
    aud: AUDIENCE,
    sub: '001234.abcdef.5678',
    email: 'xyz@privaterelay.appleid.com',
    iat: seconds(now()) - 60,
    exp: seconds(now()) + 600,
    ...overrides,
  };
}

describe('Sign in with Apple verification', () => {
  it('accepts a valid token and returns the subject and email', async () => {
    const identity = await verifier.verify(await sign(validClaims()));

    expect(identity).toEqual({ appleUserId: '001234.abcdef.5678', email: 'xyz@privaterelay.appleid.com' });
  });

  it('treats a missing email as null rather than an error', async () => {
    const claims = validClaims();
    delete (claims as { email?: unknown }).email;

    expect((await verifier.verify(await sign(claims))).email).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const token = await sign(validClaims());
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify(validClaims({ sub: 'someone-else' })))
      .toString('base64url');

    await expect(verifier.verify(`${header}.${forged}.${signature}`)).rejects.toThrow(
      InvalidIdentityTokenError,
    );
    void payload;
  });

  it('rejects a token signed by a key Apple does not hold', async () => {
    await expect(
      verifier.verify(await sign(validClaims(), { key: strangerKey })),
    ).rejects.toThrow(InvalidIdentityTokenError);
  });

  it('rejects the wrong audience', async () => {
    await expect(
      verifier.verify(await sign(validClaims({ aud: 'com.example.NotOllie' }))),
    ).rejects.toThrow(InvalidIdentityTokenError);
  });

  it('rejects the wrong issuer', async () => {
    await expect(
      verifier.verify(await sign(validClaims({ iss: 'https://accounts.example.com' }))),
    ).rejects.toThrow(InvalidIdentityTokenError);
  });

  it('rejects an expired token', async () => {
    await expect(
      verifier.verify(await sign(validClaims({ exp: seconds(now()) - 1 }))),
    ).rejects.toThrow(InvalidIdentityTokenError);
  });

  it('rejects a token with no subject', async () => {
    const claims = validClaims();
    delete (claims as { sub?: unknown }).sub;

    await expect(verifier.verify(await sign(claims))).rejects.toThrow(/missing subject/);
  });

  it('rejects garbage', async () => {
    await expect(verifier.verify('not.a.jwt')).rejects.toThrow(InvalidIdentityTokenError);
    await expect(verifier.verify('')).rejects.toThrow(InvalidIdentityTokenError);
  });
});

describe('the Sign in with Apple revoker', () => {
  interface Call {
    url: string;
    form: URLSearchParams;
  }

  async function setup(responses: Array<{ status: number; body: unknown }>) {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const calls: Call[] = [];
    const queue = [...responses];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? '')) });
      const next = queue.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch;
    const revoker = buildSiwaRevoker({
      clientId: AUDIENCE,
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      // As it arrives from an env var with escaped newlines.
      privateKey: pem.replace(/\n/g, '\\n'),
      fetch: fakeFetch,
      now,
    });
    return { revoker, calls, publicKey };
  }

  it('exchanges the code, then revokes the refresh token, with a valid client secret', async () => {
    const { revoker, calls, publicKey } = await setup([
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', id_token: 'x' } },
      { status: 200, body: {} },
    ]);

    await revoker.revokeAuthorizationCode('code-1');

    expect(calls.map((c) => c.url)).toEqual([APPLE_TOKEN_URL, APPLE_REVOKE_URL]);
    expect(Object.fromEntries(calls[0]!.form)).toMatchObject({
      client_id: AUDIENCE,
      code: 'code-1',
      grant_type: 'authorization_code',
    });
    expect(Object.fromEntries(calls[1]!.form)).toMatchObject({
      client_id: AUDIENCE,
      token: 'rt',
      token_type_hint: 'refresh_token',
    });

    const secret = calls[0]!.form.get('client_secret')!;
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    const { payload } = await jwtVerify(secret, publicKey, {
      issuer: 'TEAM123456',
      audience: APPLE_ISSUER,
      subject: AUDIENCE,
      currentDate: now(),
    });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300);
  });

  it('reports which stage failed and why', async () => {
    const { revoker } = await setup([{ status: 400, body: { error: 'invalid_grant' } }]);
    const failure = await revoker.revokeAuthorizationCode('stale').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SiwaRevokeError);
    expect(failure).toMatchObject({ stage: 'token', status: 400 });
    expect((failure as SiwaRevokeError).reason).toContain('invalid_grant');
  });

  it('fails the revoke stage when Apple refuses the revocation', async () => {
    const { revoker } = await setup([
      { status: 200, body: { refresh_token: 'rt' } },
      { status: 503, body: {} },
    ]);
    await expect(revoker.revokeAuthorizationCode('code')).rejects.toMatchObject({
      stage: 'revoke',
      status: 503,
    });
  });
});

