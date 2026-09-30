import { type Sensitivity, type Space, JenniferError, sensitivityAllowed } from '../core/types.js';
import { type Clock, newId, sha256 } from '../core/util.js';
import { containsAuthenticationCode } from '../security/redaction.js';
import { type Embedder, HashingEmbedder, cosine } from './embedder.js';

/** Memory classes (spec §10). */
export type MemoryKind = 'profile_fact' | 'preference' | 'project_record' | 'contact_context' | 'instruction' | 'episodic_summary' | 'working_state';

export type ConfidenceClass = 'confirmed' | 'reported' | 'inferred' | 'unresolved';

export type SourceKind = 'bruno_statement' | 'bruno_correction' | 'official_record' | 'imported_conversation' | 'document' | 'message' | 'inference';

export interface MemorySource {
  kind: SourceKind;
  ref: string; // e.g. import id + message id, document id, message id
  excerpt: string;
  /** Who asserted this. Only Bruno (or official records) can set preferences/instructions. */
  assertedBy: string;
}

export interface MemoryEntry {
  id: string;
  ownerId: string;
  kind: MemoryKind;
  space: Space;
  contactId?: string;
  /** Structured key for facts, e.g. 'bruno.legal_name', 'travel.2026-11.lisbon'. */
  key?: string;
  value: string;
  source: MemorySource;
  createdAt: Date;
  effectiveFrom: Date;
  effectiveUntil?: Date;
  lastVerifiedAt?: Date;
  confidence: ConfidenceClass;
  sensitivity: Sensitivity;
  retention: 'indefinite' | '90d' | '1y' | 'until_expiry';
  supersededBy?: string;
  supersedes?: string;
  status: 'active' | 'pending_review' | 'superseded' | 'expired';
  fingerprint: string;
}

export interface ReviewItem {
  id: string;
  kind: 'conflict' | 'import_approval';
  entryIds: string[];
  message: string;
  resolvedAt?: Date;
}

export interface RetrievalQuery {
  ownerId: string;
  text: string;
  spaces: Space[];
  contactId?: string;
  maxSensitivity: Sensitivity;
  kinds?: MemoryKind[];
  limit?: number;
}

export interface RetrievedMemory {
  entry: MemoryEntry;
  score: number;
  /** Stale facts are never presented as verified current facts (spec §10). */
  freshness: 'current' | 'stale' | 'unresolved';
  sourceRef: string;
}

const STALE_AFTER_MS: Partial<Record<MemoryKind, number>> = {
  working_state: 2 * 24 * 3600_000,
  contact_context: 180 * 24 * 3600_000,
  profile_fact: 365 * 24 * 3600_000,
};

export function fingerprintOf(ownerId: string, key: string | undefined, value: string): string {
  return sha256(`${ownerId}|${key ?? ''}|${value.trim().toLowerCase().replace(/\s+/g, ' ')}`);
}

/**
 * Persistent personal memory: structured entries plus vector retrieval, where
 * permission filters run BEFORE similarity ranking. Deletion removes the
 * embedding and records a ledger entry that blocks reinsertion from imports.
 */
export class MemoryStore {
  private entries = new Map<string, MemoryEntry>();
  private vectors = new Map<string, number[]>();
  private deletionLedger = new Map<string, { deletedAt: Date; sourceRef: string }>();
  private reviews = new Map<string, ReviewItem>();

  constructor(
    private clock: Clock,
    private embedder: Embedder = new HashingEmbedder(),
  ) {}

  add(input: Omit<MemoryEntry, 'id' | 'createdAt' | 'status' | 'fingerprint' | 'effectiveFrom'> & { effectiveFrom?: Date; status?: MemoryEntry['status'] }): MemoryEntry {
    if (containsAuthenticationCode(input.value) || containsAuthenticationCode(input.source.excerpt))
      throw new JenniferError('memory.auth_code', 'Authentication codes are never stored in memory');
    if ((input.kind === 'preference' || input.kind === 'instruction') && input.source.assertedBy !== input.ownerId)
      throw new JenniferError('memory.untrusted_instruction', 'Only the owner can set preferences or instructions; incoming messages cannot rewrite them');

    const fingerprint = fingerprintOf(input.ownerId, input.key, input.value);
    if (this.deletionLedger.has(fingerprint)) throw new JenniferError('memory.deleted', 'This memory was deleted and cannot be reinserted from an old source');

    const now = this.clock.now();
    const entry: MemoryEntry = { ...input, id: newId('mem'), createdAt: now, effectiveFrom: input.effectiveFrom ?? now, status: input.status ?? 'active', fingerprint };

    // Conflicts: a different value for the same key never silently erases the old one.
    if (entry.key && entry.status === 'active') {
      const current = this.active(entry.ownerId).filter((e) => e.key === entry.key && e.value !== entry.value);
      for (const old of current) {
        const isCorrection = entry.source.kind === 'bruno_correction';
        const oldIsOfficial = old.source.kind === 'official_record';
        if (isCorrection && !oldIsOfficial) {
          old.status = 'superseded';
          old.supersededBy = entry.id;
          entry.supersedes = old.id;
        } else {
          old.confidence = 'unresolved';
          entry.confidence = 'unresolved';
          this.openReview('conflict', [old.id, entry.id], `Conflicting values for ${entry.key}: "${old.value}" vs "${entry.value}"`);
        }
      }
    }
    this.entries.set(entry.id, entry);
    if (entry.status !== 'pending_review') this.vectors.set(entry.id, this.embedder.embed(`${entry.key ?? ''} ${entry.value}`));
    return entry;
  }

