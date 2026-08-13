import { describe, expect, it } from 'vitest';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  MemoryOAuthStateStore,
  RH_REDIRECT_URL,
  RhOAuthProvider,
  rhClientMetadata,
} from '../src/orchestrator/robinhood/oauth.js';

const tokens = (over: Partial<OAuthTokens> = {}): OAuthTokens => ({
  access_token: 'access-1',
  token_type: 'Bearer',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  ...over,
});

describe('client metadata matches what the server advertises', () => {
  it('declares a public client, since the server supports no auth method', () => {
    // token_endpoint_auth_methods_supported: ["none"] — asking for a secret we
    // would then have to store would be strictly worse.
    expect(rhClientMetadata().token_endpoint_auth_method).toBe('none');
  });

  it('requests both grants the server supports', () => {
    expect(rhClientMetadata().grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it('registers a fixed loopback redirect', () => {
    // A redirect_uri that changed between runs would invalidate the client.
    expect(rhClientMetadata().redirect_uris).toEqual([RH_REDIRECT_URL]);
    expect(RH_REDIRECT_URL).toMatch(/^http:\/\/localhost:\d+\/callback$/);
  });

  it('names localhost rather than the loopback IP', () => {
    // Pinned because the spec-correct value is the broken one here, so this
    // reads like a mistake and would be "corrected" by anyone tidying it. RFC
    // 8252 §8.3 prefers 127.0.0.1; Robinhood's allowlist matches the literal
    // string `localhost` and silently discards the authorization otherwise —
    // no error, just a redirect to the Robinhood home page.
    expect(RH_REDIRECT_URL).not.toContain('127.0.0.1');
  });
});

describe('token persistence', () => {
  it('surfaces stored tokens to the transport', async () => {
    const provider = new RhOAuthProvider({
      store: new MemoryOAuthStateStore({ clientId: 'client-1', tokens: tokens() }),
    });
    expect((await provider.tokens())?.access_token).toBe('access-1');
  });

  it('persists a rotated refresh token', async () => {
    // The failure this guards: if the server rotates refresh tokens and we keep
    // replaying the original, the second refresh fails and the service silently
    // loses access until someone re-authorizes by hand.
    const store = new MemoryOAuthStateStore({ clientId: 'client-1', tokens: tokens() });
    const provider = new RhOAuthProvider({ store });

    await provider.saveTokens(tokens({ access_token: 'access-2', refresh_token: 'refresh-2' }));

    const state = await store.load();
    expect(state?.tokens?.refresh_token).toBe('refresh-2');
    expect(state?.clientId).toBe('client-1');
  });

  it('keeps client registration across a token write', async () => {
    const store = new MemoryOAuthStateStore();
    const provider = new RhOAuthProvider({ store });

    await provider.saveClientInformation({ client_id: 'client-9' });
    await provider.saveTokens(tokens());

    expect((await provider.clientInformation())?.client_id).toBe('client-9');
    expect((await provider.tokens())?.access_token).toBe('access-1');
  });

  it('reports no client information before registration', async () => {
    const provider = new RhOAuthProvider({ store: new MemoryOAuthStateStore() });
    expect(await provider.clientInformation()).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
  });

  it('omits client_secret entirely for a public client', async () => {
    const provider = new RhOAuthProvider({
      store: new MemoryOAuthStateStore({ clientId: 'client-1' }),
    });
    expect(await provider.clientInformation()).toEqual({ client_id: 'client-1' });
  });
});

describe('PKCE verifier', () => {
  it('round-trips a verifier', async () => {
    const provider = new RhOAuthProvider({
      store: new MemoryOAuthStateStore({ clientId: 'client-1' }),
    });
    await provider.saveCodeVerifier('verifier-abc');
    expect(await provider.codeVerifier()).toBe('verifier-abc');
  });

  it('refuses to invent a verifier it never stored', async () => {
    const provider = new RhOAuthProvider({
      store: new MemoryOAuthStateStore({ clientId: 'client-1' }),
    });
    await expect(provider.codeVerifier()).rejects.toThrow(/no PKCE code verifier/i);
  });
});

describe('the interactive leg cannot happen unattended', () => {
  it('throws rather than blocking when authorization is required', async () => {
    // A server process that waited on a browser would hang forever on Railway.
    const provider = new RhOAuthProvider({
      store: new MemoryOAuthStateStore({ clientId: 'client-1', tokens: tokens() }),
    });
    await expect(
      provider.redirectToAuthorization(new URL('https://robinhood.com/oauth?x=1')),
    ).rejects.toThrow(/rh:authorize/);
  });

  it('lets the authorize script opt into handling it', async () => {
    const seen: URL[] = [];
    const provider = new RhOAuthProvider({
      store: new MemoryOAuthStateStore({ clientId: 'client-1' }),
      onAuthorizationRequired: (url) => {
        seen.push(url);
      },
    });

    await provider.redirectToAuthorization(new URL('https://robinhood.com/oauth?x=1'));
    expect(seen).toHaveLength(1);
  });
});
