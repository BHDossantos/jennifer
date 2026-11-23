/** Manual simulator only. No routes, schedulers, models, connectors, or durable writes. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanyRepo } from '../company/repo.js';

export const PROFILES = {
  coordinator: { output: 'decision brief', reviewCap: 20 },
  research: { output: 'evidence brief', reviewCap: 20 },
  qualification: { output: 'account brief', reviewCap: 16 },
  communications: { output: 'private communication outline', reviewCap: 8 },
  proposals: { output: 'private proposal outline', reviewCap: 2 },
  operations: { output: 'reconciliation note', reviewCap: 20 },
} as const;
export type Profile = keyof typeof PROFILES;
const profile = z.enum(['coordinator', 'research', 'qualification', 'communications', 'proposals', 'operations']);
const fixtureId = z.string().regex(/^fixture:[a-z0-9][a-z0-9-]{0,63}$/);
const stamp = z.iso.datetime({ offset: true });
const pos = z.number().int().positive();
const tool = z.enum(['read-approved-fixture', 'prepare-private-draft', 'validate-envelope']);
const Task = z.strictObject({
  taskId: fixtureId, caseId: fixtureId, tenant: z.literal('technology'),
  profile, recordId: fixtureId, recordVersion: pos, artifactVersion: pos,
  humanOwner: fixtureId, decisionOwner: fixtureId,
  goal: z.enum(['assess', 'prepare', 'reconcile']),
  dueAt: stamp, output: z.literal('private-review-packet'),
  acceptance: z.literal('verified-current-evidence'), escalation: z.literal('human-owner'),
  allowedTools: z.array(tool).length(3).refine(values => new Set(values).size === 3),
  maxReads: z.number().int().min(2).max(5),
  sources: z.array(z.strictObject({ id: fixtureId, version: pos, observedAt: stamp })).min(1).max(4),
  externalActionRequested: z.literal(false),
});
export type PilotTask = z.infer<typeof Task>;

const FixtureRecord = z.strictObject({
  caseId: fixtureId,
  accountKey: fixtureId,
  category: z.enum(['buyer-signal', 'supplier-registration', 'unknown']),
  recipient: z.string().regex(/^[a-z0-9.-]+@example\.test$/),
  hold: z.enum(['none', 'opted-out', 'hard-failure', 'active-negotiation', 'new-reply', 'unknown-prior-outcome']),
});
const Evidence = z.enum(['observed', 'inferred', 'proposed', 'unverified']);
const POLICY = 'simulator-private-v1';
const DAY = 86_400_000;
const MAX_WEEK = 20;

export type PilotScope = {
  /** Trusted fixture setup; never constructed from an individual task. */
  cases: Record<string, { recordId: string; sources: Record<string, { version: number; observedAt: string; documentVersionId: string; contentHash: string; status: z.infer<typeof Evidence> }> }>;
  owner: string;
  reviewer: string;
  now: () => Date;
};
type ReadRepo = Pick<CompanyRepo, 'record' | 'source'>;
type Packet = {
  task: PilotTask;
  kind: 'decision brief' | 'evidence brief' | 'account brief' | 'private communication outline' | 'private proposal outline' | 'reconciliation note';
  status: 'registration-only' | 'observed-buyer-signal' | 'unqualified';
  accountKey: string;
  recipient: string;
  ledger: { recordId: string; expectedVersion: number; disposition: 'reference-only' };
  upstream?: { taskId: string; contentHash: string };
  externalAction: false;
  policy: typeof POLICY;
};
type Approval = { actor: string; taskId: string; tenant: 'technology'; recipient: string;
  artifactVersion: number; contentHash: string; expiresAt: string; policy: typeof POLICY; action: 'review-private-draft' };
type Outcome = { state: 'needs-review'; packet: Packet; hash: string } | { state: 'blocked'; reason: string };
const block = (reason: string): Outcome => ({ state: 'blocked', reason });
const hash = (packet: Packet) => createHash('sha256').update(JSON.stringify(packet)).digest('hex');

function utcWeek(now: Date) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

