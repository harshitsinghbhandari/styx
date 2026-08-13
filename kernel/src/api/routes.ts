import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createPromise, reserveResource, linkDependency, getCommitment, getObligations, getHistory } from '../kernel.js';
import { transitionCommitment } from '../transition.js';
import { precedentStore } from '../precedents.js';
import { buildGraph } from './graph.js';
import { NotFound, BadRequest } from './errors.js';

const HTTP_ACTIONS = new Set(['activate', 'fulfill', 'break', 'revoke']);

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new BadRequest('Idempotency-Key header is required');
  }
  return key;
}

/**
 * True if a result already existed for this key before the call below ran.
 * Racing an identical concurrent request can make this miss the marker
 * (both readers see "not yet recorded"); it only ever affects the
 * `replayed` flag in the response, never which result is returned.
 */
async function alreadyRecorded(pool: Pool, idempotencyKey: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM operation_results WHERE idempotency_key = $1', [idempotencyKey]);
  return rows.length > 0;
}

export function registerRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/v1/commitments', async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = request.body as { debtorAgentId: string; creditorAgentId: string; terms: Record<string, unknown> };
    const replayed = await alreadyRecorded(pool, idempotencyKey);
    const result = await createPromise(
      {
        debtorAgentId: body.debtorAgentId,
        creditorAgentId: body.creditorAgentId,
        terms: body.terms as { deliver: string; deadline: string },
        idempotencyKey,
      },
      pool,
    );
    reply.code(201).send({ ...result, replayed });
  });

  app.post('/v1/reservations', async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request);
    const body = request.body as { debtorAgentId: string; creditorAgentId: string; terms: Record<string, unknown> };
    const replayed = await alreadyRecorded(pool, idempotencyKey);
    const result = await reserveResource(
      {
        debtorAgentId: body.debtorAgentId,
        creditorAgentId: body.creditorAgentId,
        terms: body.terms as { resource: string; quantity: number },
        idempotencyKey,
      },
      pool,
    );
    reply.code(201).send({ ...result, replayed });
  });

  app.post('/v1/commitments/:id/transitions', async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      action: string;
      expectedVersion: number;
      reason?: string;
      evidence?: Record<string, unknown>;
    };
    if (!HTTP_ACTIONS.has(body.action)) {
      throw new BadRequest(`action must be one of ${[...HTTP_ACTIONS].join(', ')}`);
    }
    const replayed = await alreadyRecorded(pool, idempotencyKey);
    const result = await transitionCommitment(
      {
        commitmentId: id,
        action: body.action as 'activate' | 'fulfill' | 'break' | 'revoke',
        actorId: request.agent!.id,
        expectedVersion: body.expectedVersion,
        idempotencyKey,
        reason: body.reason,
        evidence: body.evidence,
      },
      pool,
    );
    reply.code(200).send({ ...result, replayed });
  });

  app.post('/v1/commitments/:id/dependencies', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { dependsOnId: string; dependencyType?: string };
    await linkDependency(
      {
        commitmentId: id,
        dependsOnId: body.dependsOnId,
        dependencyType: body.dependencyType,
        actorAgentId: request.agent!.id,
      },
      pool,
    );
    reply.code(201).send({ commitmentId: id, dependsOnId: body.dependsOnId, dependencyType: body.dependencyType ?? 'requires' });
  });

  app.get('/v1/commitments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const commitment = await getCommitment(id, pool);
    if (!commitment) throw new NotFound(`commitment ${id}`);
    reply.send(commitment);
  });

  app.get('/v1/agents/:id/obligations', async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send(await getObligations(id, pool));
  });

  app.get('/v1/commitments/:id/graph', async (request, reply) => {
    const { id } = request.params as { id: string };
    const commitment = await getCommitment(id, pool);
    if (!commitment) throw new NotFound(`commitment ${id}`);
    reply.send(await buildGraph(pool, id));
  });

  app.get('/v1/commitments/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send(await getHistory(id, pool));
  });

  app.post('/v1/precedents/search', async (request, reply) => {
    const body = request.body as { situation: string; limit?: number };
    if (typeof body.situation !== 'string' || body.situation.length === 0) {
      throw new BadRequest('situation is required');
    }
    reply.send(await precedentStore.findSimilar(body.situation, body.limit ?? 5));
  });
}
