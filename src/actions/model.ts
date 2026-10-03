import type { ActionType, Channel, Space } from '../core/types.js';
import type { AuthorityRequest } from '../policy/authority.js';

/** Action lifecycle (spec §5). provider_accepted ≠ read by the recipient. */
export const ACTION_STATES = [
  'proposed',
  'validated',
  'awaiting_decision',
  'ready',
  'executing',
  'provider_accepted',
  'confirmed',
  'failed',
  'canceled',
  'unknown',
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const TRANSITIONS: Record<ActionState, ActionState[]> = {
  proposed: ['validated', 'failed', 'canceled', 'proposed'],
  validated: ['awaiting_decision', 'ready', 'canceled', 'failed', 'proposed'],
  awaiting_decision: ['ready', 'canceled', 'proposed', 'failed'],
  ready: ['executing', 'canceled', 'awaiting_decision', 'proposed', 'failed'],
  executing: ['provider_accepted', 'failed', 'unknown', 'ready'],
  unknown: ['provider_accepted', 'ready', 'failed', 'executing'],
  provider_accepted: ['confirmed', 'failed'],
  confirmed: [],
  failed: ['ready', 'canceled'],
  canceled: [],
};

export const PENDING_STATES: ReadonlySet<ActionState> = new Set(['proposed', 'validated', 'awaiting_decision', 'ready', 'failed']);

export interface ActionReceipt {
  providerMessageId?: string;
  providerEventId?: string;
  deliveryStatus: 'accepted' | 'delivered' | 'confirmed';
  observedAt: Date;
  evidence: string;
}

export interface ActionIntent<P = unknown> {
  id: string;
  ownerId: string;
  type: ActionType;
  space: Space;
  channel: Channel;
  connectorId: string;
  accountId: string;
  conversationId?: string;
  /** Conversation revision the action was based on; newer inbound context invalidates it. */
  basedOnConversationRevision?: number;
  workflowId?: string;
  taskId?: string;
  payload: P;
  revision: number;
  payloadHash: string;
  idempotencyKey: string;
  state: ActionState;
  stateReason?: string;
  proposedBy: string; // 'jennifer', 'agent:<role>', 'bruno'
  createdAt: Date;
  expiresAt?: Date;
  /** Filled by validation: policy version and authorization evidence. */
  policyVersion?: number;
  authorityRuleId?: string;
  approvalId?: string;
  decisionReasons: string[];
  attempts: number;
  nextAttemptAt?: Date;
  receipt?: ActionReceipt;
  history: Array<{ at: Date; from: ActionState; to: ActionState; reason?: string; actor: string }>;
}

export interface Approval {
  id: string;
  intentId: string;
  revision: number;
  payloadHash: string;
  approvedBy: string;
  approvedAt: Date;
  expiresAt: Date;
  stepUpVerified: boolean;
  consumedAt?: Date;
  invalidatedAt?: Date;
}

export interface ResolvedAction {
  authority: AuthorityRequest;
  contactIds: string[];
  addresses: string[];
  /** Hard violations — the action cannot run even with approval. */
  violations: string[];
  /** Soft concerns — force a specific decision instead of standing execution. */
  concerns: string[];
}

export type PerformResult =
  | { kind: 'accepted'; receipt: Omit<ActionReceipt, 'observedAt'> }
  | { kind: 'rejected'; error: string; retryable: boolean }
  | { kind: 'ambiguous'; error: string };

/** Per-action-type logic plugged into the generic pipeline. */
export interface ActionHandler<P = unknown> {
  type: ActionType;
  resolve(intent: ActionIntent<P>): ResolvedAction;
  perform(intent: ActionIntent<P>): Promise<PerformResult>;
  /** After an ambiguous result: what does the provider actually have? pending: the provider may not show the result yet; reconcile again later instead of resending. */
  reconcile(intent: ActionIntent<P>): Promise<{ found: true; receipt: Omit<ActionReceipt, 'observedAt'> } | { found: false } | { found: 'pending' }>;
}
