import { z } from 'zod';
import { ACTION_MODES, ACTION_TYPES, HIGH_RISK_ACTIONS, type ActionMode, type ActionType, type Space, SPACES, JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { AuditLog } from '../audit/audit.js';

/**
 * Machine-readable authority registry (spec §1). A language model may propose
 * an action; only a rule in this registry (or an exact approval) authorizes it.
 */
export const AuthorityRuleSchema = z.object({
  id: z.string(),
  principal: z.string(), // who granted the authority, e.g. 'bruno'
  action: z.enum(ACTION_TYPES),
  mode: z.enum(ACTION_MODES),
  scope: z.object({
    accountIds: z.array(z.string()).optional(),
    contactIds: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
    spaces: z.array(z.enum(SPACES)).optional(),
    workflowIds: z.array(z.string()).optional(),
  }),
  limits: z
    .object({
      maxAmountEur: z.number().nonnegative().optional(),
      maxRecipients: z.number().int().positive().optional(),
    })
    .default({}),
  attachments: z.object({ allowed: z.boolean(), spaces: z.array(z.enum(SPACES)).optional() }).default({ allowed: false }),
  expiresAt: z.date().optional(),
  policyVersion: z.number().int(),
  revokedAt: z.date().optional(),
  note: z.string().optional(),
});
export type AuthorityRule = z.infer<typeof AuthorityRuleSchema>;

export type NewAuthorityRule = Omit<AuthorityRule, 'id' | 'policyVersion' | 'revokedAt' | 'limits' | 'attachments'> &
  Partial<Pick<AuthorityRule, 'limits' | 'attachments'>>;

export interface AuthorityRequest {
  action: ActionType;
  accountId: string;
  space: Space;
  contactIds: string[];
  recipientDomains: string[];
  workflowId?: string;
  amountEur?: number;
  attachmentSpaces: Space[];
  recipientCount: number;
}

export type AuthorityOutcome = 'execute' | 'ask' | 'draft_only' | 'observe_only';

export interface AuthorityDecision {
  outcome: AuthorityOutcome;
  ruleId?: string;
  policyVersion: number;
  reasons: string[];
}

const MODE_TO_OUTCOME: Record<ActionMode, AuthorityOutcome> = {
  execute: 'execute',
  ask: 'ask',
  draft: 'draft_only',
  observe: 'observe_only',
};

export class AuthorityRegistry {
  private rules = new Map<string, AuthorityRule>();
  private version = 1;
  private listeners: Array<(version: number, changedRuleId: string) => void> = [];

  constructor(
    private clock: Clock,
    private audit: AuditLog,
  ) {}

  /** Rehydrate persisted rules after a restart. */
  restore(rules: AuthorityRule[]): void {
    for (const r of rules) {
      this.rules.set(r.id, r);
      this.version = Math.max(this.version, r.policyVersion);
    }
  }

  get policyVersion(): number {
    return this.version;
  }

  onChange(fn: (version: number, changedRuleId: string) => void): void {
    this.listeners.push(fn);
  }

  grant(input: NewAuthorityRule): AuthorityRule {
    const rule = AuthorityRuleSchema.parse({ ...input, id: newId('auth'), policyVersion: this.bump() });
    if (HIGH_RISK_ACTIONS.has(rule.action) && rule.mode === 'execute') {
      const scoped = (rule.scope.contactIds?.length ?? 0) > 0 || (rule.scope.accountIds?.length ?? 0) > 0;
      if (!scoped) throw new JenniferError('authority.unscoped_high_risk', `${rule.action} standing authority must name specific accounts or contacts`);
      if (rule.action === 'transfer_money' && rule.limits.maxAmountEur === undefined)
        throw new JenniferError('authority.missing_limit', 'transfer_money standing authority requires maxAmountEur');
      if (!rule.expiresAt) throw new JenniferError('authority.missing_expiry', `${rule.action} standing authority requires an expiry`);
    }
    this.rules.set(rule.id, rule);
    this.audit.record(input.principal, 'authority.granted', rule.id, { action: rule.action, mode: rule.mode, scope: rule.scope, version: rule.policyVersion });
    this.emit(rule.id);
    return rule;
  }

  /** Changing a permission takes effect immediately: the executor re-checks on every write. */
  update(ruleId: string, principal: string, patch: Partial<Pick<AuthorityRule, 'mode' | 'limits' | 'expiresAt' | 'scope' | 'attachments'>>): AuthorityRule {
    const existing = this.get(ruleId);
    const updated = AuthorityRuleSchema.parse({ ...existing, ...patch, policyVersion: this.bump() });
    this.rules.set(ruleId, updated);
    this.audit.record(principal, 'authority.updated', ruleId, { patch, version: updated.policyVersion });
    this.emit(ruleId);
    return updated;
  }

  revoke(ruleId: string, principal: string): void {
    const existing = this.get(ruleId);
    this.rules.set(ruleId, { ...existing, revokedAt: this.clock.now(), policyVersion: this.bump() });
    this.audit.record(principal, 'authority.revoked', ruleId, { version: this.version });
    this.emit(ruleId);
  }

  get(ruleId: string): AuthorityRule {
    const r = this.rules.get(ruleId);
    if (!r) throw new JenniferError('authority.not_found', `No authority rule ${ruleId}`);
    return r;
  }

  list(): AuthorityRule[] {
    return [...this.rules.values()];
  }

  isActive(rule: AuthorityRule): boolean {
    if (rule.revokedAt) return false;
    if (rule.expiresAt && rule.expiresAt.getTime() <= this.clock.now().getTime()) return false;
    return true;
  }

  /**
   * Evaluate a concrete request. The most specific active matching rule wins
   * (contact > account/domain > space/workflow > global); ties resolve to the
   * most restrictive mode. No match → ask for a specific decision.
   */
  evaluate(req: AuthorityRequest): AuthorityDecision {
    const reasons: string[] = [];
    const candidates = this.list().filter((r) => r.action === req.action && this.isActive(r) && this.matches(r, req));
    if (candidates.length === 0) {
      return { outcome: 'ask', policyVersion: this.version, reasons: ['no active standing instruction covers this action'] };
    }
    candidates.sort((a, b) => specificity(b) - specificity(a) || restrictiveness(b.mode) - restrictiveness(a.mode));
    const rule = candidates[0]!;
    let outcome = MODE_TO_OUTCOME[rule.mode];

    if (outcome === 'execute') {
      if (req.amountEur !== undefined) {
        if (rule.limits.maxAmountEur === undefined || req.amountEur > rule.limits.maxAmountEur) {
          outcome = 'ask';
          reasons.push(`amount ${req.amountEur} EUR exceeds the standing limit`);
        }
      } else if (req.action === 'transfer_money') {
        outcome = 'ask';
        reasons.push('transfer amount not specified');
      }
      if (rule.limits.maxRecipients !== undefined && req.recipientCount > rule.limits.maxRecipients) {
        outcome = 'ask';
        reasons.push('recipient count exceeds the standing limit');
      }
      if (req.attachmentSpaces.length > 0) {
        const allowedSpaces = rule.attachments.spaces ?? [req.space];
        if (!rule.attachments.allowed || req.attachmentSpaces.some((s) => !allowedSpaces.includes(s))) {
          outcome = 'ask';
          reasons.push('attachments are outside the standing permission');
        }
      }
    }
    if (reasons.length === 0) reasons.push(`covered by rule ${rule.id} (${rule.mode})`);
    return { outcome, ruleId: rule.id, policyVersion: this.version, reasons };
  }

  private matches(r: AuthorityRule, req: AuthorityRequest): boolean {
    const s = r.scope;
    if (s.accountIds && !s.accountIds.includes(req.accountId)) return false;
    if (s.spaces && !s.spaces.includes(req.space)) return false;
    if (s.workflowIds && (!req.workflowId || !s.workflowIds.includes(req.workflowId))) return false;
    // Every recipient must be inside the rule's contact or domain scope.
    if (s.contactIds || s.domains) {
      const byContact = s.contactIds ? req.contactIds.length > 0 && req.contactIds.every((c) => s.contactIds!.includes(c)) : false;
      const byDomain = s.domains
        ? req.recipientDomains.length > 0 && req.recipientDomains.every((d) => s.domains!.includes(d.toLowerCase()))
        : false;
      if (!byContact && !byDomain) return false;
    }
    return true;
  }

  private bump(): number {
    return ++this.version;
  }

  private emit(ruleId: string): void {
    for (const l of this.listeners) l(this.version, ruleId);
  }
}

function specificity(r: AuthorityRule): number {
  let n = 0;
  if (r.scope.contactIds) n += 8;
  if (r.scope.domains) n += 4;
  if (r.scope.accountIds) n += 2;
  if (r.scope.spaces || r.scope.workflowIds) n += 1;
  return n;
}

function restrictiveness(m: ActionMode): number {
  return { execute: 0, draft: 1, ask: 2, observe: 3 }[m];
}
