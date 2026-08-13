import type { FastifyReply } from 'fastify';
import { VersionConflict, Forbidden, InvalidTransition, InvariantViolation, ResourceConflict } from '../errors.js';

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFound';
  }
}

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export class Unauthorized extends Error {
  constructor(message = 'missing or invalid API key') {
    super(message);
    this.name = 'Unauthorized';
  }
}

/** Maps kernel and API-layer typed errors onto HTTP per v1-spec and product-spec section 43. */
export function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof ResourceConflict) {
    reply.code(409).send({
      type: 'RESOURCE_CONFLICT',
      resource: err.resource,
      requested: { quantity: err.requested },
      available: err.available,
      conflicting_commitments: err.conflicting_commitment_ids,
      retryable: false,
      alternatives: { search_precedents: true },
    });
    return;
  }
  if (err instanceof VersionConflict) {
    reply.code(409).send({ type: 'VERSION_CONFLICT', message: err.message });
    return;
  }
  if (err instanceof InvalidTransition) {
    reply.code(422).send({ type: 'INVALID_TRANSITION', message: err.message });
    return;
  }
  if (err instanceof Forbidden) {
    reply.code(403).send({ type: 'FORBIDDEN', message: err.message });
    return;
  }
  if (err instanceof InvariantViolation) {
    reply.code(422).send({ type: 'INVARIANT_VIOLATION', message: err.message });
    return;
  }
  if (err instanceof NotFound) {
    reply.code(404).send({ type: 'NOT_FOUND', message: err.message });
    return;
  }
  if (err instanceof Unauthorized) {
    reply.code(401).send({ type: 'UNAUTHORIZED', message: err.message });
    return;
  }
  if (err instanceof BadRequest) {
    reply.code(400).send({ type: 'BAD_REQUEST', message: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  reply.code(500).send({ type: 'INTERNAL_ERROR', message: 'unexpected error' });
}
