import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { OllieApp } from '../server/app.js';

/**
 * Placeholder for milestone 4.4. The endpoint is registered here so the app
 * shape does not change when the MCP server lands; until then `/mcp` does not
 * exist and Fastify answers 404.
 */
export interface McpEndpointDeps {
  prisma: PrismaClient;
  logger: Logger;
}

export async function registerMcpEndpoint(_app: OllieApp, _deps: McpEndpointDeps): Promise<void> {
  /* 4.4 */
}
