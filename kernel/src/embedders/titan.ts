import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Embedder } from '../precedents.js';

// Bedrock Titan Text Embeddings V2, same 1024-dim output the precedents
// table's VECTOR(1024) column and stubEmbed already assume, so no schema or
// call-site change is needed to swap this in (v1-spec 9.2 / precedents.ts).
const MODEL_ID = 'amazon.titan-embed-text-v2:0';

// ponytail: one client for the process, region from AWS_REGION/config chain
// (Lambda sets this automatically); no retry/backoff tuning beyond the SDK
// default, revisit if Bedrock throttling shows up under real load.
const client = new BedrockRuntimeClient({});

export const titanEmbed: Embedder = async (text: string): Promise<number[]> => {
  const res = await client.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text }),
    }),
  );
  const payload = JSON.parse(Buffer.from(res.body ?? new Uint8Array()).toString('utf8')) as {
    embedding: number[];
  };
  return payload.embedding;
};
