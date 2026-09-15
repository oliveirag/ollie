import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { currentDisclaimer } from '../published/disclaimer.js';
import type { OllieApp } from '../server/app.js';
import { authenticateMcpBearer } from './auth.js';
import { readFeed, readPublishedSignalDetail, readSubscriberTrackRecord } from './routes/feed.js';

/**
 * The Ollie Signal MCP server (PRD §4.5; Phase 4, decision 5).
 *
 * Four read-only tools over the same functions the REST feed uses — one
 * projection, three consumers. Deliberately absent: anything that writes,
 * anything named order/account/position/watchlist/quote, anything
 * broker-shaped. This process has no broker client to call even if a tool
 * wanted one, and a test walks the import graph to keep it that way. A second
 * test pins the exact tool list so an addition fails CI until it is changed in
 * review.
 *
 * Authentication happens at the HTTP layer before the transport sees a byte:
 * a missing, unknown, revoked, or wrong-kind bearer gets a bodyless 401 — no
 * session, no tool list, no error detail. Stateless transport, one server
 * instance per request; the tools read rows and return, so there is no
 * session state worth keeping.
 */

export const MCP_TOOL_NAMES = ['get_disclaimer', 'get_signal', 'get_track_record', 'list_signals'] as const;

export const MCP_SERVER_INFO = { name: 'ollie-signal', version: '0.1.0' } as const;

export function mcpInstructions(): string {
  const { text, version } = currentDisclaimer();
  return (
    'Ollie publishes generic, non-personalized trading signals that one owner\'s rule-based ' +
    'strategy produced and that the owner acted on in their own account. Every subscriber sees ' +
    'the same signals. Your agent decides what, if anything, to do with them; nothing here can ' +
    'touch any brokerage account, place or read any order, or see any position of yours.\n\n' +
    'The track record is computed at read time from append-only rows. get_signal returns those ' +
    'rows verbatim, so any published number can be recomputed. If the curve ever changes for a ' +
    'past date, a correction row was appended: the rows are public, recompute them.\n\n' +
    `Disclaimer (version ${version}):\n\n${text}`
  );
}

export interface McpEndpointDeps {
  prisma: PrismaClient;
  logger: Logger;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function buildMcpServer(prisma: PrismaClient): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: mcpInstructions() });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    'list_signals',
    {
      title: 'List published signals',
      description:
        'Published signals, newest first. Only signals the owner approved and whose fill was ' +
        'recorded appear, and only after that fill. Identical for every subscriber.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Default 50'),
        since: z
          .string()
          .datetime()
          .optional()
          .describe('Only signals published at or after this ISO-8601 instant'),
      },
      annotations: readOnly,
    },
    async ({ limit, since }) => {
      const page = await readFeed(prisma, {
        limit: limit ?? 50,
        ...(since ? { since: new Date(since) } : {}),
      });
      return jsonResult({ signals: page.signals, next_before: page.nextBefore });
    },
  );

  server.registerTool(
    'get_signal',
    {
      title: 'Get one published signal with its record rows',
      description:
        'The signal plus every track-record row behind it: entry, daily marks with the price ' +
        'each was taken at, the close, and any correction. The recompute path for every ' +
        'published number. An unpublished or unknown id is not found.',
      inputSchema: { id: z.string().uuid() },
      annotations: readOnly,
    },
    async ({ id }) => {
      const detail = await readPublishedSignalDetail(prisma, id);
      if (!detail) {
        return { content: [{ type: 'text' as const, text: 'not found' }], isError: true };
      }
      return jsonResult(detail);
    },
  );

  server.registerTool(
    'get_track_record',
    {
      title: 'Get the track record',
      description:
        'Closed trades, wins, win rate (null until a trade closes), average return, realized ' +
        'PnL, the daily curve with withheld days marked, and open positions at daily-mark ' +
        'granularity. No live quotes: value is as of the prior close, by design.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => jsonResult(await readSubscriberTrackRecord(prisma)),
  );

  server.registerTool(
    'get_disclaimer',
    {
      title: 'Get the disclaimer',
      description: 'The current disclaimer text and its version. Read it before acting on anything here.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => jsonResult(currentDisclaimer()),
  );

  return server;
}

export async function registerMcpEndpoint(app: OllieApp, deps: McpEndpointDeps): Promise<void> {
  const { prisma, logger } = deps;
  const log = logger.child({ component: 'mcp' });

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateMcpBearer(request, prisma);
    if (!user) {
      log.warn({ method: request.method, has_header: Boolean(request.headers.authorization) }, 'rejected mcp request');
      // Nothing. Not a JSON-RPC error, not a WWW-Authenticate hint, not a byte.
      return reply.code(401).send();
    }

    const server = buildMcpServer(prisma);
    // No sessionIdGenerator: that is the SDK's stateless mode.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

    reply.hijack();
    try {
      // Same exactOptionalPropertyTypes mismatch the broker client works around.
      await server.connect(transport as Parameters<McpServer['connect']>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      log.error({ err: error, user_id: user.id }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.end();
      }
    } finally {
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
    }
    return reply;
  };

  // Stateless: GET (server-push stream) and DELETE (session end) have nothing
  // to do, and the transport answers them itself with 405 — after auth.
  app.post('/mcp', { schema: { hide: true } }, handle);
  app.get('/mcp', { schema: { hide: true } }, handle);
  app.delete('/mcp', { schema: { hide: true } }, handle);
}
