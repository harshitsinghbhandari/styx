export class VersionConflict extends Error {
  constructor(expected: number, actual: number) {
    super(`expected version ${expected}, found ${actual}`);
    this.name = 'VersionConflict';
  }
}

export class Forbidden extends Error {
  constructor(action: string, actorId: string | null) {
    super(`actor ${actorId ?? 'kernel'} may not ${action}`);
    this.name = 'Forbidden';
  }
}

export class InvalidTransition extends Error {
  constructor(status: string, action: string) {
    super(`no legal edge from ${status} via ${action}`);
    this.name = 'InvalidTransition';
  }
}

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

export interface ResourceConflictDetails {
  resource: string;
  requested: number;
  available: number;
  conflicting_commitment_ids: string[];
}

export class ResourceConflict extends Error {
  resource: string;
  requested: number;
  available: number;
  conflicting_commitment_ids: string[];

  constructor(details: ResourceConflictDetails) {
    super(`requested ${details.requested} of ${details.resource}, ${details.available} available`);
    this.name = 'ResourceConflict';
    this.resource = details.resource;
    this.requested = details.requested;
    this.available = details.available;
    this.conflicting_commitment_ids = details.conflicting_commitment_ids;
  }
}
