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
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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

/** Waits for the browser to come back to the loopback listener with a code. */
async function awaitAuthorizationCode(expectedState: string): Promise<string> {
  const server = createServer();
  const result = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
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
    });
  });

  server.listen(RH_REDIRECT_PORT, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await result;
  } finally {
    server.close();
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

  const { authorizationUrl, codeVerifier } = await startAuthorization(serverUrl, {
    metadata,
    clientInformation: clientInfo,
    redirectUrl: RH_REDIRECT_URL,
    scope: RH_OAUTH_SCOPE,
  });

  const state = authorizationUrl.searchParams.get('state') ?? '';
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
