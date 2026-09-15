import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { stringify } from 'yaml';
import { buildConfig } from '../config/index.js';
import { OPENAPI_HEADER, pruneUnreferencedSchemas, toOpenApi30 } from '../server/openapi.js';
import { buildSignalApp } from './app.js';

/**
 * Render `docs/openapi-subscriber.yaml` from the signal service's routes. Same
 * pipeline as the owner document: prune, downgrade to 3.0.3 for the Swift
 * generator, emit unfolded YAML. The app is built but never listens, and the
 * Prisma client it is handed never connects — rendering a spec needs no
 * database and no Apple.
 */
export async function renderSubscriberOpenApiYaml(): Promise<string> {
  const config = buildConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://spec:spec@localhost:5432/spec',
  });
  const prisma = new PrismaClient({ datasourceUrl: 'postgresql://spec:spec@localhost:1/spec' });

  const app = await buildSignalApp({
    config,
    logger: pino({ level: 'silent' }),
    prisma,
    siwa: {
      verify: async () => {
        throw new Error('spec rendering never verifies a token');
      },
    },
  });
  try {
    await app.ready();
    const document = app.swagger() as Record<string, unknown>;
    pruneUnreferencedSchemas(document);
    toOpenApi30(document);
    return OPENAPI_HEADER + stringify(document, { lineWidth: 0 });
  } finally {
    await app.close();
  }
}
