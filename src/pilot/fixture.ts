import type { KnowledgeSource, CrmRecord } from '../company/model.js';
import { MemoryCompanyRepo } from '../company/repo.js';
import { PrivatePreparationPilot, type PilotScope, type PilotTask, type Profile } from './private-preparation.js';

export async function createRehearsal() {
  let now = new Date('2026-06-10T10:00:00Z');
  const repo = new MemoryCompanyRepo();
  const cases: PilotScope['cases'] = {};
  const owner = 'fixture:operator';
  const reviewer = 'fixture:reviewer';
  const observedAt = '2026-06-09T10:00:00Z';
  const addCase = async (label: string, category = 'buyer-signal', hold = 'none', account = label) => {
    const caseId = `fixture:case-${label}`;
    const recordId = `fixture:record-${label}`;
    const sourceId = `fixture:source-${label}`;
    const record: CrmRecord = { id: recordId, companyId: 'technology', kind: 'account', version: 1, updatedAt: observedAt,
      provenance: { category: { sourceId } }, fields: { caseId, accountKey: `fixture:account-${account}`, recipient: `${account}@example.test`, category, hold } };
    const source: KnowledgeSource = { id: sourceId, companyId: 'technology', title: 'Synthetic evidence metadata',
      classification: 'internal', category: 'fixture', status: 'approved', documentVersionId: 'fixture:v1',
      contentHash: 'synthetic-fixture-fingerprint', ownerId: owner, origin: { kind: 'text' }, retrievedAt: observedAt };
    await repo.saveRecord(record);
    await repo.saveSource(source);
    cases[caseId] = { recordId, sources: { [sourceId]: { version: 1, documentVersionId: source.documentVersionId,
      contentHash: source.contentHash, observedAt, status: 'observed' } } };
    return { record, source, task: (profile: Profile, suffix = 'draft'): PilotTask => ({
      taskId: `fixture:task-${label}-${suffix}`, caseId, tenant: 'technology', profile, recordId, recordVersion: record.version,
      artifactVersion: 1, humanOwner: owner, decisionOwner: reviewer,
      goal: 'prepare', dueAt: '2026-06-29T10:00:00Z', output: 'private-review-packet',
      acceptance: 'verified-current-evidence', escalation: 'human-owner',
      allowedTools: ['read-approved-fixture', 'prepare-private-draft', 'validate-envelope'], maxReads: 2,
      sources: [{ id: sourceId, version: 1, observedAt }], externalActionRequested: false,
    }) };
  };
  const pilot = new PrivatePreparationPilot({ cases, owner, reviewer, now: () => now }, repo);
  return { repo, pilot, addCase, reviewer, setNow: (iso: string) => { now = new Date(iso); } };
}
