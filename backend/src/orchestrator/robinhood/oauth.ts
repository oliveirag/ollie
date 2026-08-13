/**
 * OAuth 2.1 + PKCE client for the Robinhood trading MCP.
 *
 * Verified against the server's discovery documents on 2026-08-04:
 *
 *   authorize  https://robinhood.com/oauth
 *   token      https://api.robinhood.com/oauth2/token/
 *   register   https://agent.robinhood.com/oauth/trading/register   (RFC 7591)
 *   grants     authorization_code, refresh_token
 *   PKCE       S256 (required)
 *   client     public — token_endpoint_auth_methods_supported: ["none"]
 *   scope      internal
 *
 * The consequence that shapes this file: obtaining the first token requires a
 * human in a browser at robinhood.com/oauth. Nothing headless can do it, so the
 * flow is split in two. `scripts/authorize-rh.ts` runs the interactive half once
 * and persists the result; the orchestrator only ever runs the refresh half.
 *
 * Passing this provider to StreamableHTTPClientTransport as `authProvider` makes
 * the SDK refresh an expired access token on its own, which is why there is no
 * hand-rolled retry-on-401 anywhere in the adapter.
 */
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

/** Everything the orchestrator must remember between runs to stay authorized. */
export interface StoredOAuthState {
  clientId: string;
  clientSecret?: string;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/**
 * Where that state lives.
 *
 * Deliberately an interface. Refresh tokens commonly rotate on use, and we have
 * not yet observed whether Robinhood's do — if they do, the credential changes
 * at runtime and an environment variable can no longer hold it. Swapping the
 * implementation must not require touching the provider.
 */
export interface OAuthStateStore {
  load(): Promise<StoredOAuthState | undefined>;
  save(state: StoredOAuthState): Promise<void>;
}

/** In-memory store, seeded from a refresh token. Used by the orchestrator. */
export class MemoryOAuthStateStore implements OAuthStateStore {
  private state: StoredOAuthState | undefined;

  constructor(seed?: StoredOAuthState) {
    this.state = seed;
  }

  async load(): Promise<StoredOAuthState | undefined> {
    return this.state;
  }

  async save(state: StoredOAuthState): Promise<void> {
    this.state = state;
  }

  /** Exposed so a caller can detect rotation and persist the new value. */
  snapshot(): StoredOAuthState | undefined {
    return this.state;
  }
}

export const RH_OAUTH_SCOPE = 'internal';

/**
 * Loopback redirect.
 *
 * **This does not currently work, and the flow below cannot complete.** The
 * earlier claim here — that dynamic client registration gets this redirect
 * registered for us — is false. Probed 2026-08-12: POSTing three different
 * client metadata documents to the registration endpoint returns the *same*
 * fixed `client_id` every time, named "Robinhood Trading", with our
 * `redirect_uris` echoed back but ignored. Registration is a stub that hands
 * out one pre-provisioned public client whose allowed redirects we cannot
 * influence.
 *
 * The visible symptom is not an error. `robinhood.com/oauth` silently
 * redirects to the Robinhood home page, so the browser shows no consent screen
 * and the loopback listener waits forever.
 *
 * Everything else we send matches the server's advertised metadata (scope
 * `internal`, S256, the authorize endpoint) — the redirect URI is the sole
 * problem, and nothing on our side can fix it. Obtaining an unattended refresh
 * token needs a client provisioned by Robinhood with a redirect we control.
 * Port is fixed so the value stays stable across runs if that ever arrives.
 */
export const RH_REDIRECT_PORT = 8788;
export const RH_REDIRECT_URL = `http://127.0.0.1:${RH_REDIRECT_PORT}/callback`;

export function rhClientMetadata(): OAuthClientMetadata {
  return {
    client_name: 'Ollie Orchestrator',
    redirect_uris: [RH_REDIRECT_URL],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // The server advertises exactly this and nothing else. Asking for a secret
    // we would then have to store would be strictly worse.
    token_endpoint_auth_method: 'none',
    scope: RH_OAUTH_SCOPE,
  };
}

export interface RhOAuthProviderOptions {
  store: OAuthStateStore;
  /** Invoked when a browser visit is required. Throws in the orchestrator. */
  onAuthorizationRequired?: (url: URL) => void | Promise<void>;
}

/**
 * OAuthClientProvider backed by an OAuthStateStore.
 *
 * `redirectToAuthorization` is the seam between the two halves of the flow. The
 * authorize script points it at a browser; the orchestrator leaves it throwing,
 * so a production process can never silently block waiting on a human.
 */
export class RhOAuthProvider implements OAuthClientProvider {
  private readonly store: OAuthStateStore;
  private readonly onAuthorizationRequired: (url: URL) => void | Promise<void>;

  constructor(options: RhOAuthProviderOptions) {
    this.store = options.store;
    this.onAuthorizationRequired =
      options.onAuthorizationRequired ??
      ((url) => {
        throw new Error(
          'Robinhood MCP authorization has expired and cannot be renewed without a ' +
            `browser. Run \`npm run rh:authorize\` and update the stored credential. (${url.origin})`,
        );
      });
  }

  get redirectUrl(): string {
    return RH_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return rhClientMetadata();
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await this.store.load();
    if (!state?.clientId) return undefined;
    return state.clientSecret === undefined
      ? { client_id: state.clientId }
      : { client_id: state.clientId, client_secret: state.clientSecret };
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const state = (await this.store.load()) ?? { clientId: info.client_id };
    const secret = 'client_secret' in info ? info.client_secret : undefined;
    await this.store.save({
      ...state,
      clientId: info.client_id,
      ...(secret === undefined ? {} : { clientSecret: secret }),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.load())?.tokens;
  }

  /**
   * Called by the SDK after both the initial exchange and every refresh. If the
   * server rotates refresh tokens, this is where the new one arrives — which is
   * precisely why the store is an interface and not a constant.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const state = await this.store.load();
    if (!state) {
      throw new Error('cannot save tokens before a client is registered');
    }
    await this.store.save({ ...state, tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onAuthorizationRequired(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const state = await this.store.load();
    if (!state) {
      throw new Error('cannot save a code verifier before a client is registered');
    }
    await this.store.save({ ...state, codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.store.load())?.codeVerifier;
    if (!verifier) {
      throw new Error('no PKCE code verifier stored; the authorization flow was not started here');
    }
    return verifier;
  }
}