/** Fixture-scoped rehearsal; ephemeral review queue, never an opportunity ledger. */
export class PrivatePreparationPilot {
  private pending = new Map<string, { packet: Packet; hash: string; key: string; submittedAt: Date }>();
  private accepted = new Set<string>();
  private handoffs = new Map<string, { taskId: string; contentHash: string }>();
  private handoffKey(task: PilotTask, role = task.profile) {
    return JSON.stringify([task.caseId, task.recordId, task.recordVersion, role]);
  }
  private upstream(task: PilotTask) {
    const predecessor = task.profile === 'qualification' ? 'research'
      : task.profile === 'communications' || task.profile === 'proposals' ? 'qualification' : null;
    return predecessor ? this.handoffs.get(this.handoffKey(task, predecessor)) : undefined;
  }
  private inFlight = false;
  private week = '';
  private drafted = 0;
  private commDay = '';
  private commDrafted = 0;

  constructor(private readonly scope: PilotScope, private readonly repo: ReadRepo) {}

  private async read(task: PilotTask, now: Date) {
    const rule = Object.hasOwn(this.scope.cases, task.caseId) ? this.scope.cases[task.caseId] : undefined;
    if (!rule || rule.recordId !== task.recordId || task.humanOwner !== this.scope.owner || task.decisionOwner !== this.scope.reviewer) return { reason: 'scope' } as const;
    if (Date.parse(task.dueAt) <= +now) return { reason: 'deadline' } as const;
    if (1 + task.sources.length > task.maxReads) return { reason: 'read-budget' } as const;
    const refs = new Set<string>();
    for (const ref of task.sources) {
      if (refs.has(ref.id)) return { reason: 'duplicate-evidence' } as const;
      refs.add(ref.id);
      const expected = Object.hasOwn(rule.sources, ref.id) ? rule.sources[ref.id] : undefined;
      if (!expected || expected.version !== ref.version || expected.observedAt !== ref.observedAt) return { reason: 'scope-or-stale-evidence' } as const;
      const age = +now - Date.parse(ref.observedAt);
      if (age < 0 || age > 7 * DAY || expected.status !== 'observed') return { reason: 'unverified-or-stale-evidence' } as const;
    }
    const record = await this.repo.record('technology', task.recordId);
    if (!record || record.companyId !== 'technology' || record.kind !== 'account' || record.version !== task.recordVersion) return { reason: 'missing-or-revised-record' } as const;
    const fields = FixtureRecord.safeParse(record.fields);
    if (!fields.success || fields.data.caseId !== task.caseId) return { reason: 'invalid-fixture-record' } as const;
    if (!record.provenance.category?.sourceId || !refs.has(record.provenance.category.sourceId)) return { reason: 'unverified-record-provenance' } as const;
    for (const ref of task.sources) {
      const source = await this.repo.source('technology', ref.id);
      const expected = rule.sources[ref.id]!;
      if (!source || source.documentVersionId !== expected.documentVersionId || source.contentHash !== expected.contentHash || source.companyId !== 'technology' || source.category !== 'fixture' || source.status !== 'approved'
        || (source.expiresAt && Date.parse(source.expiresAt) <= +now)) return { reason: 'evidence-not-approved' } as const;
    }
    return { fields: fields.data } as const;
  }

