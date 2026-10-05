import { HIGH_RISK_ACTIONS, JenniferError } from '../core/types.js';
import { type Clock, newId, payloadHash, backoffDelayMs, KeyedMutex } from '../core/util.js';
import type { AuditLog } from '../audit/audit.js';
import type { AuthorityRegistry } from '../policy/authority.js';
import type { Controls, SuppressionList, SuppressionRule } from '../policy/controls.js';
import type { ConversationStore } from '../events/conversations.js';
import type { DeadLetterQueue } from '../events/events.js';
import {
  type ActionHandler,
  type ActionIntent,
  type ActionState,
  type Approval,
  PENDING_STATES,
  TRANSITIONS,
} from './model.js';

export type NewIntent<P> = Pick<
  ActionIntent<P>,
  'ownerId' | 'type' | 'space' | 'channel' | 'connectorId' | 'accountId' | 'conversationId' | 'workflowId' | 'taskId' | 'payload' | 'proposedBy' | 'expiresAt'
>;

export interface ActionServiceDeps {
  clock: Clock;
  audit: AuditLog;
  authority: AuthorityRegistry;
  controls: Controls;
  suppressions: SuppressionList;
  conversations: ConversationStore;
  deadLetters: DeadLetterQueue;
  maxAttempts?: number;
  approvalTtlMs?: number;
  random?: () => number;
  /** Write-ahead durability: records state changes; flushed before any connector call. */
  durability?: ActionDurability;
}

export interface ActionDurability {
  record(intent: ActionIntent, approval?: Approval): void;
  flush(): Promise<void>;
}

/**
 * Owns the action lifecycle: proposal, validation, authority decision,
 * approval binding, and execution through the single final executor.
 * The model can only call propose(); everything after is deterministic code.
 */
export class ActionService {
  private intents = new Map<string, ActionIntent>();
  private approvals = new Map<string, Approval>();
  private handlers = new Map<string, ActionHandler<any>>();
  private mutex = new KeyedMutex();
  private readonly maxAttempts: number;
  private readonly approvalTtlMs: number;

  constructor(private d: ActionServiceDeps) {
    this.maxAttempts = d.maxAttempts ?? 5;
    this.approvalTtlMs = d.approvalTtlMs ?? 24 * 3600_000;
    // Permission changes apply to queued work immediately (spec §1 DoD).
    d.authority.onChange(() => this.revalidateQueued('policy changed'));
    d.suppressions.onAdd((rule) => this.cancelSuppressed(rule));
    d.controls.onStop((kind, id) => this.cancelForStop(kind, id));
  }

  /**
   * Rehydrate after a restart. An action that was 'executing' when the
   * process died may or may not have reached the provider: it becomes
   * 'unknown' and is reconciled before any retry.
   */
  restore(intents: ActionIntent[], approvals: Approval[]): void {
    for (const a of approvals) this.approvals.set(a.id, a);
    for (const i of intents) {
      if (i.state === 'executing') {
        i.history.push({ at: this.d.clock.now(), from: 'executing', to: 'unknown', reason: 'recovered after restart', actor: 'system' });
        i.state = 'unknown';
        i.stateReason = 'recovered after restart';
      }
      this.intents.set(i.id, i);
    }
  }

  register(handler: ActionHandler<any>): void {
    this.handlers.set(handler.type, handler);
  }

  get(id: string): ActionIntent {
    const i = this.intents.get(id);
    if (!i) throw new JenniferError('action.not_found', `No action ${id}`);
    return i;
  }

  list(filter: { state?: ActionState; conversationId?: string; ownerId?: string } = {}): ActionIntent[] {
    return [...this.intents.values()].filter(
      (i) =>
        (!filter.state || i.state === filter.state) &&
        (!filter.conversationId || i.conversationId === filter.conversationId) &&
        (!filter.ownerId || i.ownerId === filter.ownerId),
    );
  }

