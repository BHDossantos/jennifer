import { type Space } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import { redactSecrets } from '../security/redaction.js';

/**
 * Learning (spec §13): memory updates, workflow/prompt improvements, and
 * optional supervised training — never autonomous retraining. Feedback is
 * captured after real tasks; repeated corrections become proposed rules that
 * need approval when they touch authority, spending or contact behavior.
 */
export const FEEDBACK_KINDS = [
  'accepted_unchanged',
  'edited',
  'rejected',
  'wrong_fact',
  'wrong_recipient',
  'poor_tone',
  'late_response',
  'incomplete_action',
  'escalation_needed',
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface Feedback {
  id: string;
  ownerId: string;
  actionId?: string;
  kind: FeedbackKind;
  space: Space;
  contactId?: string;
  originalCandidate: string;
  approvedFinal?: string;
  note?: string;
  sourceRefs: string[];
  policyVersion?: number;
  modelVersion: string;
  promptVersion: string;
  givenBy: string;
  at: Date;
  trainingConsent: boolean;
}

export interface ProposedRule {
  id: string;
  scope: { space: Space; contactId?: string };
  rule: string;
  examples: string[];
  impact: 'style' | 'authority' | 'spending' | 'contact_behavior';
  status: 'proposed' | 'auto_applied' | 'approved' | 'rejected';
}

export class FeedbackStore {
  private items: Feedback[] = [];
  private rules = new Map<string, ProposedRule>();

  private changeListeners: Array<() => void> = [];

  constructor(private clock: Clock) {}

  onChange(fn: () => void): void {
    this.changeListeners.push(fn);
  }

  snapshot(): { items: Feedback[]; rules: ProposedRule[] } {
    return { items: this.items.slice(-2000), rules: [...this.rules.values()] };
  }

  restore(s: { items: Feedback[]; rules: ProposedRule[] }): void {
    this.items = s.items.map((f) => ({ ...f, at: new Date(f.at) }));
    this.rules = new Map(s.rules.map((r) => [r.id, r]));
  }

  /** Bruno approves or rejects a proposed rule (authority/contact rules never auto-apply). */
  decideRule(id: string, status: 'approved' | 'rejected'): ProposedRule {
    const r = this.rules.get(id);
    if (!r) throw new Error(`No rule ${id}`);
    r.status = status;
    this.changeListeners.forEach((l) => l());
    return r;
  }

  purgeBefore(cutoff: Date): number {
    const before = this.items.length;
    this.items = this.items.filter((f) => f.at.getTime() >= cutoff.getTime());
    if (this.items.length !== before) this.changeListeners.forEach((l) => l());
    return before - this.items.length;
  }

  /** Replace the nightly-learned style rules for one scope (Bruno's dropped rules stay dropped). */
  replaceLearnedStyle(scope: ProposedRule['scope'], rules: string[], examples: string[]): number {
    const prefix = `learned|${scope.space}|${scope.contactId ?? ''}|`;
    const dropped = new Set([...this.rules.values()].filter((r) => r.id.startsWith(prefix) && r.status === 'rejected').map((r) => r.rule));
    for (const [id, r] of this.rules) if (id.startsWith(prefix) && r.status !== 'rejected') this.rules.delete(id);
    let n = 0;
    rules.forEach((rule, i) => {
      if (dropped.has(rule)) return;
      this.rules.set(`${prefix}${i}`, { id: `${prefix}${i}`, scope, rule, examples, impact: 'style', status: 'auto_applied' });
      n++;
    });
    this.changeListeners.forEach((l) => l());
    return n;
  }

  allRules(): ProposedRule[] {
    return [...this.rules.values()];
  }

  record(input: Omit<Feedback, 'id' | 'at'>): Feedback {
    if (input.givenBy !== input.ownerId) throw new Error('Only the owner can provide feedback that shapes behavior');
    const fb: Feedback = {
      ...input,
      originalCandidate: redactSecrets(input.originalCandidate),
      approvedFinal: input.approvedFinal ? redactSecrets(input.approvedFinal) : undefined,
      id: newId('fb'),
      at: this.clock.now(),
    };
    this.items.push(fb);
    this.changeListeners.forEach((l) => l());
    return fb;
  }

  list(): Feedback[] {
    return [...this.items];
  }

  /**
   * Summarize repeated corrections of one kind in one scope into a proposed
   * rule. Low-impact style rules auto-apply; anything else awaits approval.
   */
  proposeRules(minOccurrences = 3): ProposedRule[] {
    const groups = new Map<string, Feedback[]>();
    for (const f of this.items) {
      if (f.kind === 'accepted_unchanged') continue;
      const k = `${f.kind}|${f.space}|${f.contactId ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    const out: ProposedRule[] = [];
    for (const [k, fs] of groups) {
      if (fs.length < minOccurrences || this.rules.has(k)) continue;
      const first = fs[0]!;
      const impact: ProposedRule['impact'] = first.kind === 'poor_tone' || first.kind === 'edited' ? 'style' : first.kind === 'wrong_recipient' ? 'contact_behavior' : 'style';
      const rule: ProposedRule = {
        id: k,
        scope: { space: first.space, contactId: first.contactId },
        rule: `Repeated "${first.kind}" corrections: ${fs.map((f) => f.note).filter(Boolean).slice(0, 3).join(' | ') || 'see examples'}`,
        examples: fs.slice(0, 5).map((f) => f.approvedFinal ?? f.originalCandidate),
        impact,
        status: impact === 'style' ? 'auto_applied' : 'proposed',
      };
      this.rules.set(k, rule);
      out.push(rule);
    }
    if (out.length) this.changeListeners.forEach((l) => l());
    return out;
  }

  rulesFor(space: Space, contactId?: string): ProposedRule[] {
    return [...this.rules.values()].filter(
      (r) => (r.status === 'auto_applied' || r.status === 'approved') && r.scope.space === space && (!r.scope.contactId || r.scope.contactId === contactId),
    );
  }

  /**
   * Training material: only consented, owner-reviewed finals — never
   * Jennifer's unreviewed replies as ground truth. Split by contact to avoid leakage.
   */
  trainingSplit(seedFn: (key: string) => number): { train: Feedback[]; validation: Feedback[]; test: Feedback[] } {
    const eligible = this.items.filter((f) => f.trainingConsent && f.approvedFinal && (f.kind === 'edited' || f.kind === 'accepted_unchanged'));
    const seen = new Set<string>();
    const dedup = eligible.filter((f) => {
      const k = f.approvedFinal!.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const out = { train: [] as Feedback[], validation: [] as Feedback[], test: [] as Feedback[] };
    for (const f of dedup) {
      const r = seedFn(f.contactId ?? f.id) % 10;
      (r < 7 ? out.train : r < 8 ? out.validation : out.test).push(f);
    }
    return out;
  }
}

export interface ModelDeployment {
  id: string;
  kind: 'prompt' | 'retrieval' | 'fine_tune' | 'workflow_rule';
  version: string;
  datasetRef?: string;
  evaluationReportRef: string;
  criticalPassed: boolean;
  targetImprovement: number; // measured delta on the target metric
  status: 'candidate' | 'shadow' | 'limited' | 'live' | 'rolled_back';
  deployedAt?: Date;
}

/** Model registry with promotion gates and immediate rollback (spec §13). */
export class ModelRegistry {
  private deployments: ModelDeployment[] = [];
  private liveId?: string;

  constructor(private clock: Clock) {}

  register(d: Omit<ModelDeployment, 'id' | 'status'>): ModelDeployment {
    const dep: ModelDeployment = { ...d, id: newId('dep'), status: 'candidate' };
    this.deployments.push(dep);
    return dep;
  }

  promote(id: string, to: 'shadow' | 'limited' | 'live'): ModelDeployment {
    const d = this.get(id);
    if (!d.criticalPassed) throw new Error('Cannot promote: critical tests regressed');
    if (to === 'live' && d.targetImprovement <= 0) throw new Error('Cannot promote to live without measured improvement');
    const order = ['candidate', 'shadow', 'limited', 'live'];
    if (order.indexOf(to) !== order.indexOf(d.status) + 1) throw new Error(`Promotion must go ${d.status} → ${order[order.indexOf(d.status) + 1]}`);
    d.status = to;
    if (to === 'live') {
      if (this.liveId) this.get(this.liveId).status = 'limited';
      this.liveId = id;
      d.deployedAt = this.clock.now();
    }
    return d;
  }

  rollback(): ModelDeployment | undefined {
    if (!this.liveId) return undefined;
    const current = this.get(this.liveId);
    current.status = 'rolled_back';
    const previous = [...this.deployments].reverse().find((d) => d.id !== current.id && d.deployedAt && d.status !== 'rolled_back');
    this.liveId = previous?.id;
    if (previous) previous.status = 'live';
    return previous;
  }

  live(): ModelDeployment | undefined {
    return this.liveId ? this.get(this.liveId) : undefined;
  }

  private get(id: string): ModelDeployment {
    const d = this.deployments.find((x) => x.id === id);
    if (!d) throw new Error(`No deployment ${id}`);
    return d;
  }
}
