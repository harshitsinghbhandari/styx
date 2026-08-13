import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/pool.js';
import { authenticate } from './auth.js';
import { sendError } from './errors.js';
import { registerRoutes } from './routes.js';
import { registerEventsRoute } from './sse.js';

const UNAUTHENTICATED_PATHS = new Set(['/v1/health']);

export function buildApp(pool: Pool = defaultPool): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/v1/health', async () => ({ ok: true }));

  app.addHook('onRequest', async (request) => {
    if (UNAUTHENTICATED_PATHS.has(request.url.split('?')[0])) return;
    request.agent = await authenticate(pool, request);
  });

  registerRoutes(app, pool);
  registerEventsRoute(app, pool);

  app.setErrorHandler((err, _request, reply) => {
    sendError(reply, err);
  });

  return app;
}