  getApproval(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  /** Model/agent/user proposes an action. It is validated and routed immediately. */
  propose<P>(input: NewIntent<P>): ActionIntent<P> {
    this.handler(input.type);
    const conv = input.conversationId ? this.d.conversations.getConversation(input.conversationId) : undefined;
    const intent: ActionIntent<P> = {
      ...input,
      id: newId('act'),
      basedOnConversationRevision: conv?.revision,
      revision: 1,
      payloadHash: payloadHash(input.payload),
      idempotencyKey: newId('idem'),
      state: 'proposed',
      createdAt: this.d.clock.now(),
      decisionReasons: [],
      attempts: 0,
      history: [],
    };
    this.intents.set(intent.id, intent as ActionIntent);
    this.d.audit.record(input.proposedBy, 'action.proposed', intent.id, { type: intent.type, payloadHash: intent.payloadHash });
    this.route(intent as ActionIntent);
    return intent;
  }

  /**
   * Editing creates a new revision; every approval for earlier revisions is
   * invalidated (spec §14, Scenario G).
   */
  edit<P>(id: string, actor: string, payload: P): ActionIntent<P> {
    const intent = this.get(id) as ActionIntent<P>;
    if (!PENDING_STATES.has(intent.state)) throw new JenniferError('action.not_editable', `Action is ${intent.state}`);
    intent.payload = payload;
    intent.revision += 1;
    intent.payloadHash = payloadHash(payload);
    intent.approvalId = undefined;
    intent.authorityRuleId = undefined;
    for (const a of this.approvals.values())
      if (a.intentId === id && !a.invalidatedAt) {
        a.invalidatedAt = this.d.clock.now();
        this.d.durability?.record(intent as ActionIntent, a);
      }
    this.transition(intent as ActionIntent, 'proposed', actor, `edited to revision ${intent.revision}`);
    this.d.audit.record(actor, 'action.edited', id, { revision: intent.revision, payloadHash: intent.payloadHash });
    this.route(intent as ActionIntent);
    return intent;
  }

  /**
   * Bind an approval to the exact revision and payload hash the user saw.
   * A stale revision or hash is refused rather than silently re-targeted.
   */
  approve(id: string, approver: string, seen: { revision: number; payloadHash: string }, opts: { stepUpVerified?: boolean } = {}): Approval {
    const intent = this.get(id);
    if (intent.state !== 'awaiting_decision') throw new JenniferError('approval.bad_state', `Action is ${intent.state}, not awaiting a decision`);
    if (seen.revision !== intent.revision || seen.payloadHash !== intent.payloadHash)
      throw new JenniferError('approval.stale', 'The action changed since it was shown; review the current version');
    if (approver !== intent.ownerId) throw new JenniferError('approval.not_owner', 'Only the owner can approve this action');
    if (HIGH_RISK_ACTIONS.has(intent.type) && !opts.stepUpVerified)
      throw new JenniferError('approval.step_up_required', 'This action requires second-factor verification');
    const now = this.d.clock.now();
    const expiresAt = new Date(Math.min(now.getTime() + this.approvalTtlMs, intent.expiresAt?.getTime() ?? Infinity));
    const approval: Approval = {
      id: newId('apr'),
      intentId: id,
      revision: intent.revision,
      payloadHash: intent.payloadHash,
      approvedBy: approver,
      approvedAt: now,
      expiresAt,
      stepUpVerified: !!opts.stepUpVerified,
    };
    this.approvals.set(approval.id, approval);
    this.d.durability?.record(intent, approval);
    intent.approvalId = approval.id;
    this.transition(intent, 'ready', approver, 'approved');
    this.d.audit.record(approver, 'action.approved', id, { approvalId: approval.id, revision: approval.revision, payloadHash: approval.payloadHash });
    return approval;
  }

  /** Force a specific decision even when a standing rule would allow execution. */
  requireDecision(id: string, actor: string, reason: string): void {
    const intent = this.get(id);
    if (intent.state !== 'ready' && intent.state !== 'validated') return;
    intent.authorityRuleId = undefined;
    intent.decisionReasons.push(reason);
    this.transition(intent, 'awaiting_decision', actor, reason);
  }

  reject(id: string, actor: string, reason = 'rejected'): void {
    this.cancel(id, actor, reason);
  }

  cancel(id: string, actor: string, reason: string): boolean {
    const intent = this.get(id);
    if (!PENDING_STATES.has(intent.state)) return false;
    this.transition(intent, 'canceled', actor, reason);
    this.d.audit.record(actor, 'action.canceled', id, { reason });
    return true;
  }

  /** A new inbound message materially changes context → queued replies are invalidated (spec §5). */
  onInboundMessage(conversationId: string): string[] {
    const conv = this.d.conversations.getConversation(conversationId);
    const canceled: string[] = [];
    for (const i of this.list({ conversationId })) {
      if (i.type !== 'send_message' || !PENDING_STATES.has(i.state)) continue;
      if ((i.basedOnConversationRevision ?? 0) < conv.revision && this.cancel(i.id, 'system', 'new inbound message changed the context')) canceled.push(i.id);
    }
    return canceled;
  }

  /** Bruno replied manually → redundant pending responses are canceled (spec §16). */
  onManualReply(conversationId: string): string[] {
    return this.list({ conversationId })
      .filter((i) => i.type === 'send_message' && PENDING_STATES.has(i.state))
      .filter((i) => this.cancel(i.id, 'system', 'Bruno replied manually'))
      .map((i) => i.id);
  }

  /** Reconcile every action whose outcome is unknown (timeouts, crash recovery). */
  async recoverUnknown(): Promise<ActionIntent[]> {
    const out: ActionIntent[] = [];
    const now = this.d.clock.now().getTime();
    for (const i of this.list({ state: 'unknown' })) if (!i.nextAttemptAt || i.nextAttemptAt.getTime() <= now) out.push(await this.execute(i.id));
    return out;
  }

  /** Execute every ready action whose retry time has arrived. */
  async runDue(): Promise<ActionIntent[]> {
    const now = this.d.clock.now().getTime();
    const due = this.list({ state: 'ready' }).filter((i) => !i.nextAttemptAt || i.nextAttemptAt.getTime() <= now);
    const out: ActionIntent[] = [];
    for (const i of due) out.push(await this.execute(i.id));
    return out;
  }

  /**
   * The single final executor. Re-validates everything against *current*
   * state immediately before the connector sees the request (spec §12, §15).
   */
  async execute(id: string): Promise<ActionIntent> {
    const key = this.serializationKey(this.get(id));
    return this.mutex.run(key, async () => {
      const intent = this.get(id);
      if (intent.state === 'unknown') return this.reconcile(intent);
      if (intent.state !== 'ready') return intent;
      const handler = this.handler(intent.type);

      if (payloadHash(intent.payload) !== intent.payloadHash) {
        this.transition(intent, 'failed', 'system', 'payload hash mismatch');
        return intent;
      }
      if (intent.expiresAt && intent.expiresAt.getTime() <= this.d.clock.now().getTime()) {
        this.transition(intent, 'canceled', 'system', 'action expired');
        return intent;
      }
      const resolved = handler.resolve(intent);
      const stop = this.d.controls.blockReason(intent.connectorId, resolved.contactIds);
      if (stop) {
        this.transition(intent, 'canceled', 'system', stop);
        return intent;
      }
      const sup = this.d.suppressions.match({ contactIds: resolved.contactIds, addresses: resolved.addresses, channel: intent.channel });
      if (sup) {
        this.transition(intent, 'canceled', 'system', `suppressed: ${sup.reason}`);
        return intent;
      }
      if (intent.conversationId && intent.basedOnConversationRevision !== undefined) {
        const conv = this.d.conversations.getConversation(intent.conversationId);
        if (conv.revision > intent.basedOnConversationRevision) {
          this.transition(intent, 'canceled', 'system', 'new inbound message changed the context');
          return intent;
        }
      }
      if (resolved.violations.length) {
        this.transition(intent, 'failed', 'system', resolved.violations.join('; '));
        return intent;
      }
      const auth = this.authorizationFor(intent, resolved);
      if (!auth.ok) {
        intent.approvalId = undefined;
        this.transition(intent, 'awaiting_decision', 'system', auth.reason);
        return intent;
      }
      intent.policyVersion = this.d.authority.policyVersion;
      intent.authorityRuleId = auth.ruleId;

      this.transition(intent, 'executing', 'system', auth.ruleId ? `standing rule ${auth.ruleId}` : `approval ${intent.approvalId}`);
      intent.attempts += 1;
      // The 'executing' record must be durable before the provider sees the request,
      // so a crash mid-send is recovered as 'unknown' and reconciled, never resent blindly.
      await this.d.durability?.flush();
      let result;
      try {
        result = await handler.perform(intent);
      } catch (e) {
        result = { kind: 'ambiguous' as const, error: (e as Error).message };
      }
      return this.applyResult(intent, result);
    });
  }

  private async reconcile(intent: ActionIntent): Promise<ActionIntent> {
    const handler = this.handler(intent.type);
    let r;
    try {
      r = await handler.reconcile(intent);
    } catch (e) {
      // Can't reach the provider: stay unknown and look again later. Never resend blind.
      intent.nextAttemptAt = new Date(this.d.clock.now().getTime() + 60_000);
      intent.stateReason = `reconciliation failed: ${(e as Error).message}`;
      return intent;
    }
    if (r.found === 'pending') {
      intent.nextAttemptAt = new Date(this.d.clock.now().getTime() + 30_000);
      intent.stateReason = 'waiting for the provider to show the result';
      return intent;
    }
    if (r.found) {
      intent.receipt = { ...r.receipt, observedAt: this.d.clock.now() };
      this.transition(intent, 'provider_accepted', 'system', 'reconciled: provider has the message');
      this.consumeApproval(intent);
      return intent;
    }
    // Provider has no record: safe to retry with the same idempotency key.
    this.scheduleRetry(intent, 'reconciled: provider has no record');
    return intent;
  }

  private applyResult(intent: ActionIntent, result: Awaited<ReturnType<ActionHandler['perform']>>): ActionIntent {
    if (result.kind === 'accepted') {
      intent.receipt = { ...result.receipt, observedAt: this.d.clock.now() };
      this.transition(intent, 'provider_accepted', 'system', 'provider accepted');
      this.consumeApproval(intent);
      this.d.audit.record('jennifer', 'action.executed', intent.id, {
        type: intent.type,
        authorityRuleId: intent.authorityRuleId,
        approvalId: intent.approvalId,
        policyVersion: intent.policyVersion,
        providerMessageId: intent.receipt.providerMessageId,
      });
      return intent;
    }
    if (result.kind === 'ambiguous') {
      // Never blindly repeat: reconcile before any retry (spec §5).
      this.transition(intent, 'unknown', 'system', `ambiguous: ${result.error}`);
      return intent;
    }
    if (result.retryable) this.scheduleRetry(intent, result.error);
    else {
      this.transition(intent, 'failed', 'system', result.error);
      this.d.deadLetters.push({ subjectId: intent.id, kind: intent.type, error: result.error, attempts: intent.attempts, recoveryAction: 'Review the failure and reconnect or edit the action' });
    }
    return intent;
  }

  private scheduleRetry(intent: ActionIntent, reason: string): void {
    if (intent.attempts >= this.maxAttempts) {
      this.transition(intent, 'failed', 'system', `giving up after ${intent.attempts} attempts: ${reason}`);
      this.d.deadLetters.push({ subjectId: intent.id, kind: intent.type, error: reason, attempts: intent.attempts, recoveryAction: 'Retry manually from Tasks or cancel' });
      return;
    }
    intent.nextAttemptAt = new Date(this.d.clock.now().getTime() + backoffDelayMs(intent.attempts, 500, 60_000, this.d.random));
    this.transition(intent, 'ready', 'system', `retry scheduled: ${reason}`);
  }

  private consumeApproval(intent: ActionIntent): void {
    if (intent.approvalId) {
      const a = this.approvals.get(intent.approvalId);
      if (a) {
        a.consumedAt = this.d.clock.now();
        this.d.durability?.record(intent, a);
      }
    }
  }

  /** Authorized by a live standing rule or by a valid, unconsumed approval of this exact revision. */
  private authorizationFor(intent: ActionIntent, resolved: ReturnType<ActionHandler['resolve']>): { ok: true; ruleId?: string } | { ok: false; reason: string } {
    if (intent.approvalId) {
      const a = this.approvals.get(intent.approvalId);
      const now = this.d.clock.now().getTime();
      if (
        a &&
        !a.invalidatedAt &&
        !a.consumedAt &&
        a.expiresAt.getTime() > now &&
        a.revision === intent.revision &&
        a.payloadHash === intent.payloadHash &&
        a.approvedBy === intent.ownerId
      )
        return { ok: true };
      return { ok: false, reason: 'approval no longer valid for this revision' };
    }
    const decision = this.d.authority.evaluate(resolved.authority);
    if (decision.outcome === 'execute' && resolved.concerns.length === 0) return { ok: true, ruleId: decision.ruleId };
    return { ok: false, reason: [...decision.reasons, ...resolved.concerns].join('; ') };
  }

  /** Validate and route a proposed intent to ready / awaiting_decision / canceled. */
  private route(intent: ActionIntent): void {
    const handler = this.handler(intent.type);
    const resolved = handler.resolve(intent);
    if (resolved.violations.length) {
      this.transition(intent, 'failed', 'system', resolved.violations.join('; '));
      intent.decisionReasons = resolved.violations;
      return;
    }
    const sup = this.d.suppressions.match({ contactIds: resolved.contactIds, addresses: resolved.addresses, channel: intent.channel });
    if (sup) {
      this.transition(intent, 'canceled', 'system', `suppressed: ${sup.reason}`);
      return;
    }
    this.transition(intent, 'validated', 'system');
    const decision = this.d.authority.evaluate(resolved.authority);
    intent.policyVersion = decision.policyVersion;
    intent.decisionReasons = [...decision.reasons, ...resolved.concerns];
    if (decision.outcome === 'observe_only') {
      this.transition(intent, 'canceled', 'system', 'observe-only setting: Jennifer may not act here');
    } else if (decision.outcome === 'execute' && resolved.concerns.length === 0) {
      intent.authorityRuleId = decision.ruleId;
      this.transition(intent, 'ready', 'system', `standing rule ${decision.ruleId}`);
    } else {
      this.transition(intent, 'awaiting_decision', 'system', intent.decisionReasons.join('; '));
    }
  }

  private revalidateQueued(reason: string): void {
    for (const i of this.list({ state: 'ready' })) {
      if (i.approvalId) continue;
      const resolved = this.handler(i.type).resolve(i);
      const decision = this.d.authority.evaluate(resolved.authority);
      if (decision.outcome !== 'execute' || resolved.concerns.length) {
        i.authorityRuleId = undefined;
        this.transition(i, 'awaiting_decision', 'system', `${reason}: ${decision.reasons.join('; ')}`);
      }
    }
  }

  private cancelSuppressed(rule: SuppressionRule): void {
    for (const i of this.list()) {
      if (!PENDING_STATES.has(i.state)) continue;
      const r = this.handler(i.type).resolve(i);
      const matched = this.d.suppressions.match({ contactIds: r.contactIds, addresses: r.addresses, channel: i.channel });
      if (matched?.id === rule.id) this.cancel(i.id, 'system', `suppressed: ${rule.reason}`);
    }
  }

  private cancelForStop(kind: string, id?: string): void {
    for (const i of this.list()) {
      if (!PENDING_STATES.has(i.state)) continue;
      if (kind === 'emergency') this.cancel(i.id, 'system', 'emergency stop');
      else if (kind === 'connector' && i.connectorId === id) this.cancel(i.id, 'system', 'connector paused');
      else if (kind === 'contact' && id && this.handler(i.type).resolve(i).contactIds.includes(id)) this.cancel(i.id, 'system', 'contact paused');
    }
  }

  private serializationKey(i: ActionIntent): string {
    if (i.conversationId) return `conv:${i.conversationId}`;
    if (i.channel === 'calendar') return `cal:${i.accountId}`;
    return `acct:${i.accountId}`;
  }

  private handler(type: string): ActionHandler {
    const h = this.handlers.get(type);
    if (!h) throw new JenniferError('action.no_handler', `No handler registered for ${type}`);
    return h;
  }

  /**
   * A provider reported the final outcome after accepting the action (e.g.
   * Claude finished a delegated task). Only accepted or still-unconfirmed
   * actions can be settled this way.
   */
  settle(id: string, ok: boolean, actor: string, evidence: string): ActionIntent {
    const intent = this.get(id);
    if (intent.state === 'unknown') {
      intent.receipt = { deliveryStatus: 'accepted', evidence, observedAt: this.d.clock.now() };
      this.transition(intent, 'provider_accepted', actor, 'provider reported the task');
      this.consumeApproval(intent);
    }
    if (intent.state !== 'provider_accepted') throw new JenniferError('action.not_settleable', `Action ${id} is ${intent.state}`);
    intent.receipt = { ...(intent.receipt ?? { deliveryStatus: 'accepted' }), deliveryStatus: ok ? 'confirmed' : intent.receipt?.deliveryStatus ?? 'accepted', evidence, observedAt: this.d.clock.now() };
    this.transition(intent, ok ? 'confirmed' : 'failed', actor, evidence);
    return intent;
  }

  private transitionListeners: Array<(intent: ActionIntent, from: ActionState) => void> = [];

  /** Observe state changes (notifications, metrics). Listeners must not throw. */
  onTransition(fn: (intent: ActionIntent, from: ActionState) => void): void {
    this.transitionListeners.push(fn);
  }

  private transition(intent: ActionIntent, to: ActionState, actor: string, reason?: string): void {
    const from = intent.state;
    if (from !== to && !TRANSITIONS[from].includes(to)) throw new JenniferError('action.bad_transition', `${from} → ${to} not allowed`);
    intent.state = to;
    intent.stateReason = reason;
    intent.history.push({ at: this.d.clock.now(), from, to, reason, actor });
    this.d.durability?.record(intent);
    if (from !== to)
      for (const l of this.transitionListeners) {
        try {
          l(intent, from);
        } catch {
          /* observers never break the pipeline */
        }
      }
  }
}
