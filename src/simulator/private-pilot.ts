/** Run with: npm run build && node dist/src/simulator/private-pilot.js */
import { createRehearsal } from '../pilot/fixture.js';
import { PROFILES, type Profile } from '../pilot/private-preparation.js';

const rehearsal = await createRehearsal();
const sample = await rehearsal.addCase('sample');
const profiles = [];
for (const profile of Object.keys(PROFILES) as Profile[]) {
  const draft = await rehearsal.pilot.prepare(sample.task(profile, profile));
  if (draft.state !== 'needs-review') throw new Error(`Fixture unexpectedly blocked: ${draft.reason}`);
  const reviewed = await rehearsal.pilot.review(draft.packet, {
    actor: rehearsal.reviewer, taskId: draft.packet.task.taskId, tenant: 'technology', recipient: draft.packet.recipient,
    artifactVersion: draft.packet.task.artifactVersion, contentHash: draft.hash, expiresAt: '2026-06-11T10:00:00Z',
    policy: draft.packet.policy, action: 'review-private-draft',
  });
  if (reviewed.state !== 'reviewed-private') throw new Error(`Fixture review blocked: ${reviewed.reason}`);
  profiles.push({ profile, artifact: draft.packet.kind, state: reviewed.state, ledger: draft.packet.ledger.disposition });
}
console.log(JSON.stringify({ mode: 'manual-synthetic', profiles, externalActions: 0, persistentWrites: 0 }, null, 2));
