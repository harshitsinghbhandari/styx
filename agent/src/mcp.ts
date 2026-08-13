// Optional read path: the CockroachDB Cloud Managed MCP Server, read-only,
// for the introspection step (an agent checking its own obligations after
// a crash/restart, v1-spec's MCP tool surface). Never required: every
// caller here falls back to the plain Styx API client on any failure or
// when unconfigured, and scenes run entirely against local CockroachDB
// with no MCP endpoint set, so they never touch this path.
import type { StyxClient, CommitmentRow } from './client.js';

export interface McpConfig {
  endpoint: string;
  credential: string;
}

/** Reads STYX_MCP_ENDPOINT / STYX_MCP_CREDENTIAL; undefined (not configured) unless both are set. */
export function loadMcpConfig(): McpConfig | undefined {
  const endpoint = process.env.STYX_MCP_ENDPOINT;
  const credential = process.env.STYX_MCP_CREDENTIAL;
  if (!endpoint || !credential) return undefined;
  return { endpoint, credential };
}

export interface Introspector {
  getObligations(agentId: string): Promise<CommitmentRow[]>;
}

/**
 * ponytail: the MCP branch below is structured but not wired to a real
 * transport. This dev environment cannot reach CockroachDB Cloud SQL (the
 * campus network blocks the 26257 proxy) so there is nothing to test the
 * real call against; queryMcp() throws unconditionally, which routes every
 * caller straight to the API fallback. Wiring it for real means adding
 * `@modelcontextprotocol/sdk`, opening a StreamableHTTPClientTransport at
 * config.endpoint with config.credential as a bearer token, and calling
 * whatever read-only SQL tool the Managed MCP Server exposes with a
 * parameterized SELECT against `commitments WHERE debtor_agent_id = $1`.
 */
export function createIntrospector(client: StyxClient): Introspector {
  const config = loadMcpConfig();
  if (!config) {
    return { getObligations: (agentId) => client.getObligations(agentId) };
  }
  return {
    async getObligations(agentId) {
      try {
        return await queryMcp(config, agentId);
      } catch {
        return client.getObligations(agentId);
      }
    },
  };
}

async function queryMcp(_config: McpConfig, _agentId: string): Promise<CommitmentRow[]> {
  throw new Error('MCP client not wired: no reachable CockroachDB Cloud cluster in this environment');
}
