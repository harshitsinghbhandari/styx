import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { HandlerRequest, HandlerResult } from './handler.js';

// Lambda Function URL event shape (a slice of APIGatewayProxyEventV2): the
// only fields the changefeed webhook sink and our shared-secret check need.
export interface LambdaFunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface ColdStart {
  handler: (event: HandlerRequest) => Promise<HandlerResult>;
}

async function getParam(client: SSMClient, name: string): Promise<string> {
  const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} returned no value`);
  return value;
}

// ponytail: module-level promise as the whole cold-start cache; a Lambda
// execution environment cold-starts once and reuses this on every warm
// invocation, so there is no need for a real init framework here.
let coldStart: Promise<ColdStart> | null = null;

async function init(): Promise<ColdStart> {
  const ssm = new SSMClient({});
  const [databaseUrl, webhookSecret] = await Promise.all([
    getParam(ssm, '/styx/database-url'),
    getParam(ssm, '/styx/webhook-secret'),
  ]);
  // db.ts and handler.ts read process.env.DATABASE_URL / WEBHOOK_SHARED_SECRET
  // at module-load time (the pool is a top-level const), so these must land
  // in process.env before handler.js is ever imported, not just before this
  // function runs.
  process.env.DATABASE_URL = databaseUrl;
  process.env.WEBHOOK_SHARED_SECRET = webhookSecret;
  const mod = await import('./handler.js');
  return { handler: mod.handler };
}

export async function lambdaHandler(event: LambdaFunctionUrlEvent): Promise<HandlerResult> {
  if (!coldStart) coldStart = init();
  // A failed cold start (e.g. transient SSM error) must not poison every
  // later invocation on this warm execution environment.
  const { handler } = await coldStart.catch((err) => {
    coldStart = null;
    throw err;
  });

  const body =
    event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');

  return handler({ headers: (event.headers ?? {}) as HandlerRequest['headers'], body });
}
