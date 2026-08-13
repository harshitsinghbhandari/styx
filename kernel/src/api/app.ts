import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/pool.js';
import { authenticate } from './auth.js';
import { sendError } from './errors.js';
import { registerRoutes } from './routes.js';
import { registerEventsRoute } from './sse.js';

const UNAUTHENTICATED_PATHS = new Set(['/v1/health']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Local/monorepo default resolves kernel/dist/api/app.js -> repo-root/ui/dist.
// The Docker image lays files out differently and sets UI_DIST_PATH explicitly
// (see Dockerfile). Static serving is skipped entirely when the directory is
// absent, so `npm run test --workspace=kernel` never needs a UI build first.
const UI_DIST = process.env.UI_DIST_PATH ?? path.resolve(__dirname, '../../../ui/dist');

export function buildApp(pool: Pool = defaultPool): FastifyInstance {
  const app = Fastify({ logger: false });

  // ponytail: PUBLIC_READ=true opens every GET (including the SSE stream) to
  // anonymous callers so the hackathon demo URL needs no shared bearer key in
  // the judges' hands; every mutation (POST/PATCH/DELETE) still authenticates.
  // The ceiling is that this is all-or-nothing across every GET route with no
  // per-resource scoping -- a real deployment wants scoped, expiring viewer
  // tokens instead of a single build-time flag. Read per buildApp() call
  // (not module-level) so tests can exercise both modes in one process.
  const publicRead = process.env.PUBLIC_READ === 'true';

  app.get('/v1/health', async () => ({ ok: true }));

  app.addHook('onRequest', async (request) => {
    const reqPath = request.url.split('?')[0];
    if (UNAUTHENTICATED_PATHS.has(reqPath)) return;
    // Same-origin SPA assets and the index.html fallback below are not API
    // routes and carry no auth requirement of their own.
    if (!reqPath.startsWith('/v1')) return;
    if (publicRead && request.method === 'GET') return;
    request.agent = await authenticate(pool, request);
  });

  registerRoutes(app, pool);
  registerEventsRoute(app, pool);

  if (existsSync(UI_DIST)) {
    app.register(fastifyStatic, { root: UI_DIST });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/v1')) {
        reply.code(404).send({ type: 'NOT_FOUND', message: 'route not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((err, _request, reply) => {
    sendError(reply, err);
  });

  return app;
}
