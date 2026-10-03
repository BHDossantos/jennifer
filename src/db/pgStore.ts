import type { Db } from './db.js';
import type { EventEnvelope, EventLog, NewEvent } from '../events/events.js';
import type { AuditEvent } from '../audit/audit.js';
import type { ActionIntent, Approval } from '../actions/model.js';
import type { ActionDurability } from '../actions/service.js';
import type { AuthorityRule } from '../policy/authority.js';
import type { Contact } from '../contacts/contacts.js';
import { type Clock, newId } from '../core/util.js';

export async function ensureOwner(db: Db, ownerId: string, displayName = ownerId): Promise<void> {
  await db.query(`INSERT INTO app_user (id, display_name, role) VALUES ($1, $2, 'owner') ON CONFLICT (id) DO NOTHING`, [ownerId, displayName]);
}

/**
 * Postgres event log. The unique (account_id, provider_event_id) constraint
 * is the dedup authority, so a redelivered webhook stays a duplicate even
 * after a restart or across several API instances.
 */
export class PgEventLog implements EventLog {
  constructor(
    private db: Db,
    private clock: Clock,
  ) {}

  async ingest(input: NewEvent): Promise<{ event: EventEnvelope; duplicate: boolean }> {
    const id = newId('evt');
    const traceId = input.traceId ?? newId('trace');
    const inserted = await this.db.query<Row>(
      `INSERT INTO event (id, provider_event_id, owner_id, account_id, channel, kind, conversation_id, sender, occurred_at, received_at, payload_ref, language, space, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (account_id, provider_event_id) DO NOTHING
       RETURNING *`,
      [id, input.providerEventId, input.ownerId, input.accountId, input.channel, input.kind, input.conversationId ?? null, input.sender ? JSON.stringify(input.sender) : null, input.occurredAt, this.clock.now(), input.payloadRef, input.language ?? null, input.space ?? null, traceId],
    );
    if (inserted.rows[0]) return { event: toEnvelope(inserted.rows[0]), duplicate: false };
    const existing = await this.db.query<Row>('SELECT * FROM event WHERE account_id = $1 AND provider_event_id = $2', [input.accountId, input.providerEventId]);
    return { event: toEnvelope(existing.rows[0]!), duplicate: true };
  }

