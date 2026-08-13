// Breaker: not a fleet role with a wake loop, just the one action scenes
// need to trigger a cascade (v3-plan scene 2/3: "BREAK P-101"). A plain
// utility function rather than a RolePolicy -- ponytail: no wake/session
// machinery for something that is one kernel transition call.
import type { StyxClient } from '../client.js';

export async function breakCommitment(client: StyxClient, commitmentId: string, reason: string): Promise<void> {
  const commitment = await client.getCommitment(commitmentId);
  await client.transition({
    commitmentId,
    action: 'break',
    expectedVersion: commitment.version,
    mission: commitmentId,
    reason,
  });
}
