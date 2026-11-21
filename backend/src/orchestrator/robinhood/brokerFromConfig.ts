import type { Logger } from 'pino';
import type { Config } from '../../config/index.js';
import type { BrokerAdapter } from './client.js';
import { McpBrokerAdapter } from './mcpClient.js';
import { MockBrokerAdapter } from './mockClient.js';

/**
 * The broker `BROKER` names. `mock` fills every allowlisted symbol on the
 * first poll and contacts nothing; the orchestrator refuses it in production.
 * Shared by the service and the CLIs so they agree on what `BROKER=mock` means.
 */
export function brokerFromConfig(config: Config, logger: Logger): BrokerAdapter {
  if (config.broker === 'mock') {
    return new MockBrokerAdapter({
      orderScripts: Object.fromEntries(
        config.symbolAllowlist.map((symbol) => [
          symbol,
          { states: [{ state: 'confirmed' }, { state: 'filled' }] },
        ]),
      ),
    });
  }
  return new McpBrokerAdapter({ logger });
}
