import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { deleteDevice, upsertDevice } from '../../db/devices.js';
import { ErrorSchema } from '../schemas.js';

/**
 * Device registration for push. Upserts, because APNs tokens rotate and the
 * app re-registers on every launch — the same physical device must not
 * accumulate rows. Unregistering is the app's Disconnect: a device that has
 * let go of the owner token must stop receiving the owner's signals.
 */

const DeviceRegistrationSchema = z
  .object({
    apns_token: z.string().min(1),
    environment: z
      .enum(['sandbox', 'production'])
      .default('production')
      .describe('Sandbox for development builds; a token is only valid against one of the two'),
  })
  .meta({ id: 'DeviceRegistration' });

const DeviceUnregistrationSchema = z
  .object({ apns_token: z.string().min(1) })
  .meta({ id: 'DeviceUnregistration' });

const DeviceSchema = z
  .object({
    id: z.string().uuid(),
    environment: z.enum(['sandbox', 'production']),
    last_seen_at: z.string().datetime(),
  })
  .meta({ id: 'Device' });

export const registerDeviceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/devices',
    {
      schema: {
        operationId: 'registerDevice',
        summary: 'Register this device for push notifications',
        description:
          'Idempotent. Re-registering the same token updates its environment and last-seen ' +
          'time rather than creating a second row.\n\n' +
          'The response deliberately omits the token: it is write-only from the API\'s point ' +
          'of view, and the caller already has it.',
        tags: ['devices'],
        security: [{ ownerToken: [] }],
        body: DeviceRegistrationSchema,
        response: {
          200: DeviceSchema,
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid owner token'),
        },
      },
    },
    async (request, reply) => {
      const device = await upsertDevice({
        apnsToken: request.body.apns_token,
        environment: request.body.environment,
      });

      return reply.code(200).send({
        id: device.id,
        environment: device.environment === 'sandbox' ? 'sandbox' : 'production',
        last_seen_at: device.lastSeenAt.toISOString(),
      });
    },
  );

  // A POST with a body rather than DELETE /devices/:token, so the token stays
  // out of the URL and the request log, as it is everywhere else.
  app.post(
    '/devices/unregister',
    {
      schema: {
        operationId: 'unregisterDevice',
        summary: 'Stop sending push notifications to this device',
        description:
          'Idempotent. Called when the app disconnects from the owner token; an unknown token ' +
          'is not an error, so a retry or a token the backend already pruned still succeeds.',
        tags: ['devices'],
        security: [{ ownerToken: [] }],
        body: DeviceUnregistrationSchema,
        response: {
          204: z.null().describe('Unregistered, or already was'),
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid owner token'),
        },
      },
    },
    async (request, reply) => {
      await deleteDevice(request.body.apns_token);
      return reply.code(204).send(null);
    },
  );
};
