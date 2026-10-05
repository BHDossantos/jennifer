import type { Department, RoleMode } from './catalog.js';

/** Company OS domain types (blueprint §2, §9, §12). */

export const COMPANY_IDS = ['insurance', 'technology', 'music', 'restaurant', 'nonprofit', 'learnnoelia', 'foundation'] as const;
export type CompanyId = (typeof COMPANY_IDS)[number];

export interface Company {
  id: CompanyId;
  name: string;
  timezone: string;
  locale: string;
  status: 'active' | 'paused';
  /** Approved business profile: offer, scope, claim limits, contact rules (owner-maintained). */
  profile: Record<string, unknown>;
}

export interface Membership {
  companyId: CompanyId;
  userId: string;
  role: 'owner' | 'member' | 'viewer';
  permissions: string[];
  revokedAt?: string;
}

/** Common output envelope for every role (blueprint §9). */
export interface RoleOutput<T = unknown> {
  status: 'completed' | 'blocked' | 'needs_review' | 'failed';
  summary: string;
  /** Role-specific structured result (validated against the role's data schema). */
  data?: T;
  artifacts: Array<{ kind: string; title: string; content: T | string }>;
  sources: Array<{ sourceId: string; locator?: string; note?: string }>;
  assumptions: string[];
  proposed_actions: Array<{ tool: string; target: string; payloadRef?: string; reason: string }>;
  blockers: string[];
}

export interface RoleVersion {
  agentId: string;
  version: number;
  name: string;
  department: Department;
  mode: RoleMode;
  purpose: string;
  ownerRole: string;
  promptTemplate: string;
  allowedTools: string[];
  retrievalScopes: string[];
  actionPolicy: 'none' | 'draft_only' | 'exact_approval';
  limits: { maxModelTurns: number; maxToolCalls: number; timeoutMs: number };
  budgetEur: number;
  evaluationSuite: string;
  onMissingEvidence: 'block' | 'escalate';
  onError: 'fail' | 'escalate';
}

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'blocked' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
export const TERMINAL_RUN: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);

export interface RunStep {
  key: string;
  roleId?: string;
  roleVersion?: number;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'blocked' | 'failed';
  output?: RoleOutput;
  startedAt?: string;
  finishedAt?: string;
}

export interface Run {
  id: string;
  companyId: CompanyId;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  input: Record<string, unknown>;
  initiatedBy: string;
  idempotencyKey?: string;
  relatedRunId?: string;
  steps: RunStep[];
  /** Workflow scratch state carried between persisted steps. */
  state: Record<string, unknown>;
  budgetEur: number;
  spentEur: number;
  artifactIds: string[];
  actionIds: string[];
  blockers: string[];
  summary?: string;
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
  cancelRequested?: boolean;
}

export interface RunEvent {
  companyId: CompanyId;
  runId: string;
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  companyId: CompanyId;
  runId?: string;
  kind: string;
  title: string;
  content: unknown;
  contentHash: string;
  sources: RoleOutput['sources'];
  review: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface KnowledgeSource {
  id: string;
  companyId: CompanyId;
  title: string;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  /** Who may use it: retrieval scope categories (e.g. offer, brand, procedures, participants). */
  category: string;
  status: 'ingesting' | 'pending_review' | 'approved' | 'revoked' | 'failed';
  documentVersionId: string;
  contentHash: string;
  ownerId: string;
  origin: { kind: 'text' | 'url' | 'upload'; ref?: string };
  retrievedAt: string;
  effectiveAt?: string;
  reviewDueAt?: string;
  expiresAt?: string;
  error?: string;
}

export interface KnowledgeChunk {
  companyId: CompanyId;
  sourceId: string;
  documentVersionId: string;
  seq: number;
  locator: string;
  text: string;
}

export interface KnowledgeFact {
  id: string;
  companyId: CompanyId;
  statement: string;
  status: 'proposed' | 'approved' | 'rejected';
  sourceId?: string;
  locator?: string;
  proposedBy: string;
  validFrom?: string;
  validUntil?: string;
}

export type CrmKind = 'account' | 'contact' | 'opportunity' | 'task';

export interface CrmRecord {
  id: string;
  companyId: CompanyId;
  kind: CrmKind;
  version: number;
  fields: Record<string, unknown>;
  /** Field → source evidence. */
  provenance: Record<string, { sourceId?: string; runId?: string; note?: string }>;
  updatedAt: string;
}

export interface CrmPatch {
  id: string;
  companyId: CompanyId;
  recordId?: string; // undefined = create
  kind: CrmKind;
  baseVersion?: number;
  changes: Record<string, { from?: unknown; to: unknown; source?: string }>;
  status: 'proposed' | 'applied' | 'rejected' | 'conflict';
  runId?: string;
  reason: string;
  createdAt: string;
}