  async prepare(raw: unknown): Promise<Outcome> {
    const parsed = Task.safeParse(raw);
    if (!parsed.success) return block('invalid-private-task');
    if (this.inFlight) return block('rehearsal-busy');
    const task = parsed.data;
    const now = this.scope.now();
    const week = utcWeek(now);
    if (week !== this.week) { this.week = week; this.drafted = 0; }
    const day = now.toISOString().slice(0, 10);
    if (day !== this.commDay) { this.commDay = day; this.commDrafted = 0; }
    if (this.drafted >= MAX_WEEK || (task.profile === 'communications' && this.commDrafted >= 4)) return block('draft-budget');
    const olderThanOneWorkingDay = (since: Date) => {
      const next = new Date(since);
      do { next.setUTCDate(next.getUTCDate() + 1); } while ([0, 6].includes(next.getUTCDay()));
      return +now > +next;
    };
    if (task.profile === 'communications' && [...this.pending.values()].some(entry =>
      entry.packet.task.profile === 'communications' && olderThanOneWorkingDay(entry.submittedAt))) return block('review-backlog');
    if (this.pending.has(task.taskId)) return block('duplicate-task');
    if ([...this.pending.values()].filter(entry => entry.packet.task.profile === task.profile).length >= PROFILES[task.profile].reviewCap) return block('review-cap');
    this.inFlight = true;
    try {
      const data = await this.read(task, now);
      if (!data.fields) return block(data.reason);
      const fields = data.fields;
      const transactionalDraft = task.profile === 'communications' || task.profile === 'proposals';
      if (transactionalDraft && fields.hold !== 'none') return block('contact-hold');
      if (transactionalDraft && fields.category !== 'buyer-signal') return block('no-observed-buyer-signal');
      const upstream = this.upstream(task);
      if ((transactionalDraft || task.profile === 'qualification') && !upstream) return block('upstream-review-required');
      const key = JSON.stringify([task.profile, fields.accountKey, fields.recipient]);
      if (this.accepted.has(key) || [...this.pending.values()].some(entry => entry.key === key)) return block('duplicate-handoff');
      const packet: Packet = {
        task, kind: PROFILES[task.profile].output,
        status: fields.category === 'supplier-registration' ? 'registration-only' :
          fields.category === 'buyer-signal' ? 'observed-buyer-signal' : 'unqualified',
        accountKey: fields.accountKey, recipient: fields.recipient,
        ledger: { recordId: task.recordId, expectedVersion: task.recordVersion, disposition: 'reference-only' },
        ...(upstream ? { upstream: { ...upstream } } : {}),
        externalAction: false, policy: POLICY,
      };
      const digest = hash(packet);
      this.pending.set(task.taskId, { packet, hash: digest, key, submittedAt: new Date(now) });
      this.drafted++;
      if (task.profile === 'communications') this.commDrafted++;
      return { state: 'needs-review', packet: structuredClone(packet), hash: digest };
    } catch {
      return block('fixture-read-failed'); // do not log potentially sensitive input or provider errors
    } finally {
      this.inFlight = false;
    }
  }

  discard(taskId: string, actor: string): boolean {
    return !this.inFlight && actor === this.scope.reviewer && this.pending.delete(taskId);
  }

  async review(packet: Packet, approval: Approval): Promise<{ state: 'reviewed-private' | 'blocked'; reason?: string; externalAction: false }> {
    const deny = (reason: string) => ({ state: 'blocked' as const, reason, externalAction: false as const });
    if (this.inFlight) return deny('rehearsal-busy');
    const entry = this.pending.get(approval.taskId);
    const now = this.scope.now();
    if (!entry || approval.actor !== this.scope.reviewer || approval.tenant !== 'technology'
      || approval.action !== 'review-private-draft' || approval.policy !== POLICY
      || approval.recipient !== entry.packet.recipient || approval.artifactVersion !== entry.packet.task.artifactVersion
      || !stamp.safeParse(approval.expiresAt).success || Date.parse(approval.expiresAt) <= +now
      || approval.contentHash !== entry.hash || hash(packet) !== entry.hash) return deny('approval-mismatch');
    this.inFlight = true;
    try {
      const current = await this.read(entry.packet.task, now);
      if (!current.fields || current.fields.accountKey !== entry.packet.accountKey || current.fields.recipient !== entry.packet.recipient
        || ((entry.packet.task.profile === 'communications' || entry.packet.task.profile === 'proposals')
          && (current.fields.hold !== 'none' || current.fields.category !== 'buyer-signal'))) return deny('approval-evidence-changed');
      this.pending.delete(approval.taskId);
      this.accepted.add(entry.key);
      this.handoffs.set(this.handoffKey(entry.packet.task), { taskId: entry.packet.task.taskId, contentHash: entry.hash });
      return { state: 'reviewed-private', externalAction: false };
    } catch {
      return deny('fixture-read-failed');
    } finally {
      this.inFlight = false;
    }
  }
}
