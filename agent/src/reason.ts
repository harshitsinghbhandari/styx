// The one pluggable spot in this whole package where an LLM is allowed to
// appear: generating the human-readable text of a repair proposal (what
// the replacement commitment's terms.deliver says, and the reason attached
// to the repair transition). It never decides WHETHER to repair, WHICH
// commitment to replace, or WHEN to link/repair -- repairPolicy
// (policies/repair.ts) makes every one of those decisions deterministically
// before this hook is ever called. If Bedrock is reachable at runtime, use
// Claude on Bedrock over HTTPS for nicer prose; otherwise (or on any
// failure) fall back to a canned deterministic string. Scenes must and do
// pass with zero AWS configuration.
import type { Precedent } from './client.js';

export interface ReasonInput {
  situation: string;
  precedents: Precedent[];
}

export type ReasonFn = (input: ReasonInput) => Promise<string>;

export const cannedReason: ReasonFn = async (input) => {
  if (input.precedents.length > 0) {
    return `Replacement proposed for: ${input.situation}. Reusing the resolution pattern from a prior precedent: ${input.precedents[0].resolution}.`;
  }
  return `Replacement proposed for: ${input.situation}. No matching precedent found; creating a fresh replacement.`;
};

/**
 * ponytail: single non-streaming Converse call, no retry/backoff beyond
 * what fetch gives for free. This is cosmetic text on a demo path, not a
 * correctness-bearing call; add retry if a scene ever needs it to survive
 * a flaky Bedrock endpoint.
 *
 * The import specifier is read from a variable, not a string literal, on
 * purpose: '@aws-sdk/client-bedrock-runtime' is not a dependency of this
 * package (scenes must pass with zero AWS, and pulling in the SDK just for
 * an optional hook nothing in the scene-critical path calls is not worth
 * it -- ponytail). TypeScript cannot statically resolve a non-literal
 * dynamic import, so this compiles clean without the types or the package
 * installed; at runtime it either finds the SDK (if the caller happens to
 * have it installed elsewhere in the workspace) or throws, and the caller
 * below (defaultReason) already treats any throw here as "fall back to
 * canned text". If Bedrock reasoning becomes load-bearing rather than
 * cosmetic, add the real dependency and switch this to a static import.
 */
async function bedrockReason(input: ReasonInput, modelId: string): Promise<string> {
  const sdkName = '@aws-sdk/client-bedrock-runtime';
  const { BedrockRuntimeClient, ConverseCommand } = await import(sdkName);
  const client = new BedrockRuntimeClient({});
  const precedentNote =
    input.precedents.length > 0 ? `A similar precedent exists: ${input.precedents[0].resolution}.` : 'No similar precedent was found.';
  const result = await client.send(
    new ConverseCommand({
      modelId,
      messages: [
        {
          role: 'user',
          content: [
            {
              text:
                `A commitment in a task-dependency graph broke: ${input.situation}. ${precedentNote} ` +
                'Write one short sentence proposing a replacement commitment to unblock its dependents.',
            },
          ],
        },
      ],
    }),
  );
  const text = result.output?.message?.content?.[0]?.text;
  if (!text) throw new Error('Bedrock returned no text content');
  return text.trim();
}

/**
 * Reachability is decided once, at construction, from env: STYX_BEDROCK_MODEL_ID
 * plus any AWS credential source the default SDK provider chain would find
 * (access key pair, profile, or a bearer token). No SDK call is made just
 * to probe reachability; the first real call either succeeds or falls back.
 */
export function defaultReason(): ReasonFn {
  const modelId = process.env.STYX_BEDROCK_MODEL_ID;
  const hasCreds = Boolean(
    modelId && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK),
  );
  if (!hasCreds) return cannedReason;

  return async (input) => {
    try {
      return await bedrockReason(input, modelId!);
    } catch {
      // Bedrock unreachable, package not installed, model access denied,
      // whatever -- the scene-critical path never blocks on this.
      return cannedReason(input);
    }
  };
}