  get(id: string): MemoryEntry {
    const e = this.entries.get(id);
    if (!e) throw new JenniferError('memory.not_found', `No memory ${id}`);
    return e;
  }

  /** "Why do you think this?" → the source and evidence (spec §10 DoD). */
  why(id: string): { value: string; source: MemorySource; confidence: ConfidenceClass; lastVerifiedAt?: Date; createdAt: Date } {
    const e = this.get(id);
    return { value: e.value, source: e.source, confidence: e.confidence, lastVerifiedAt: e.lastVerifiedAt, createdAt: e.createdAt };
  }

  activate(id: string): MemoryEntry {
    const e = this.get(id);
    if (e.status === 'pending_review') {
      e.status = 'active';
      this.vectors.set(e.id, this.embedder.embed(`${e.key ?? ''} ${e.value}`));
    }
    return e;
  }

  correct(id: string, ownerId: string, newValue: string, excerpt: string): MemoryEntry {
    const old = this.get(id);
    return this.add({
      ownerId,
      kind: old.kind,
      space: old.space,
      contactId: old.contactId,
      key: old.key ?? `memory.${old.id}`,
      value: newValue,
      source: { kind: 'bruno_correction', ref: `correction:${old.id}`, excerpt, assertedBy: ownerId },
      confidence: 'confirmed',
      sensitivity: old.sensitivity,
      retention: old.retention,
      lastVerifiedAt: this.clock.now(),
      effectiveUntil: old.effectiveUntil,
    });
  }

  verify(id: string): void {
    const e = this.get(id);
    e.lastVerifiedAt = this.clock.now();
    if (e.confidence !== 'unresolved') e.confidence = 'confirmed';
  }

  /** Delete: entry, embedding, and a ledger fingerprint so old imports cannot reinsert it. */
  delete(id: string, actor: string): void {
    const e = this.get(id);
    if (actor !== e.ownerId) throw new JenniferError('memory.not_owner', 'Only the owner can delete memory');
    this.deletionLedger.set(e.fingerprint, { deletedAt: this.clock.now(), sourceRef: e.source.ref });
    this.entries.delete(id);
    this.vectors.delete(id);
  }

  isDeleted(ownerId: string, key: string | undefined, value: string): boolean {
    return this.deletionLedger.has(fingerprintOf(ownerId, key, value));
  }

  hasVector(id: string): boolean {
    return this.vectors.has(id);
  }

  retrieve(q: RetrievalQuery): RetrievedMemory[] {
    const now = this.clock.now().getTime();
    // 1) Permission and scope filtering first.
    const allowed = this.active(q.ownerId).filter(
      (e) =>
        q.spaces.includes(e.space) &&
        sensitivityAllowed(e.sensitivity, q.maxSensitivity) &&
        (!q.kinds || q.kinds.includes(e.kind)) &&
        (!e.contactId || !q.contactId || e.contactId === q.contactId) &&
        (!e.effectiveUntil || e.effectiveUntil.getTime() > now) &&
        e.effectiveFrom.getTime() <= now,
    );
    // 2) Then similarity ranking.
    const qv = this.embedder.embed(q.text);
    return allowed
      .map((entry) => {
        const v = this.vectors.get(entry.id);
        const score = v ? cosine(qv, v) : 0;
        const staleAfter = STALE_AFTER_MS[entry.kind];
        const verifiedAt = (entry.lastVerifiedAt ?? entry.createdAt).getTime();
        const freshness: RetrievedMemory['freshness'] =
          entry.confidence === 'unresolved' ? 'unresolved' : staleAfter && now - verifiedAt > staleAfter ? 'stale' : 'current';
        return { entry, score, freshness, sourceRef: entry.source.ref };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit ?? 8);
  }

  /** Expire temporary state (availability, travel plans, temporary preferences). */
  expireDue(): string[] {
    const now = this.clock.now().getTime();
    const expired: string[] = [];
    for (const e of this.entries.values()) {
      if (e.status === 'active' && e.effectiveUntil && e.effectiveUntil.getTime() <= now) {
        e.status = 'expired';
        expired.push(e.id);
      }
    }
    return expired;
  }

  active(ownerId: string): MemoryEntry[] {
    return [...this.entries.values()].filter((e) => e.ownerId === ownerId && e.status === 'active');
  }

  all(ownerId: string): MemoryEntry[] {
    return [...this.entries.values()].filter((e) => e.ownerId === ownerId);
  }

  export(ownerId: string): MemoryEntry[] {
    return this.all(ownerId).map((e) => ({ ...e }));
  }

  openReviews(): ReviewItem[] {
    return [...this.reviews.values()].filter((r) => !r.resolvedAt);
  }

  resolveReview(reviewId: string, keepEntryId: string, actor: string): void {
    const r = this.reviews.get(reviewId);
    if (!r) throw new JenniferError('memory.review_not_found', reviewId);
    for (const id of r.entryIds) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (id === keepEntryId) {
        e.confidence = 'confirmed';
        e.lastVerifiedAt = this.clock.now();
      } else {
        e.status = 'superseded';
        e.supersededBy = keepEntryId;
      }
    }
    r.resolvedAt = this.clock.now();
    void actor;
  }

  private openReview(kind: ReviewItem['kind'], entryIds: string[], message: string): void {
    const r: ReviewItem = { id: newId('rev'), kind, entryIds, message };
    this.reviews.set(r.id, r);
  }
}
