import { type Clock, newId } from '../core/util.js';
import { redactSecrets } from '../security/redaction.js';

export interface AuditEvent {
  id: string;
  at: Date;
  actor: string; // 'bruno', 'jennifer', 'system', 'connector:<id>', 'developer:<id>'
  kind: string;
  subjectId?: string;
  detail: Record<string, unknown>;
}

/**
 * Append-only audit log. Details pass through the secrets redaction filter so
 * tokens or authentication codes never persist here (spec §4).
 */
export class AuditLog {
  private events: AuditEvent[] = [];
  constructor(private clock: Clock) {}

  record(actor: string, kind: string, subjectId: string | undefined, detail: Record<string, unknown> = {}): AuditEvent {
    const safe = JSON.parse(redactSecrets(JSON.stringify(detail))) as Record<string, unknown>;
    const ev: AuditEvent = { id: newId('aud'), at: this.clock.now(), actor, kind, subjectId, detail: safe };
    this.events.push(ev);
    return ev;
  }

  list(filter: { subjectId?: string; kind?: string } = {}): AuditEvent[] {
    return this.events.filter(
      (e) => (!filter.subjectId || e.subjectId === filter.subjectId) && (!filter.kind || e.kind === filter.kind),
    );
  }
}