  /** Lease-based claim: safe with several workers (SKIP LOCKED). */
  async claim(max = 50): Promise<EventEnvelope[]> {
    const rows = await this.db.query<Row>(
      `UPDATE event SET lease_until = now() + interval '5 minutes', attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM event
         WHERE processed_at IS NULL AND (lease_until IS NULL OR lease_until < now())
         ORDER BY received_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [max],
    );
    return rows.rows.map(toEnvelope);
  }

  async markProcessed(eventId: string): Promise<void> {
    await this.db.query('UPDATE event SET processed_at = now(), lease_until = NULL WHERE id = $1', [eventId]);
  }

  async requeue(eventId: string): Promise<void> {
    await this.db.query('UPDATE event SET lease_until = NULL WHERE id = $1 AND processed_at IS NULL', [eventId]);
  }

  async unprocessedCount(): Promise<number> {
    const r = await this.db.query<{ n: string }>('SELECT count(*)::text AS n FROM event WHERE processed_at IS NULL');
    return Number(r.rows[0]?.n ?? 0);
  }
}

type Row = Record<string, any>;

/** Enum arrays come back as '{a,b}' strings from drivers without a registered parser. */
function pgArray(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  return [];
}

function toEnvelope(r: Row): EventEnvelope {
  return {
    eventId: r.id,
    providerEventId: r.provider_event_id,
    ownerId: r.owner_id,
    accountId: r.account_id,
    channel: r.channel,
    kind: r.kind,
    conversationId: r.conversation_id ?? undefined,
    sender: r.sender ?? undefined,
    occurredAt: new Date(r.occurred_at),
    receivedAt: new Date(r.received_at),
    payloadRef: r.payload_ref,
    language: r.language ?? undefined,
    space: r.space ?? undefined,
    traceId: r.trace_id,
  };
}

/**
 * Serial write-behind queue for state that the in-memory domain objects own.
 * flush() is awaited at the points where durability matters (before a send).
 */
class WriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private failed?: Error;

  push(fn: () => Promise<void>): void {
    this.tail = this.tail.then(fn).catch((e: Error) => {
      this.failed = e;
    });
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.failed) {
      const e = this.failed;
      this.failed = undefined;
      throw e;
    }
  }
}

/** Persists audit events, authority rules, contacts, action intents and approvals. */
export class PgStateStore implements ActionDurability {
  private q = new WriteQueue();

  constructor(
    private db: Db,
    private ownerId: string,
  ) {}

  flush(): Promise<void> {
    return this.q.flush();
  }

  audit(ev: AuditEvent): void {
    this.q.push(async () => {
      await this.db.query('INSERT INTO audit_event (id, at, owner_id, actor, kind, subject_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING', [
        ev.id,
        ev.at,
        this.ownerId,
        ev.actor,
        ev.kind,
        ev.subjectId ?? null,
        JSON.stringify(ev.detail),
      ]);
    });
  }

  rule(r: AuthorityRule): void {
    this.q.push(async () => {
      await this.db.query(
        `INSERT INTO authority_rule (id, owner_id, principal, action, mode, scope, limits, attachments, expires_at, policy_version, revoked_at, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, scope = EXCLUDED.scope, limits = EXCLUDED.limits, attachments = EXCLUDED.attachments,
           expires_at = EXCLUDED.expires_at, policy_version = EXCLUDED.policy_version, revoked_at = EXCLUDED.revoked_at`,
        [r.id, this.ownerId, r.principal, r.action, r.mode, JSON.stringify(r.scope), JSON.stringify(r.limits), JSON.stringify(r.attachments), r.expiresAt ?? null, r.policyVersion, r.revokedAt ?? null, r.note ?? null],
      );
    });
  }

  contact(c: Contact): void {
    this.q.push(async () => {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO contact (id, owner_id, display_name, spaces, relationship, instructions) VALUES ($1,$2,$3,$4::text[]::space[],$5,$6)
           ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, spaces = EXCLUDED.spaces, relationship = EXCLUDED.relationship, instructions = EXCLUDED.instructions`,
          [c.id, c.ownerId, c.displayName, c.spaces, c.relationship ?? null, c.instructions ?? null],
        );
        await tx.query('DELETE FROM contact_identity WHERE contact_id = $1', [c.id]);
        for (const i of c.identities)
          await tx.query('INSERT INTO contact_identity (contact_id, owner_id, kind, value, verified, source) VALUES ($1,$2,$3,$4,$5,$6)', [c.id, c.ownerId, i.kind, i.value, i.verified, i.source]);
      });
    });
  }

  /** ActionDurability: the intent row is the outbox record. */
  record(i: ActionIntent, approval?: Approval): void {
    const snapshot = structuredClone(i);
    const last = snapshot.history.at(-1);
    this.q.push(async () => {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO action_intent (id, owner_id, type, space, channel, connector_id, account_id, conversation_id, based_on_conversation_revision, workflow_id,
             payload, revision, payload_hash, idempotency_key, state, state_reason, policy_version, authority_rule_id, approval_id, attempts, next_attempt_at,
             expires_at, proposed_by, created_at, decision_reasons, receipt)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
           ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, revision = EXCLUDED.revision, payload_hash = EXCLUDED.payload_hash, state = EXCLUDED.state,
             state_reason = EXCLUDED.state_reason, policy_version = EXCLUDED.policy_version, authority_rule_id = EXCLUDED.authority_rule_id,
             approval_id = EXCLUDED.approval_id, attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at,
             decision_reasons = EXCLUDED.decision_reasons, receipt = EXCLUDED.receipt`,
          [
            snapshot.id, snapshot.ownerId, snapshot.type, snapshot.space, snapshot.channel, snapshot.connectorId, snapshot.accountId, snapshot.conversationId ?? null,
            snapshot.basedOnConversationRevision ?? null, snapshot.workflowId ?? null, JSON.stringify(snapshot.payload), snapshot.revision, snapshot.payloadHash,
            snapshot.idempotencyKey, snapshot.state, snapshot.stateReason ?? null, snapshot.policyVersion ?? null, snapshot.authorityRuleId ?? null,
            snapshot.approvalId ?? null, snapshot.attempts, snapshot.nextAttemptAt ?? null, snapshot.expiresAt ?? null, snapshot.proposedBy, snapshot.createdAt,
            snapshot.decisionReasons, snapshot.receipt ? JSON.stringify(snapshot.receipt) : null,
          ],
        );
        if (last) await tx.query('INSERT INTO action_transition (action_id, at, from_state, to_state, reason, actor) VALUES ($1,$2,$3,$4,$5,$6)', [snapshot.id, last.at, last.from, last.to, last.reason ?? null, last.actor]);
        if (approval)
          await tx.query(
            `INSERT INTO approval (id, action_id, revision, payload_hash, approved_by, approved_at, expires_at, step_up_verified, consumed_at, invalidated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET consumed_at = EXCLUDED.consumed_at, invalidated_at = EXCLUDED.invalidated_at`,
            [approval.id, approval.intentId, approval.revision, approval.payloadHash, approval.approvedBy, approval.approvedAt, approval.expiresAt, approval.stepUpVerified, approval.consumedAt ?? null, approval.invalidatedAt ?? null],
          );
      });
    });
  }

  // ---- Rehydration ---------------------------------------------------------

  async loadRules(): Promise<AuthorityRule[]> {
    const r = await this.db.query<Row>('SELECT * FROM authority_rule WHERE owner_id = $1 ORDER BY policy_version', [this.ownerId]);
    return r.rows.map((x) => ({
      id: x.id,
      principal: x.principal,
      action: x.action,
      mode: x.mode,
      scope: x.scope,
      limits: x.limits,
      attachments: x.attachments,
      expiresAt: x.expires_at ? new Date(x.expires_at) : undefined,
      policyVersion: x.policy_version,
      revokedAt: x.revoked_at ? new Date(x.revoked_at) : undefined,
      note: x.note ?? undefined,
    }));
  }

  async loadContacts(): Promise<Contact[]> {
    const cs = await this.db.query<Row>('SELECT * FROM contact WHERE owner_id = $1', [this.ownerId]);
    const ids = await this.db.query<Row>('SELECT * FROM contact_identity WHERE owner_id = $1', [this.ownerId]);
    return cs.rows.map((c) => ({
      id: c.id,
      ownerId: c.owner_id,
      displayName: c.display_name,
      spaces: pgArray(c.spaces),
      relationship: c.relationship ?? undefined,
      instructions: c.instructions ?? undefined,
      identities: ids.rows.filter((i) => i.contact_id === c.id).map((i) => ({ kind: i.kind, value: i.value, verified: i.verified, source: i.source })),
    }));
  }

  async loadActions(): Promise<{ intents: ActionIntent[]; approvals: Approval[] }> {
    const a = await this.db.query<Row>('SELECT * FROM action_intent WHERE owner_id = $1 ORDER BY created_at', [this.ownerId]);
    const t = await this.db.query<Row>('SELECT t.* FROM action_transition t JOIN action_intent a ON a.id = t.action_id WHERE a.owner_id = $1 ORDER BY t.at', [this.ownerId]);
    const p = await this.db.query<Row>('SELECT p.* FROM approval p JOIN action_intent a ON a.id = p.action_id WHERE a.owner_id = $1', [this.ownerId]);
    const intents: ActionIntent[] = a.rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      type: r.type,
      space: r.space,
      channel: r.channel,
      connectorId: r.connector_id,
      accountId: r.account_id,
      conversationId: r.conversation_id ?? undefined,
      basedOnConversationRevision: r.based_on_conversation_revision ?? undefined,
      workflowId: r.workflow_id ?? undefined,
      payload: r.payload,
      revision: r.revision,
      payloadHash: r.payload_hash,
      idempotencyKey: r.idempotency_key,
      state: r.state,
      stateReason: r.state_reason ?? undefined,
      proposedBy: r.proposed_by,
      createdAt: new Date(r.created_at),
      expiresAt: r.expires_at ? new Date(r.expires_at) : undefined,
      policyVersion: r.policy_version ?? undefined,
      authorityRuleId: r.authority_rule_id ?? undefined,
      approvalId: r.approval_id ?? undefined,
      decisionReasons: r.decision_reasons ?? [],
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
      receipt: r.receipt ? { ...r.receipt, observedAt: new Date(r.receipt.observedAt) } : undefined,
      history: t.rows.filter((x) => x.action_id === r.id).map((x) => ({ at: new Date(x.at), from: x.from_state, to: x.to_state, reason: x.reason ?? undefined, actor: x.actor })),
    }));
    const approvals: Approval[] = p.rows.map((r) => ({
      id: r.id,
      intentId: r.action_id,
      revision: r.revision,
      payloadHash: r.payload_hash,
      approvedBy: r.approved_by,
      approvedAt: new Date(r.approved_at),
      expiresAt: new Date(r.expires_at),
      stepUpVerified: r.step_up_verified,
      consumedAt: r.consumed_at ? new Date(r.consumed_at) : undefined,
      invalidatedAt: r.invalidated_at ? new Date(r.invalidated_at) : undefined,
    }));
    return { intents, approvals };
  }
}
