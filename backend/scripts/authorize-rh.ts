/**
 * One-time interactive authorization against the Robinhood trading MCP.
 *
 *   npm run rh:authorize
 *
 * Runs the half of OAuth that needs a human: dynamic client registration, a PKCE
 * authorization request, a browser visit to robinhood.com, and the code-for-token
 * exchange. Prints the refresh token to persist afterwards.
 *
 * This exists as a script rather than as part of the service because it cannot
 * be automated. Railway has no browser; whatever this produces is what ships.
 */
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  discoverAuthorizationServerMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { getConfig } from '../src/config/index.js';
import {
  MemoryOAuthStateStore,
  RH_OAUTH_SCOPE,
  RH_REDIRECT_PORT,
  RH_REDIRECT_URL,
  rhClientMetadata,
} from '../src/orchestrator/robinhood/oauth.js';

/**
 * Waits for the browser to come back to the loopback listener with a code.
 *
 * Two servers, one per loopback address, because neither alone is safe *and*
 * reliable. The redirect names `localhost` (Robinhood's allowlist demands the
 * string), and macOS resolves that to ::1 before 127.0.0.1 — so binding only
 * the IPv4 loopback can refuse the callback after a successful authorization.
 * Binding every interface would fix that by exposing a server holding a live
 * authorization code to the whole network, which is not a trade worth making
 * for a browser redirect that never leaves this machine.
 */
async function awaitAuthorizationCode(expectedState: string): Promise<string> {
  const servers = [createServer(), createServer()];
  const result = new Promise<string>((resolve, reject) => {
    const onRequest = (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ): void => {
      const url = new URL(req.url ?? '/', RH_REDIRECT_URL);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      const fail = (message: string): void => {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(message);
        reject(new Error(message));
      };

      if (error) {
        fail(`Robinhood refused the authorization: ${error}`);
        return;
      }
      // Without this check a third party could feed us a code of their choosing.
      if (state !== expectedState) {
        fail('state parameter did not match; discarding this response');
        return;
      }
      if (!code) {
        fail('callback carried no authorization code');
        return;
      }

      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<h1>Ollie is authorized</h1><p>You can close this tab.</p>');
      resolve(code);
    };

    for (const server of servers) server.on('request', onRequest);
  });

  const [v4, v6] = servers as [Server, Server];
  v4.listen(RH_REDIRECT_PORT, '127.0.0.1');
  await once(v4, 'listening');

  // The IPv6 half is best-effort: a host with IPv6 disabled has no ::1 to bind,
  // and that is not a reason to fail an otherwise working flow.
  const v6Listening = once(v6, 'listening');
  v6.on('error', () => {
    /* no ::1 on this host; the IPv4 listener carries the callback */
  });
  v6.listen(RH_REDIRECT_PORT, '::1');
  await Promise.race([v6Listening, once(v6, 'error')]).catch(() => undefined);

  try {
    return await result;
  } finally {
    for (const server of servers) server.close();
  }
}

function openBrowser(url: URL): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [url.toString()], { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  const config = getConfig();
  const serverUrl = new URL(config.robinhood.mcpUrl);

  console.log(`Authorizing against ${serverUrl.href}\n`);

  const metadata = await discoverAuthorizationServerMetadata(serverUrl);
  if (!metadata) {
    throw new Error(`no OAuth metadata discoverable at ${serverUrl.href}`);
  }
  console.log(`  authorize  ${metadata.authorization_endpoint}`);
  console.log(`  token      ${metadata.token_endpoint}`);

  if (!metadata.registration_endpoint) {
    throw new Error(
      'server does not support dynamic client registration; a client_id must be issued by hand',
    );
  }

  const clientInfo = await registerClient(serverUrl, {
    metadata,
    clientMetadata: rhClientMetadata(),
  });
  console.log(`  client_id  ${clientInfo.client_id}\n`);

  const store = new MemoryOAuthStateStore({ clientId: clientInfo.client_id });

  // `state` is not optional here, whatever the RFC says about it being
  // RECOMMENDED. Robinhood discards an authorization request that omits it and
  // redirects the browser to the account page — no consent screen, no error, so
  // it reads as "the link did nothing". The SDK only sends state when asked, so
  // the omission is silent on both ends. Verified 2026-08-12 by sending the same
  // URL with and without it.
  const state = randomBytes(16).toString('hex');

  const { authorizationUrl, codeVerifier } = await startAuthorization(serverUrl, {
    metadata,
    clientInformation: clientInfo,
    redirectUrl: RH_REDIRECT_URL,
    scope: RH_OAUTH_SCOPE,
    state,
  });
  const codePromise = awaitAuthorizationCode(state);

  console.log('Opening your browser to authorize. If it does not open, visit:\n');
  console.log(`  ${authorizationUrl.href}\n`);
  openBrowser(authorizationUrl);

  const code = await codePromise;
  console.log('Authorization code received; exchanging for tokens.\n');

  const tokens = await exchangeAuthorization(serverUrl, {
    metadata,
    clientInformation: clientInfo,
    authorizationCode: code,
    codeVerifier,
    redirectUri: RH_REDIRECT_URL,
  });

  await store.save({ clientId: clientInfo.client_id, tokens, codeVerifier });

  const expiry = tokens.expires_in ? `${tokens.expires_in}s` : 'unspecified';
  console.log('Authorized.\n');
  console.log(`  access token expires in  ${expiry}`);
  console.log(`  refresh token present    ${tokens.refresh_token ? 'yes' : 'NO'}`);
  console.log(`  scope                    ${tokens.scope ?? RH_OAUTH_SCOPE}\n`);

  if (!tokens.refresh_token) {
    console.log(
      'WARNING: no refresh token was issued, so this access token cannot be renewed\n' +
        'without repeating this flow by hand. That makes an unattended deploy impossible;\n' +
        'resolve it before relying on the scheduler.\n',
    );
  }

  console.log('Put these in .env locally and in the Railway service variables:\n');
  console.log(`RH_OAUTH_CLIENT_ID=${clientInfo.client_id}`);
  console.log(`RH_OAUTH_REFRESH_TOKEN=${tokens.refresh_token ?? ''}`);
  console.log(`RH_MCP_AUTH_TOKEN=${tokens.access_token}`);
  console.log(
    '\nThe access token is short-lived and only useful for an immediate manual run;\n' +
      'the refresh token is the durable credential. Treat both as secrets.\n',
  );
}

main().catch((error: unknown) => {
  console.error('\nAuthorization failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
